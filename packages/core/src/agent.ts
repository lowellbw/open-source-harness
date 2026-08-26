import { streamText, stepCountIs, type ToolSet } from 'ai'
import { randomUUID } from 'node:crypto'
import type { Message, WorkspaceEvent } from '@workspace/protocol'
import {
  ModelGateway,
  prepareForProvider,
  isSwitchSafe,
  BudgetExceededError,
} from '@workspace/gateway-model'
import { condense, defaultCondenserOptions } from './condenser.js'
import { PolicyPin, type OrgPolicy } from './pinning.js'
import { fromModelMessages, toInstructions, toModelMessages } from './adapter.js'

/**
 * The agent loop.
 *
 * Thin by design (ADR-0001). The SDK owns the loop mechanics — streaming, tool
 * dispatch, step control — and everything that carries a product requirement is
 * ours and lives in `prepareStep`:
 *
 *   - the budget ceiling is checked before every step;
 *   - history is compacted by our condenser;
 *   - the pinned policy is rebuilt from source and passed as `instructions`,
 *     which is structurally outside the message array compaction edits;
 *   - reasoning artifacts are filtered for the destination vendor.
 *
 * `prepareStep` runs before every model request, so none of these can be
 * skipped by a long conversation or an unusual tool sequence.
 */

export interface AgentConfig {
  gateway: ModelGateway
  policy: OrgPolicy
  /** Alias from the catalog, not a provider model ID. */
  modelAlias: string
  role: string
  /** Context budget that triggers compaction. */
  contextMaxTokens?: number
  maxSteps?: number
  tools?: ToolSet
  onEvent?: (event: WorkspaceEvent) => void
  persistToolOutput?: (toolCallId: string, output: unknown) => Promise<string>
  summarise?: (messages: Message[]) => Promise<string>
}

export interface TurnResult {
  text: string
  runId: string
  stoppedBy: 'complete' | 'budget_exceeded' | 'error'
  error?: Error
}

export class Agent {
  private readonly pin: PolicyPin
  private history: Message[] = []
  private threadId = randomUUID()
  private currentAlias: string

  constructor(private readonly config: AgentConfig) {
    this.pin = new PolicyPin(config.policy)
    this.currentAlias = config.modelAlias
  }

  getHistory(): Message[] {
    return this.history
  }

  /**
   * Switches the model for subsequent turns.
   *
   * Refused mid-conversation unless at a compaction boundary: prior reasoning
   * artifacts are still in history and the cache miss is not yet sunk (§6.5).
   */
  switchModel(alias: string, options: { atCompactionBoundary?: boolean } = {}): void {
    const from = this.config.gateway.catalog.get(this.currentAlias)
    const to = this.config.gateway.catalog.get(alias)

    const verdict = isSwitchSafe({
      fromProvider: vendorOfModel(from.upstreamModel),
      toProvider: vendorOfModel(to.upstreamModel),
      atCompactionBoundary: options.atCompactionBoundary ?? false,
    })
    if (!verdict.safe) throw new Error(verdict.reason)

    const previous = this.currentAlias
    this.currentAlias = alias
    this.emit({
      type: 'model.switched',
      runId: this.threadId,
      ts: Date.now(),
      from: previous,
      to: alias,
      atCompactionBoundary: options.atCompactionBoundary ?? false,
    })
  }

