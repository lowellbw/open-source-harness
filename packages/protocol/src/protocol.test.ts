import { describe, expect, it } from 'vitest'
import { EventType } from '@ag-ui/core'
import { parseEvent, workspaceEventSchema, type WorkspaceEvent } from './events.js'
import { priceUsage, addCost, zeroCost } from './cost.js'
import { toAgUi } from './agui.js'

const ctx = { threadId: 'thread-1' }

/** One representative of every event type, so the projection test below is exhaustive. */
const samples: WorkspaceEvent[] = [
  { type: 'run.started', runId: 'r1', ts: 1, threadId: 'thread-1' },
  { type: 'run.finished', runId: 'r1', ts: 2, reason: 'complete' },
  { type: 'run.error', runId: 'r1', ts: 3, message: 'boom' },
  { type: 'status', runId: 'r1', ts: 4, state: 'thinking' },
  { type: 'message.started', runId: 'r1', ts: 5, messageId: 'm1' },
  { type: 'message.delta', runId: 'r1', ts: 6, messageId: 'm1', delta: 'hi' },
  { type: 'message.finished', runId: 'r1', ts: 7, messageId: 'm1' },
  { type: 'reasoning.delta', runId: 'r1', ts: 8, messageId: 'm1', delta: 'hmm' },
  { type: 'reasoning.artifact', runId: 'r1', ts: 9, messageId: 'm1', provider: 'anthropic', value: 'sig' },
  { type: 'tool.call.started', runId: 'r1', ts: 10, toolCallId: 't1', name: 'read', args: { path: '/a' } },
  { type: 'tool.call.finished', runId: 'r1', ts: 11, toolCallId: 't1', result: { ok: true }, isError: false },
  {
    type: 'approval.requested',
    runId: 'r1',
    ts: 12,
    approvalId: 'a1',
    toolCallId: 't1',
    reason: 'deletes files',
    irreversible: true,
    payload: {},
  },
  { type: 'approval.resolved', runId: 'r1', ts: 13, approvalId: 'a1', decision: 'allow' },
  {
    type: 'context.compacted',
    runId: 'r1',
    ts: 14,
    strategy: 'keep-first+recent',
    beforeMessages: 40,
    afterMessages: 12,
    beforeTokens: 90_000,
    afterTokens: 20_000,
  },
  { type: 'model.switched', runId: 'r1', ts: 15, from: 'a', to: 'b', atCompactionBoundary: true },
  {
    type: 'cost.updated',
    runId: 'r1',
    ts: 16,
    run: zeroCost,
    session: zeroCost,
    delta: zeroCost,
    model: 'Standard',
  },
  { type: 'workspace.file.changed', runId: 'r1', ts: 17, path: '/out/deck.pptx', op: 'created' },
  { type: 'step.started', runId: 'r1', ts: 21, stepNumber: 0, activeTools: ['readFile'] },
  {
    type: 'step.finished',
    runId: 'r1',
    ts: 22,
    stepNumber: 0,
    cost: zeroCost,
    toolCalls: 2,
    durationMs: 812.4,
    finishReason: 'tool-calls',
  },
  { type: 'subagent.started', runId: 'r1', ts: 19, subagentId: 's1', task: 'Find the condenser' },
  {
    type: 'subagent.finished',
    runId: 'r1',
    ts: 20,
    subagentId: 's1',
    cost: zeroCost,
    stoppedBy: 'complete',
    reportChars: 412,
  },
  {
    type: 'source.cited',
    runId: 'r1',
    ts: 18,
    messageId: 'm1',
    url: 'https://www.libreoffice.org/download/',
    title: 'Download — LibreOffice',
  },
]

describe('event schema', () => {
  it('accepts every sample and round-trips through JSON', () => {
    for (const s of samples) {
      expect(parseEvent(JSON.parse(JSON.stringify(s)))).toEqual(s)
    }
  })

  it('covers every declared event type', () => {
    const declared = workspaceEventSchema.options.map((o) => o.shape.type.value as string)
    const covered = samples.map((s) => s.type as string)
    expect([...new Set(declared)].sort()).toEqual([...new Set(covered)].sort())
  })

  it('rejects an unknown event type', () => {
    expect(() => parseEvent({ type: 'nope', runId: 'r', ts: 1 })).toThrow()
  })

  it('rejects a known event missing a required field', () => {
    expect(() => parseEvent({ type: 'message.delta', runId: 'r', ts: 1, messageId: 'm' })).toThrow()
  })
})

