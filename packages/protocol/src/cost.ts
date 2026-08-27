import { z } from 'zod'

/**
 * The four-bucket cost model (PLAN-V2 §6.5).
 *
 * Providers price these differently enough that collapsing them into one
 * "tokens" number makes the meter wrong rather than approximate: cache writes
 * run 1.25-2x uncached input, cache reads about 0.1x, and reasoning tokens are
 * billed as output even though the user never sees them.
 */
export const costBucketsSchema = z.object({
  uncachedInputTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /**
   * A SUBSET of outputTokens, not an addition to it. Every provider we price
   * reports reasoning inside its output/completion count (OpenAI nests
   * `reasoning_tokens` under completion tokens; Anthropic bills thinking as
   * output). Tracked separately so the UI can show what was spent thinking —
   * never added to outputTokens when pricing, or reasoning models bill twice.
   */
  reasoningTokens: z.number().int().nonnegative(),
  /**
   * Server-side web searches, counted rather than measured in tokens.
   *
   * Not a token bucket, but billed alongside them and at a rate that dwarfs
   * them: a single search runs $0.005-$0.01, which is more than a whole
   * cheap-tier turn. Leaving it out would make the meter quietly wrong in the
   * direction that matters, understating exactly the feature people use most.
   *
   * Defaulted so cost rows written before this bucket existed still parse.
   */
  webSearches: z.number().int().nonnegative().default(0),
  usd: z.number().nonnegative(),
})

export type CostBuckets = z.infer<typeof costBucketsSchema>

export const zeroCost: CostBuckets = {
  uncachedInputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  webSearches: 0,
  usd: 0,
}

export function addCost(a: CostBuckets, b: CostBuckets): CostBuckets {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    webSearches: a.webSearches + b.webSearches,
    usd: a.usd + b.usd,
  }
}

/** Per-million-token rates, as published by the provider. */
export const modelRatesSchema = z.object({
  inputPerMtok: z.number().nonnegative(),
  outputPerMtok: z.number().nonnegative(),
  /** Multiplier on input rate for writing to cache. Typically 1.25-2. */
  cacheWriteMultiplier: z.number().nonnegative().default(1.25),
  /** Multiplier on input rate for reading from cache. Typically 0.1. */
  cacheReadMultiplier: z.number().nonnegative().default(0.1),
  /**
   * USD per server-side web search. Brave's own API is $0.005; the hosted tools
   * that resell it run $0.004-$0.01.
   */
  webSearchPerCall: z.number().nonnegative().default(0.005),
})

export type ModelRates = z.infer<typeof modelRatesSchema>

/**
 * `reasoningTokens` is NOT priced here — it is already inside `outputTokens`.
 * See the note on the schema.
 */
export function priceUsage(
  usage: Omit<CostBuckets, 'usd'>,
  rates: ModelRates,
): CostBuckets {
  const perInputToken = rates.inputPerMtok / 1_000_000
  const perOutputToken = rates.outputPerMtok / 1_000_000

  const usd =
    usage.uncachedInputTokens * perInputToken +
    usage.cacheWriteTokens * perInputToken * rates.cacheWriteMultiplier +
    usage.cacheReadTokens * perInputToken * rates.cacheReadMultiplier +
    usage.outputTokens * perOutputToken +
    usage.webSearches * rates.webSearchPerCall

  return { ...usage, usd }
}
