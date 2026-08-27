import { streamText, stepCountIs, type ToolSet } from 'ai'
import { randomUUID } from 'node:crypto'
import type { Message, WorkspaceEvent } from '@workspace/protocol'
import {
  ModelGateway,
  prepareForProvider,
  isSwitchSafe,
  serverWebSearches,
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
  /**
   * Tools available to the agent.
   *
   * Accepts a function so the set can change between turns — an MCP tool
   * approved mid-session has to become registered without rebuilding the agent.
   * A fixed object captured at construction silently strands newly approved
   * tools: `activeTools` names them, but they are not registered, and the turn
   * produces nothing at all.
   */
  tools?: ToolSet | (() => ToolSet)
  /**
   * Which tools are sent to the model on this step.
   *
   * Evaluated per step, which is what makes deferred tool loading work: every
   * connected tool stays registered, but only the ones the model has actually
   * asked for reach the prompt. Return undefined to send all of them.
   */
  activeTools?: () => string[] | undefined
  /**
   * How hard the model should think, where it accepts the instruction.
   *
   * Sent only when the catalog entry says the model honours it — passing a
   * knob a model ignores is how a UI control comes to mean nothing.
   */
  reasoningEffort?: ReasoningEffort
  onEvent?: (event: WorkspaceEvent) => void
  persistToolOutput?: (toolCallId: string, output: unknown) => Promise<string>
  summarise?: (messages: Message[]) => Promise<string>
  /**
   * History to resume from, in order.
   *
   * The agent is deliberately not the thing that loads it. Reading from a store
   * here would make the core depend on persistence, and the two shells disagree
   * about where the database lives; the session layer knows and passes it in.
   */
  initialHistory?: Message[]
  /**
   * Fired as each message joins history, not in a batch at the end of the turn.
   *
   * Batching would lose the user's question if the process died mid-call, which
   * is the moment a conversation is most worth keeping: whatever was asked that
   * made it crash.
   */
  onMessage?: (message: Message) => void
}