describe('AG-UI projection', () => {
  it('projects every event type to at least one valid AG-UI event', () => {
    const valid = new Set(Object.values(EventType) as string[])
    for (const s of samples) {
      const out = toAgUi(s, ctx)
      expect(out.length, `no projection for ${s.type}`).toBeGreaterThan(0)
      for (const e of out) {
        expect(valid.has(e.type as string), `${s.type} -> invalid ${String(e.type)}`).toBe(true)
      }
    }
  })

  it('carries a provider reasoning artifact verbatim', () => {
    const artifact = samples.find((s) => s.type === 'reasoning.artifact')!
    const [e] = toAgUi(artifact, ctx)
    expect(e).toMatchObject({
      type: EventType.REASONING_ENCRYPTED_VALUE,
      entityId: 'm1',
      encryptedValue: 'sig',
    })
  })

  it('splits a tool call into START then ARGS so arguments can stream', () => {
    const started = samples.find((s) => s.type === 'tool.call.started')!
    expect(toAgUi(started, ctx).map((e) => e.type)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
    ])
  })

  it('survives an unserialisable tool result rather than killing the stream', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const out = toAgUi(
      { type: 'tool.call.finished', runId: 'r1', ts: 1, toolCallId: 't1', result: circular, isError: false },
      ctx,
    )
    expect(out).toHaveLength(2)
  })

  it('takes threadId from context on run.finished, which does not carry one', () => {
    const [e] = toAgUi({ type: 'run.finished', runId: 'r1', ts: 2, reason: 'complete' }, ctx)
    expect(e).toMatchObject({ threadId: 'thread-1', runId: 'r1' })
  })
})

describe('four-bucket cost model', () => {
  const rates = {
    inputPerMtok: 2,
    outputPerMtok: 10,
    cacheWriteMultiplier: 1.25,
    cacheReadMultiplier: 0.1,
    webSearchPerCall: 0.005,
  }

  it('prices each bucket at its own rate', () => {
    const c = priceUsage(
      {
        uncachedInputTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        outputTokens: 1_000_000,
        reasoningTokens: 0,
        webSearches: 0,
      },
      rates,
    )
    // 2.00 input + 2.50 cache write (1.25x) + 0.20 cache read (0.1x) + 10.00 output
    expect(c.usd).toBeCloseTo(14.7, 6)
  })

  it('prices web searches per call, not per token', () => {
    // A search is billed as an event. At $0.005 each, twenty of them cost more
    // than a whole cheap-tier turn — which is why they cannot be left out.
    const c = priceUsage(
      {
        uncachedInputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        webSearches: 3,
      },
      rates,
    )
    expect(c.usd).toBeCloseTo(0.015, 6)
  })

  it('does NOT bill reasoning tokens on top of output — they are a subset of it', () => {
    const base = {
      uncachedInputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 1_000_000,
      webSearches: 0,
    }
    const withReasoning = priceUsage({ ...base, reasoningTokens: 900_000 }, rates)
    const without = priceUsage({ ...base, reasoningTokens: 0 }, rates)

    expect(withReasoning.usd).toBeCloseTo(without.usd, 6)
    expect(withReasoning.usd).toBeCloseTo(10, 6)
  })

  it('sums buckets when accumulating across turns', () => {
    const turn = priceUsage(
      {
        uncachedInputTokens: 100,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 50,
        reasoningTokens: 10,
        webSearches: 0,
      },
      rates,
    )
    expect(addCost(addCost(zeroCost, turn), turn)).toMatchObject({
      uncachedInputTokens: 200,
      outputTokens: 100,
      reasoningTokens: 20,
      webSearches: 0,
    })
  })
})
