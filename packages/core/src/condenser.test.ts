import { describe, expect, it, vi } from 'vitest'
import type { Message } from '@workspace/protocol'
import { condense, recentBoundary, defaultCondenserOptions } from './condenser.js'
import { PolicyPin, POLICY_MESSAGE_ID, assembleRequest, buildPolicyMessage } from './pinning.js'
import { estimateTokens } from './tokens.js'

const text = (id: string, role: Message['role'], body: string, pinned = false): Message => ({
  id,
  role,
  pinned,
  parts: [{ type: 'text', text: body }],
})

const toolCall = (id: string, toolCallId: string): Message => ({
  id,
  role: 'assistant',
  pinned: false,
  parts: [{ type: 'tool-call', toolCallId, toolName: 'read', input: { path: '/a' } }],
})

const toolResult = (id: string, toolCallId: string, output: unknown): Message => ({
  id,
  role: 'tool',
  pinned: false,
  parts: [{ type: 'tool-result', toolCallId, toolName: 'read', output, isError: false }],
})

const policy = {
  orgId: 'org_123',
  userId: 'user_1',
  role: 'learner',
  scope: ['/work'],
  permissions: ['read', 'write'],
  constraints: [
    'Never write outside /work.',
    'Never send workspace contents to an external service.',
  ],
}

describe('condenser', () => {
  it('does nothing when the conversation fits', async () => {
    const messages = [text('a', 'user', 'short')]
    const result = await condense(messages, { ...defaultCondenserOptions, maxTokens: 10_000 })
    expect(result.compacted).toBe(false)
    expect(result.messages).toBe(messages)
  })

  it('elides losslessly BEFORE it ever summarises', async () => {
    const order: string[] = []
    const history: Message[] = [
      text('task', 'user', 'do the thing'),
      ...Array.from({ length: 6 }, (_, i) => [
        toolCall(`c${i}`, `t${i}`),
        toolResult(`r${i}`, `t${i}`, 'X'.repeat(8_000)),
      ]).flat(),
      text('recent', 'user', 'and now this'),
    ]

    const result = await condense(history, {
      ...defaultCondenserOptions,
      maxTokens: 2_000,
      persistToolOutput: async (id) => {
        order.push('elide')
        return `/elided/${id}.json`
      },
      summarise: async () => {
        order.push('summarise')
        return 'summary'
      },
    })

    // The contract is the ordering, not that eliding always suffices. Exact
    // strings get their chance to survive before anything paraphrases them.
    expect(order[0]).toBe('elide')
    expect(order.indexOf('elide')).toBeLessThan(
      order.includes('summarise') ? order.indexOf('summarise') : Infinity,
    )
    expect(result.strategy).toContain('elide-tool-outputs')
    expect(result.after.tokens).toBeLessThan(result.before.tokens)
  })

  it('stops after the lossless pass when that alone gets under budget', async () => {
    const summarise = vi.fn(async () => 'summary')
    const history: Message[] = [
      text('task', 'user', 'do the thing'),
      toolCall('c0', 't0'),
      toolResult('r0', 't0', 'X'.repeat(20_000)),
      ...Array.from({ length: 4 }, (_, i) => text(`m${i}`, 'assistant', 'brief')),
    ]

    const result = await condense(history, {
      ...defaultCondenserOptions,
      keepRecent: 2,
      maxTokens: 1_000,
      persistToolOutput: async (id) => `/elided/${id}.json`,
      summarise,
    })

    expect(result.strategy).toBe('elide-tool-outputs')
    expect(summarise).not.toHaveBeenCalled()
  })

  it('replaces an elided output with a readable pointer, not a silent drop', async () => {
    const history: Message[] = [
      text('task', 'user', 'go'),
      toolCall('c', 't1'),
      toolResult('r', 't1', 'Y'.repeat(9_000)),
      ...Array.from({ length: 8 }, (_, i) => text(`f${i}`, 'user', 'filler '.repeat(50))),
    ]

    const result = await condense(history, {
      ...defaultCondenserOptions,
      maxTokens: 500,
      persistToolOutput: async (id) => `/elided/${id}.json`,
    })

    const elided = result.messages
      .flatMap((m) => m.parts)
      .find((p) => p.type === 'tool-result' && p.elidedTo)
    expect(elided).toBeDefined()
    expect(String((elided as { output: unknown }).output)).toContain('/elided/t1.json')
  })

  it('skips the lossless pass entirely when it has nowhere to persist', async () => {
    // Without a persist target, eliding would just delete content and call it
    // compaction. Refusing is the honest behaviour.
    const history: Message[] = [
      text('task', 'user', 'go'),
      toolCall('c', 't1'),
      toolResult('r', 't1', 'Z'.repeat(9_000)),
    ]
    const result = await condense(history, { ...defaultCondenserOptions, maxTokens: 100 })
    expect(result.strategy).toBe('none')
    expect(result.messages).toHaveLength(3)
  })

  it('summarises the middle when eliding is not enough', async () => {
    const summarise = vi.fn(async () => 'the middle happened')
    const history: Message[] = [
      text('task', 'user', 'the original task'),
      ...Array.from({ length: 30 }, (_, i) => text(`m${i}`, 'assistant', 'chatter '.repeat(100))),
      text('recent', 'user', 'latest'),
    ]

    const result = await condense(history, {
      ...defaultCondenserOptions,
      maxTokens: 500,
      summarise,
    })

    expect(summarise).toHaveBeenCalledOnce()
    expect(result.strategy).toContain('summarise-middle')
    expect(result.messages.length).toBeLessThan(history.length)
    // Head and tail survive verbatim.
    expect(result.messages[0]!.id).toBe('task')
    expect(result.messages.at(-1)!.id).toBe('recent')
  })
})

