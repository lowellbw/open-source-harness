import { describe, expect, it } from 'vitest'
import type { Message } from '@workspace/protocol'
import { ModelCatalog, CatalogError, defaultCatalog } from './catalog.js'
import { Meter, usageToBuckets } from './meter.js'
import { BudgetGuard, BudgetExceededError } from './budget.js'
import {
  stripForeignReasoning,
  assertReplayable,
  isSwitchSafe,
  prepareForProvider,
  ReasoningIntegrityError,
} from './artifacts.js'
import { vendorOf } from './gateway.js'

const rates = { inputPerMtok: 1, outputPerMtok: 1, cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 }

describe('ModelCatalog', () => {
  it('refuses a catalog with no always-available floor', () => {
    expect(
      () =>
        new ModelCatalog([
          { alias: 'Only', tier: 'standard', provider: 'p', upstreamModel: 'x/y', contextWindow: 1000, rates, enabledForRoles: ['staff'], alwaysAvailable: false },
        ]),
    ).toThrow(CatalogError)
  })

  it('refuses a floor that is role-gated, which would defeat the point', () => {
    expect(
      () =>
        new ModelCatalog([
          { alias: 'Floor', tier: 'light', provider: 'p', upstreamModel: 'x/y', contextWindow: 1000, rates, enabledForRoles: ['staff'], alwaysAvailable: true },
        ]),
    ).toThrow(/role-gated/)
  })

  it('refuses duplicate aliases', () => {
    const one = { alias: 'A', tier: 'light' as const, provider: 'p', upstreamModel: 'x/y', contextWindow: 1000, rates, enabledForRoles: [], alwaysAvailable: true }
    expect(() => new ModelCatalog([one, { ...one }])).toThrow(/Duplicate/)
  })

  it('gates by role', () => {
    const catalog = defaultCatalog()
    expect(() => catalog.resolve('Premium', 'learner')).toThrow(/not permitted/)
    expect(catalog.resolve('Premium', 'staff').alias).toBe('Premium')
  })

  it('never leaves a role with nothing to use', () => {
    const catalog = defaultCatalog()
    for (const role of ['learner', 'staff', 'anonymous', 'some-role-nobody-configured']) {
      expect(catalog.listForRole(role).length).toBeGreaterThan(0)
    }
  })

  it('picks the cheapest always-available entry as the floor', () => {
    const catalog = new ModelCatalog([
      { alias: 'Cheap', tier: 'light', provider: 'p', upstreamModel: 'a/cheap', contextWindow: 1000, rates: { ...rates, inputPerMtok: 0.2 }, enabledForRoles: [], alwaysAvailable: true },
      { alias: 'LessCheap', tier: 'light', provider: 'p', upstreamModel: 'a/mid', contextWindow: 1000, rates: { ...rates, inputPerMtok: 2 }, enabledForRoles: [], alwaysAvailable: true },
    ])
    expect(catalog.floor().alias).toBe('Cheap')
  })

  it('exposes aliases rather than provider model IDs', () => {
    // The admin can repoint "Standard" at another upstream without anyone
    // relearning a name — that is the whole reason for the indirection.
    expect(defaultCatalog().list().map((e) => e.alias)).toContain('Standard')
  })
})

describe('usage mapping', () => {
  it('maps the SDK breakdown onto the four buckets', () => {
    const buckets = usageToBuckets({
      inputTokens: 1000,
      inputTokenDetails: { noCacheTokens: 600, cacheReadTokens: 300, cacheWriteTokens: 100 },
      outputTokens: 500,
      outputTokenDetails: { textTokens: 400, reasoningTokens: 100 },
      totalTokens: 1500,
    })
    expect(buckets).toEqual({
      uncachedInputTokens: 600,
      cacheReadTokens: 300,
      cacheWriteTokens: 100,
      outputTokens: 500,
      reasoningTokens: 100,
      // Usage accounting has no field for server tool calls; the agent counts
      // them off the tool stream instead.
      webSearches: 0,
    })
  })

  it('bills the whole input as uncached when a provider reports no breakdown', () => {
    // Over-estimating is the right direction for a number that drives a ceiling.
    const buckets = usageToBuckets({
      inputTokens: 900,
      inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
      outputTokens: 100,
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      totalTokens: 1000,
    })
    expect(buckets.uncachedInputTokens).toBe(900)
    expect(buckets.reasoningTokens).toBe(0)
  })

  it('survives a completely absent usage report', () => {
    expect(usageToBuckets(undefined).outputTokens).toBe(0)
  })
})