  async send(userText: string): Promise<TurnResult> {
    const runId = randomUUID()
    this.config.gateway.startRun()

    this.history.push({
      id: randomUUID(),
      role: 'user',
      pinned: false,
      parts: [{ type: 'text', text: userText }],
    })

    this.emit({ type: 'run.started', runId, ts: Date.now(), threadId: this.threadId })
    this.emit({ type: 'status', runId, ts: Date.now(), state: 'thinking' })

    const messageId = randomUUID()
    let text = ''

    try {
      // Inside the try: resolve() enforces the budget ceiling and role gating,
      // and both must surface as a returned result rather than a thrown error.
      // A caller asking the agent to do something should always get a verdict.
      const resolved = this.config.gateway.resolve(this.currentAlias, this.config.role)

      const result = streamText({
        model: resolved.model,
        tools: this.config.tools ?? {},
        stopWhen: stepCountIs(this.config.maxSteps ?? 12),
        instructions: toInstructions(this.pin.messages()),
        messages: toModelMessages(this.history),

        prepareStep: async ({ messages }) => {
          // Ceiling first: refusing the next call is what bounds spend, since a
          // request's cost is unknowable until it returns.
          this.config.gateway.budget.assertCanProceed()

          // Transform what the SDK is about to send, rather than substituting
          // our own record of the conversation. Mid-loop its array already
          // holds this turn's tool calls and results; replacing it would drop
          // them and the agent would re-request a tool it had already run.
          const outbound = fromModelMessages(messages)

          const condensed = await condense(outbound, {
            ...defaultCondenserOptions,
            maxTokens: this.config.contextMaxTokens ?? 100_000,
            ...(this.config.persistToolOutput
              ? { persistToolOutput: this.config.persistToolOutput }
              : {}),
            ...(this.config.summarise ? { summarise: this.config.summarise } : {}),
          })

          if (condensed.compacted) {
            this.emit({
              type: 'context.compacted',
              runId,
              ts: Date.now(),
              strategy: condensed.strategy,
              beforeMessages: condensed.before.messages,
              afterMessages: condensed.after.messages,
              beforeTokens: condensed.before.tokens,
              afterTokens: condensed.after.tokens,
            })
          }

          const forProvider = prepareForProvider(condensed.messages, resolved.vendor)

          return {
            // Rebuilt from source every step. History never holds the only
            // copy, so no compaction pass can lose it.
            instructions: toInstructions(
              this.pin.messages({
                budgetRemainingUsd: this.config.gateway.budget.remaining().runUsd,
              }),
            ),
            messages: toModelMessages(forProvider.messages),
          }
        },
      })

      this.emit({ type: 'message.started', runId, ts: Date.now(), messageId })

      for await (const part of result.fullStream) {
        if (part.type === 'text-start') {
          // A multi-step turn produces one text block per step. Without a
          // separator they concatenate mid-sentence ("...emptiness.I listed
          // the workspace..."), which reads as a rendering bug.
          if (text.length > 0 && !text.endsWith('\n\n')) {
            const gap = text.endsWith('\n') ? '\n' : '\n\n'
            text += gap
            this.emit({ type: 'message.delta', runId, ts: Date.now(), messageId, delta: gap })
          }
        } else if (part.type === 'text-delta') {
          text += part.text
          this.emit({ type: 'message.delta', runId, ts: Date.now(), messageId, delta: part.text })
        } else if (part.type === 'reasoning-delta') {
          this.emit({ type: 'reasoning.delta', runId, ts: Date.now(), messageId, delta: part.text })
        } else if (part.type === 'tool-call') {
          this.emit({
            type: 'tool.call.started',
            runId,
            ts: Date.now(),
            toolCallId: part.toolCallId,
            name: part.toolName,
            args: part.input,
          })
        } else if (part.type === 'tool-result') {
          this.emit({
            type: 'tool.call.finished',
            runId,
            ts: Date.now(),
            toolCallId: part.toolCallId,
            result: part.output,
            isError: false,
          })
        }
      }

      this.emit({ type: 'message.finished', runId, ts: Date.now(), messageId })

      const usage = await result.usage
      const cost = this.config.gateway.recordUsage(this.currentAlias, usage)
      const totals = this.config.gateway.totals()
      this.emit({ type: 'cost.updated', runId, ts: Date.now(), run: totals.run, session: totals.session })

      this.history.push({
        id: messageId,
        role: 'assistant',
        pinned: false,
        parts: [{ type: 'text', text }],
      })

      this.emit({ type: 'run.finished', runId, ts: Date.now(), reason: 'complete' })
      this.emit({ type: 'status', runId, ts: Date.now(), state: 'idle' })
      void cost

      return { text, runId, stoppedBy: 'complete' }
    } catch (error) {
      const reason = error instanceof BudgetExceededError ? 'budget_exceeded' : 'error'
      this.emit({
        type: 'run.error',
        runId,
        ts: Date.now(),
        message: error instanceof Error ? error.message : String(error),
      })
      this.emit({ type: 'run.finished', runId, ts: Date.now(), reason })
      this.emit({ type: 'status', runId, ts: Date.now(), state: 'idle' })

      return {
        text,
        runId,
        stoppedBy: reason === 'budget_exceeded' ? 'budget_exceeded' : 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }

  private emit(event: WorkspaceEvent): void {
    this.config.onEvent?.(event)
  }
}

function vendorOfModel(upstreamModel: string): string {
  return upstreamModel.includes('/') ? upstreamModel.split('/')[0]! : upstreamModel
}