describe('tool-call pairing at the compaction boundary', () => {
  it('never splits a tool call from its result', () => {
    // A boundary landing between the two produces history no provider will
    // accept, so it must move earlier rather than cut.
    const history = [
      text('a', 'user', 'go'),
      toolCall('call', 't1'),
      toolResult('res', 't1', 'out'),
      text('b', 'user', 'next'),
    ]
    // keepRecent = 2 would start the window at the tool result, orphaning it.
    const boundary = recentBoundary(history, 2)
    expect(boundary).toBeLessThanOrEqual(1)
    expect(history[boundary]?.id).not.toBe('res')
  })

  it('pulls the calling assistant message into the window with its results', () => {
    const history = [
      text('a', 'user', 'go'),
      text('b', 'assistant', 'thinking'),
      toolCall('call', 't1'),
      toolResult('res', 't1', 'out'),
    ]
    const boundary = recentBoundary(history, 1)
    expect(history.slice(boundary).some((m) => m.id === 'call')).toBe(true)
  })

  it('leaves an ordinary boundary alone', () => {
    const history = Array.from({ length: 6 }, (_, i) => text(`m${i}`, 'user', 'x'))
    expect(recentBoundary(history, 2)).toBe(4)
  })
})

describe('constraint survival across repeated compaction', () => {
  /**
   * The regression test for the failure this architecture exists to prevent.
   *
   * Published measurements put safety-rule recall at 53% after one compaction
   * round and 10% by the fifth. Here the count of requests missing the policy
   * must be exactly zero, every round, forever.
   */
  it('keeps the pinned policy in every assembled request across many rounds', async () => {
    const pin = new PolicyPin(policy)
    let history: Message[] = [text('task', 'user', 'the original task')]

    let missing = 0
    let compactions = 0

    for (let round = 0; round < 12; round++) {
      // Conversation grows the way a real one does.
      for (let i = 0; i < 8; i++) {
        history.push(text(`r${round}-m${i}`, 'assistant', 'output '.repeat(120)))
      }

      const result = await condense(history, {
        ...defaultCondenserOptions,
        maxTokens: 1_500,
        summarise: async () => 'earlier work summarised',
      })
      if (result.compacted) compactions++
      history = result.messages.filter((m) => !m.pinned)

      const request = pin.assemble(history, { budgetRemainingUsd: 4.2 })
      const policyBlock = request.find((m) => m.id === POLICY_MESSAGE_ID)

      if (
        !policyBlock ||
        !policyBlock.parts.some(
          (p) => p.type === 'text' && p.text.includes('Never write outside /work.'),
        )
      ) {
        missing++
      }
    }

    expect(compactions).toBeGreaterThan(3)
    expect(missing).toBe(0)
  })

  it('never lets a summariser see pinned content, so it cannot paraphrase it away', async () => {
    const seen: Message[][] = []
    const history: Message[] = [
      buildPolicyMessage(policy),
      text('task', 'user', 'go'),
      ...Array.from({ length: 30 }, (_, i) => text(`m${i}`, 'assistant', 'chatter '.repeat(100))),
    ]

    await condense(history, {
      ...defaultCondenserOptions,
      maxTokens: 400,
      summarise: async (middle) => {
        seen.push(middle)
        return 'summary'
      },
    })

    expect(seen.length).toBeGreaterThan(0)
    for (const batch of seen) {
      expect(batch.some((m) => m.pinned)).toBe(false)
      expect(batch.some((m) => m.id === POLICY_MESSAGE_ID)).toBe(false)
    }
  })

  it('keeps the pinned block even when compaction reduces history to almost nothing', async () => {
    const pin = new PolicyPin(policy)
    const result = await condense(
      Array.from({ length: 40 }, (_, i) => text(`m${i}`, 'assistant', 'x'.repeat(400))),
      { ...defaultCondenserOptions, maxTokens: 200, summarise: async () => 's' },
    )
    const request = pin.assemble(result.messages.filter((m) => !m.pinned))
    expect(request[0]!.id).toBe(POLICY_MESSAGE_ID)
  })

  it('drops a stale pinned copy from history so it cannot shadow the fresh one', () => {
    const stale = buildPolicyMessage({ ...policy, constraints: ['OUTDATED RULE'] })
    const pin = new PolicyPin(policy)
    const request = pin.assemble([stale, text('m', 'user', 'hi')])

    const policyBlocks = request.filter((m) => m.id === POLICY_MESSAGE_ID)
    expect(policyBlocks).toHaveLength(1)
    expect(policyBlocks[0]!.parts.some((p) => p.type === 'text' && p.text.includes('OUTDATED'))).toBe(false)
  })

  it('reflects live budget in the pinned block rather than a cached value', () => {
    const pin = new PolicyPin(policy)
    expect(
      pin.messages({ budgetRemainingUsd: 1.5 })[0]!.parts.some(
        (p) => p.type === 'text' && p.text.includes('$1.50'),
      ),
    ).toBe(true)
    expect(
      pin.messages({ budgetRemainingUsd: 0.25 })[0]!.parts.some(
        (p) => p.type === 'text' && p.text.includes('$0.25'),
      ),
    ).toBe(true)
  })
})