export type ReasoningEffort = 'low' | 'medium' | 'high'

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
  private effort: ReasoningEffort | undefined

  constructor(private readonly config: AgentConfig) {
    this.pin = new PolicyPin(config.policy)
    this.currentAlias = config.modelAlias
    this.effort = config.reasoningEffort
    // Copied, not aliased: the caller's array is usually the store's return
    // value, and appending to it as a side effect of running a turn is the kind
    // of shared-mutable-state bug that only shows up under a second session.
    if (config.initialHistory) this.history = [...config.initialHistory]
  }

  getHistory(): Message[] {
    return this.history
  }

  /** Changes thinking effort for subsequent turns. */
  setReasoningEffort(effort: ReasoningEffort | undefined): void {
    this.effort = effort
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

    const userMessage: Message = {
      id: randomUUID(),
      role: 'user',
      pinned: false,
      parts: [{ type: 'text', text: userText }],
    }
    this.history.push(userMessage)
    this.config.onMessage?.(userMessage)

    this.emit({ type: 'run.started', runId, ts: Date.now(), threadId: this.threadId })
    this.emit({ type: 'status', runId, ts: Date.now(), state: 'thinking' })

    const messageId = randomUUID()
    let text = ''

    /**
     * The real error, kept from the stream.
     *
     * When `prepareStep` throws — which is where the budget ceiling is
     * enforced — the SDK surfaces the original error as an `error` part and
     * then rejects `result.usage` with a generic `NoOutputGeneratedError` that
     * carries no `cause` chain back to it. Classifying on what the `await`
     * throws therefore reports every mid-turn budget stop as a plain failure:
     * the user is told something went wrong rather than that they hit their
     * spend limit. Verified against the SDK, not assumed.
     *
     * Declared out here rather than in the try, because the catch is the only
     * place it is read.
     */
    let streamError: unknown

    try {
      // Inside the try: resolve() enforces the budget ceiling and role gating,
      // and both must surface as a returned result rather than a thrown error.
      // A caller asking the agent to do something should always get a verdict.
      const resolved = this.config.gateway.resolve(this.currentAlias, this.config.role)

      // Provider-run tools ride along with our own, but they behave nothing
      // like them: there is no `execute`, and — verified against a live
      // response — no `tool-call` part in the stream either. The entire search
      // happens inside the provider's request. What comes back is `source`
      // parts, emitted below, and a count in the raw usage, which is where the
      // meter reads it.
      const providerToolNames = Object.keys(resolved.providerTools)
      let webSearches = 0
      let stepNumber = 0
      let toolCallsThisStep = 0

      const result = streamText({
        model: resolved.model,
        tools: { ...resolveTools(this.config.tools), ...resolved.providerTools },
        stopWhen: stepCountIs(this.config.maxSteps ?? 12),
        instructions: toInstructions(this.pin.messages()),
        messages: toModelMessages(this.history),

        // Only where the model actually honours it. `supportsReasoningEffort`
        // comes from the provider's own parameter list, not from a guess.
        ...(this.effort && resolved.entry.supportsReasoningEffort
          ? { providerOptions: { openrouter: { reasoning: { effort: this.effort } } } }
          : {}),

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

          // Provider tools are appended unconditionally: deferred loading exists
          // to keep dozens of MCP schemas out of the prompt, and dropping the
          // provider's own search along with them would silently disable it the
          // moment a connector is configured.
          const active = this.config.activeTools?.()

          this.emit({
            type: 'step.started',
            runId,
            ts: Date.now(),
            stepNumber,
            ...(active ? { activeTools: [...active, ...providerToolNames] } : {}),
          })

          return {
            // Rebuilt from source every step. History never holds the only
            // copy, so no compaction pass can lose it.
            instructions: toInstructions(
              this.pin.messages({
                budgetRemainingUsd: this.config.gateway.budget.remaining().runUsd,
              }),
            ),
            messages: toModelMessages(forProvider.messages),
            ...(active ? { activeTools: [...active, ...providerToolNames] as never } : {}),
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
        } else if (part.type === 'error') {
          streamError = part.error
        } else if (part.type === 'finish-step') {
          // Summed per step rather than read from the final total: the raw
          // provider payload the count lives in does not survive aggregation.
          const searchesThisStep = serverWebSearches(part.usage)
          webSearches += searchesThisStep

          // Priced here rather than waiting for the turn to end, so a long
          // multi-step turn shows its cost accruing instead of arriving as one
          // number after the fact.
          const stepCost = this.config.gateway.priceOnly(this.currentAlias, part.usage, {
            webSearches: searchesThisStep,
          })

          const stepTime = (part as { performance?: { stepTimeMs?: number } }).performance
            ?.stepTimeMs

          this.emit({
            type: 'step.finished',
            runId,
            ts: Date.now(),
            stepNumber,
            cost: stepCost,
            toolCalls: toolCallsThisStep,
            ...(typeof stepTime === 'number' ? { durationMs: stepTime } : {}),
            ...(part.finishReason ? { finishReason: part.finishReason } : {}),
          })

          stepNumber += 1
          toolCallsThisStep = 0
        } else if (part.type === 'source') {
          if (part.sourceType === 'url') {
            this.emit({
              type: 'source.cited',
              runId,
              ts: Date.now(),
              messageId,
              url: part.url,
              title: part.title ?? part.url,
            })
          }
        } else if (part.type === 'tool-call') {
          toolCallsThisStep += 1
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
      const cost = this.config.gateway.recordUsage(this.currentAlias, usage, { webSearches })
      const totals = this.config.gateway.totals()
      this.emit({
        type: 'cost.updated',
        runId,
        ts: Date.now(),
        run: totals.run,
        session: totals.session,
        delta: cost,
        model: this.currentAlias,
      })

      const assistantMessage: Message = {
        id: messageId,
        role: 'assistant',
        pinned: false,
        parts: [{ type: 'text', text }],
      }
      this.history.push(assistantMessage)
      this.config.onMessage?.(assistantMessage)

      this.emit({ type: 'run.finished', runId, ts: Date.now(), reason: 'complete' })
      this.emit({ type: 'status', runId, ts: Date.now(), state: 'idle' })

      return { text, runId, stoppedBy: 'complete' }
    } catch (error) {
      // Prefer what the stream reported: it is the original, and the thrown
      // value is often a wrapper that has lost it.
      const cause = streamError ?? error
      const reason = cause instanceof BudgetExceededError ? 'budget_exceeded' : 'error'
      this.emit({
        type: 'run.error',
        runId,
        ts: Date.now(),
        message: cause instanceof Error ? cause.message : String(cause),
      })
      this.emit({ type: 'run.finished', runId, ts: Date.now(), reason })
      this.emit({ type: 'status', runId, ts: Date.now(), state: 'idle' })

      return {
        text,
        runId,
        stoppedBy: reason === 'budget_exceeded' ? 'budget_exceeded' : 'error',
        error: cause instanceof Error ? cause : new Error(String(cause)),
      }
    }
  }

  private emit(event: WorkspaceEvent): void {
    this.config.onEvent?.(event)
  }
}

function resolveTools(tools: AgentConfig['tools']): ToolSet {
  if (!tools) return {}
  return typeof tools === 'function' ? tools() : tools
}

function vendorOfModel(upstreamModel: string): string {
  return upstreamModel.includes('/') ? upstreamModel.split('/')[0]! : upstreamModel
}
