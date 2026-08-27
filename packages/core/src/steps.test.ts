import { describe, expect, it } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { ModelGateway, type ResolvedModel } from '@workspace/gateway-model'
import type { WorkspaceEvent } from '@workspace/protocol'
import { tool } from 'ai'
import { z } from 'zod'
import { Agent } from './agent.js'

/**
 * The step trace.
 *
 * A turn that calls three tools is four model requests. Until these events
 * existed the UI showed that as one undifferentiated wait, and the per-step
 * cost — the thing that explains a surprising bill — was not recoverable at
 * all after the fact.
 *
 * MULTI-STEP IS NOT TESTED HERE, and that is a limitation of the fixture
 * rather than a gap in intent. `MockLanguageModelV4` streaming a well-formed
 * `tool-call` under `stopWhen: stepCountIs(n)` does not advance the loop in
 * ai@7.0.79: `execute` never runs, no `tool-result` appears, and the turn ends
 * after one request with no error. Tried with and without the
 * `tool-input-start/delta/end` preamble, with `stream-start` and
 * `response-metadata`, with a provider-executed tool supplying its own result,
 * and with `simulateReadableStream` from both `ai` and `ai/test`. A real model
 * multi-steps fine, which is where the numbering and per-step cost are
 * asserted — see `packages/session/src/live-steps.test.ts`.
 */

const policy = {
  orgId: 'test',
  userId: 'you',
  role: 'staff',
  scope: ['/'],
  permissions: ['read'],
  constraints: ['Be brief.'],
}

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
}

/** Streams a tool call on the first step and text on the second. */
function twoStepModel() {
  let call = 0
  return new MockLanguageModelV4({
    doStream: async () => {
      const first = call++ === 0
      return {
        stream: simulateReadableStream({
          chunks: first
            ? [
                // The input-streaming parts are not optional decoration: a
                // bare `tool-call` streams through and the tool never
                // executes, so the loop stops after one step with no error.
                { type: 'tool-input-start', id: 'c1', toolName: 'ping' },
                { type: 'tool-input-delta', id: 'c1', delta: '{}' },
                { type: 'tool-input-end', id: 'c1' },
                {
                  type: 'tool-call',
                  toolCallId: 'c1',
                  toolName: 'ping',
                  input: JSON.stringify({}),
                },
                { type: 'finish', finishReason: 'tool-calls', usage },
              ]
            : [
                { type: 'text-start', id: '1' },
                { type: 'text-delta', id: '1', delta: 'done' },
                { type: 'text-end', id: '1' },
                { type: 'finish', finishReason: 'stop', usage },
              ],
          chunkDelayInMs: 0,
          initialDelayInMs: 0,
        }) as never,
      }
    },
  })
}

class StubGateway extends ModelGateway {
  constructor(private readonly model: MockLanguageModelV4) {
    super({ apiKey: 'unused' })
  }
  override resolve(alias: string, role: string): ResolvedModel {
    return {
      entry: this.catalog.resolve(alias, role),
      vendor: 'anthropic',
      providerTools: {},
      model: this.model,
    }
  }
}

function harness() {
  const events: WorkspaceEvent[] = []
  const gateway = new StubGateway(twoStepModel())
  const agent = new Agent({
    gateway,
    policy,
    modelAlias: 'Light',
    role: 'staff',
    onEvent: (e) => events.push(e),
    tools: {
      ping: tool({
        description: 'ping',
        inputSchema: z.object({}),
        execute: async () => ({ pong: true }),
      }),
    },
  })
  return { agent, events, gateway }
}

describe('step events', () => {
  it('emits a matched started/finished pair, numbered from zero', async () => {
    const { agent, events } = harness()
    await agent.send('go')

    const started = events.filter((e) => e.type === 'step.started')
    const finished = events.filter((e) => e.type === 'step.finished')

    expect(started.length).toBe(finished.length)
    expect(started.map((e) => (e as { stepNumber: number }).stepNumber)).toEqual([0])
    expect(finished.map((e) => (e as { stepNumber: number }).stepNumber)).toEqual([0])
  })

  it('reports the tool calls and how long the step took', async () => {
    const { agent, events } = harness()
    await agent.send('go')

    const finished = events.filter((e) => e.type === 'step.finished') as unknown as {
      toolCalls: number
      durationMs?: number
      finishReason?: string
    }[]

    expect(finished[0]!.toolCalls).toBe(1)
    // Wall-clock is what a timeline is for, and unlike finishReason the SDK
    // reports it consistently.
    expect(finished[0]!.durationMs).toBeGreaterThan(0)
  })

  it('prices a step without also recording it', async () => {
    // The step number is priced for display; the turn's usage is recorded once
    // at the end. Recording per step as well would make the session total
    // exactly twice the real spend — a meter that lies upward is still a
    // meter that lies.
    const { agent, events, gateway } = harness()
    await agent.send('go')

    const steps = events.filter((e) => e.type === 'step.finished') as unknown as {
      cost: { usd: number; uncachedInputTokens: number }
    }[]

    expect(steps[0]!.cost.uncachedInputTokens).toBe(100)
    expect(steps[0]!.cost.usd).toBeGreaterThan(0)
    // One request in, one request recorded — not two.
    expect(gateway.totals().session.uncachedInputTokens).toBe(100)
    expect(gateway.totals().session.usd).toBeCloseTo(steps[0]!.cost.usd, 9)
  })

  it('names the tools the step was allowed to use', async () => {
    // The trace is meant to answer "why did it not use X" — which needs to
    // show what was actually on offer, not what was registered.
    const events: WorkspaceEvent[] = []
    const agent = new Agent({
      gateway: new StubGateway(twoStepModel()),
      policy,
      modelAlias: 'Light',
      role: 'staff',
      onEvent: (e) => events.push(e),
      activeTools: () => ['readFile', 'searchFiles'],
    })
    await agent.send('go')

    const started = events.find((e) => e.type === 'step.started') as unknown as {
      activeTools?: string[]
    }
    expect(started.activeTools).toEqual(['readFile', 'searchFiles'])
  })

  it('sends reasoning effort only to a model that honours it', async () => {
    const model = twoStepModel()
    const gateway = new StubGateway(model)
    const agent = new Agent({
      gateway,
      policy,
      modelAlias: 'Light',
      role: 'staff',
      reasoningEffort: 'high',
    })

    await agent.send('go')

    const sent = model.doStreamCalls[0]?.providerOptions as
      | { openrouter?: { reasoning?: { effort?: string } } }
      | undefined
    expect(sent?.openrouter?.reasoning?.effort).toBe('high')
  })

  it('omits it when the catalog says the model ignores it', async () => {
    // A knob the model discards is worse than no knob: the user believes they
    // changed something.
    const model = twoStepModel()
    const gateway = new StubGateway(model)
    // Pretend this entry does not support effort.
    const entry = gateway.catalog.get('Light')
    ;(entry as { supportsReasoningEffort: boolean }).supportsReasoningEffort = false

    const agent = new Agent({
      gateway,
      policy,
      modelAlias: 'Light',
      role: 'staff',
      reasoningEffort: 'high',
    })
    await agent.send('go')

    expect(model.doStreamCalls[0]?.providerOptions).toBeUndefined()
  })
})