describe('token estimation', () => {
  it('counts the opaque reasoning signature, not just visible text', () => {
    const withSignature: Message = {
      id: 'a',
      role: 'assistant',
      pinned: false,
      parts: [{ type: 'reasoning', text: 'short', provider: 'anthropic', signature: 'S'.repeat(4_000) }],
    }
    const without: Message = {
      id: 'b',
      role: 'assistant',
      pinned: false,
      parts: [{ type: 'reasoning', text: 'short', provider: 'anthropic' }],
    }
    // Ignoring the signature would under-count exactly the conversations most
    // likely to need compaction.
    expect(estimateTokens([withSignature])).toBeGreaterThan(estimateTokens([without]) + 500)
  })

  it('survives an unserialisable tool payload', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const message: Message = {
      id: 'a',
      role: 'tool',
      pinned: false,
      parts: [{ type: 'tool-result', toolCallId: 't', toolName: 'x', output: circular, isError: false }],
    }
    expect(() => estimateTokens([message])).not.toThrow()
  })
})

describe('assembleRequest', () => {
  it('puts pinned content first, ahead of all history', () => {
    const request = assembleRequest(
      [buildPolicyMessage(policy)],
      [text('a', 'user', 'one'), text('b', 'assistant', 'two')],
    )
    expect(request[0]!.id).toBe(POLICY_MESSAGE_ID)
    expect(request).toHaveLength(3)
  })
})
