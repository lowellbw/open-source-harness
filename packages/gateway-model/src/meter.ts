import type { LanguageModelUsage } from 'ai'
import { addCost, priceUsage, zeroCost, type CostBuckets, type ModelRates } from '@workspace/protocol'

/**
 * Maps the AI SDK's usage report onto the four-bucket model (PLAN-V2 §6.5).
 *
 * The shapes line up almost exactly, which is a point in the SDK's favour:
 * `inputTokenDetails` already separates non-cached, cache-read and cache-write,
 * and `outputTokenDetails.reasoningTokens` is reported as a component of
 * `outputTokens` rather than in addition to it — matching how providers bill.
 *
 * Every field is optional in the SDK type because not every provider reports
 * them, so the fallbacks below matter more than the happy path.
 */
export function usageToBuckets(usage: LanguageModelUsage | undefined): Omit<CostBuckets, 'usd'> {
  const input = usage?.inputTokens ?? 0
  const details = usage?.inputTokenDetails
  const cacheRead = details?.cacheReadTokens ?? 0
  const cacheWrite = details?.cacheWriteTokens ?? 0

  // When a provider reports a total but no breakdown, bill the whole thing as
  // uncached. That over-estimates rather than under-estimates, which is the
  // right direction for a number that also drives a spend ceiling.
  const uncached =
    details?.noCacheTokens ?? Math.max(0, input - cacheRead - cacheWrite)

  return {
    uncachedInputTokens: uncached,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: usage?.outputTokens ?? 0,
    reasoningTokens: usage?.outputTokenDetails?.reasoningTokens ?? 0,
    // Always zero here. The count is carried separately because the field it
    // comes from survives only on per-step usage — see serverWebSearches.
    webSearches: 0,
  }
}

export function priceUsageReport(
  usage: LanguageModelUsage | undefined,
  rates: ModelRates,
  extras: { webSearches?: number } = {},
): CostBuckets {
  return priceUsage({ ...usageToBuckets(usage), webSearches: extras.webSearches ?? 0 }, rates)
}

/**
 * Server-side searches the provider ran inside one step.
 *
 * These do not appear in the typed usage fields, and — more surprisingly — do
 * not appear as tool calls in the stream either: the whole search happens
 * inside the model request, so the only traces are `source` parts and this
 * count. Verified against a live OpenRouter response, which reports
 * `server_tool_use_details.web_search_requests`.
 *
 * PER STEP, deliberately. `raw` survives on the usage attached to each
 * `finish-step` part but is dropped from the aggregated total the SDK resolves
 * at the end, so reading it off the total silently yields zero — which reads
 * as "search is free" rather than as a bug. Callers sum across steps.
 *
 * Read defensively. It is a raw provider payload, so its shape is the
 * provider's to change, and a meter that throws on an unexpected key would
 * take the whole turn down with it.
 */
export function serverWebSearches(usage: LanguageModelUsage | undefined): number {
  const details = (usage?.raw as { server_tool_use_details?: unknown } | undefined)
    ?.server_tool_use_details as { web_search_requests?: unknown } | undefined

  const count = details?.web_search_requests
  return typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
}

/**
 * Running totals for one run and the session it belongs to.
 *
 * Kept separate because §6.5 feeds both the user's session view and the admin's
 * org dashboard, and because the budget ceiling applies at both scopes.
 */
export class Meter {
  private run: CostBuckets = zeroCost
  private session: CostBuckets = zeroCost

  record(cost: CostBuckets): void {
    this.run = addCost(this.run, cost)
    this.session = addCost(this.session, cost)
  }

  /** Called between runs. Session totals deliberately survive. */
  startRun(): void {
    this.run = zeroCost
  }

  runTotal(): CostBuckets {
    return this.run
  }

  sessionTotal(): CostBuckets {
    return this.session
  }
}