describe('BudgetGuard', () => {
  const spend = (guard: BudgetGuard, usd: number) =>
    guard.record({ uncachedInputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0, usd })

  it('allows work below the ceiling', () => {
    const guard = new BudgetGuard(new Meter(), { perRunUsd: 5, perSessionUsd: 15 })
    spend(guard, 1)
    expect(() => guard.assertCanProceed()).not.toThrow()
  })

  it('halts the run at the run ceiling', () => {
    const guard = new BudgetGuard(new Meter(), { perRunUsd: 5, perSessionUsd: 15 })
    spend(guard, 5)
    expect(() => guard.assertCanProceed()).toThrow(BudgetExceededError)
    expect(guard.isTripped()).toBe(true)
  })

  it('halts at the session ceiling even when each run stays under its own', () => {
    const meter = new Meter()
    const guard = new BudgetGuard(meter, { perRunUsd: 5, perSessionUsd: 12 })
    for (let i = 0; i < 3; i++) {
      meter.startRun()
      spend(guard, 4)
    }
    // Run total is 4 and fine; the session total is 12 and is not.
    expect(guard.remaining().runUsd).toBeGreaterThan(0)
    expect(() => guard.assertCanProceed()).toThrow(/session/)
  })

  it('resets run spend but not session spend between runs', () => {
    const meter = new Meter()
    const guard = new BudgetGuard(meter, { perRunUsd: 5, perSessionUsd: 15 })
    spend(guard, 3)
    meter.startRun()
    expect(meter.runTotal().usd).toBe(0)
    expect(meter.sessionTotal().usd).toBe(3)
  })

  it('reports utilisation against the tighter ceiling, for soft-limit warnings', () => {
    const guard = new BudgetGuard(new Meter(), { perRunUsd: 10, perSessionUsd: 100 })
    spend(guard, 8)
    expect(guard.utilisation()).toBeCloseTo(0.8, 5)
  })
})

describe('reasoning artifacts across a model switch', () => {
  const msg = (provider: string, signature?: string): Message => ({
    id: 'm1',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'answer' },
      { type: 'reasoning', text: 'thinking', provider, ...(signature ? { signature } : {}) },
    ],
    pinned: false,
  })

  it('strips another provider’s reasoning', () => {
    const result = stripForeignReasoning([msg('anthropic', 'sig')], 'openai')
    expect(result.strippedForeign).toBe(1)
    expect(result.messages[0]!.parts.some((p) => p.type === 'reasoning')).toBe(false)
  })

  it('keeps the target provider’s own reasoning, which is what makes replay valid', () => {
    const result = stripForeignReasoning([msg('anthropic', 'sig')], 'anthropic')
    expect(result.strippedForeign).toBe(0)
    expect(result.messages[0]!.parts.some((p) => p.type === 'reasoning')).toBe(true)
  })

  it('treats vertex and google as the same vendor', () => {
    // Getting this wrong would strip Google's own signatures and trigger the
    // very hard-fail the module exists to prevent.
    expect(stripForeignReasoning([msg('vertex', 'sig')], 'google').strippedForeign).toBe(0)
    expect(stripForeignReasoning([msg('google', 'sig')], 'vertex').strippedForeign).toBe(0)
  })

  it('fails loudly rather than sending Google history with its signatures removed', () => {
    const original = [msg('google', 'thought-sig')]
    const stripped: Message[] = [{ ...original[0]!, parts: [{ type: 'text', text: 'answer' }] }]
    expect(() => assertReplayable(original, stripped, 'google')).toThrow(ReasoningIntegrityError)
  })

  it('does not complain when a lenient provider loses its reasoning', () => {
    const original = [msg('anthropic', 'sig')]
    const stripped: Message[] = [{ ...original[0]!, parts: [{ type: 'text', text: 'answer' }] }]
    expect(() => assertReplayable(original, stripped, 'anthropic')).not.toThrow()
  })

  it('prepareForProvider strips foreign reasoning and passes the integrity check', () => {
    const history = [msg('anthropic', 'sig'), msg('google', 'thought')]
    const result = prepareForProvider(history, 'google')
    expect(result.strippedForeign).toBe(1)
    expect(() => prepareForProvider(history, 'google')).not.toThrow()
  })

  it('refuses a cross-provider switch outside a compaction boundary', () => {
    expect(isSwitchSafe({ fromProvider: 'anthropic', toProvider: 'google', atCompactionBoundary: false }).safe).toBe(false)
    expect(isSwitchSafe({ fromProvider: 'anthropic', toProvider: 'google', atCompactionBoundary: true }).safe).toBe(true)
  })

  it('allows a same-provider switch anywhere, since no artifacts are foreign', () => {
    expect(isSwitchSafe({ fromProvider: 'anthropic', toProvider: 'anthropic', atCompactionBoundary: false }).safe).toBe(true)
  })
})

describe('vendorOf', () => {
  it('extracts the vendor from a gateway model ID', () => {
    expect(vendorOf('anthropic/claude-sonnet-5')).toBe('anthropic')
    expect(vendorOf('google/gemini-3.7-flash')).toBe('google')
    expect(vendorOf('bare-model')).toBe('bare-model')
  })
})
