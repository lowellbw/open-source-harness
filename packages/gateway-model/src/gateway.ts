import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { ImageModel, LanguageModel, LanguageModelUsage, ToolSet } from 'ai'
import type { CostBuckets } from '@workspace/protocol'
import { ModelCatalog, defaultCatalog, type ModelEntry } from './catalog.js'
import { Meter, priceUsageReport } from './meter.js'
import { BudgetGuard, defaultBudgetLimits, type BudgetLimits } from './budget.js'

/**
 * The model gateway (PLAN-V2 §6.3).
 *
 * Everything that must not be bypassable lives here rather than in the UI:
 * role gating, spend ceilings, and metering. §4 assumes the UI is bypassed, so
 * a caller reaching the gateway directly gets the same answers.
 *
 * Inference is pass-through. Nothing in this file may bill model tokens to us —
 * the meter measures the org's spend on the org's own key. It exists for the
 * user's visibility and the ceiling, never for resale.
 */

export interface ModelGatewayOptions {
  catalog?: ModelCatalog
  /** OpenRouter key. Falls back to OPENROUTER_API_KEY. */
  apiKey?: string
  limits?: BudgetLimits
  /**
   * Attach the provider's server-side web search to every request.
   *
   * Used when no dedicated search API is configured. It costs no extra
   * credential and adds no sub-processor to disclose (§6.4), because the search
   * happens inside a request already going to the model provider. It still
   * surfaces as a tool call in the stream, so the trace shows the search
   * happened and the meter can price it.
   */
  webSearch?: { maxResults?: number; engine?: 'auto' | 'native' | 'exa' }
}

export interface ResolvedModel {
  entry: ModelEntry
  model: LanguageModel
  /** Normalised vendor, for the reasoning-artifact rules. */
  vendor: string
  /**
   * Tools the PROVIDER runs, not us.
   *
   * Kept separate from the agent's own toolset because they behave differently:
   * there is no `execute` to call, the work happens server-side, and they are
   * billed per call rather than per token. The agent merges them in but counts
   * them apart.
   */
  providerTools: ToolSet
}

export class ModelGateway {
  readonly catalog: ModelCatalog
  readonly meter: Meter
  readonly budget: BudgetGuard

  private readonly openrouter: ReturnType<typeof createOpenRouter>
  private readonly providerTools: ToolSet

  constructor(options: ModelGatewayOptions = {}) {
    this.catalog = options.catalog ?? defaultCatalog()
    this.meter = new Meter()
    this.budget = new BudgetGuard(this.meter, options.limits ?? defaultBudgetLimits)

    const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY
    if (!apiKey) {
      throw new Error(
        'No model provider key. Set OPENROUTER_API_KEY, or pass apiKey. ' +
          'Keys are never held by the agent or the sandbox — only here.',
      )
    }
    this.openrouter = createOpenRouter({ apiKey })

    this.providerTools = options.webSearch
      ? {
          // The name reaches the model, and it is also what the agent matches
          // on to count searches for the meter.
          [PROVIDER_WEB_SEARCH]: this.openrouter.tools.webSearch({
            maxResults: options.webSearch.maxResults ?? 5,
            engine: options.webSearch.engine ?? 'auto',
          }),
        }
      : {}
  }

  /** Names of provider-run tools, for metering and for `activeTools`. */
  providerToolNames(): string[] {
    return Object.keys(this.providerTools)
  }

  /**
   * Resolve an alias for a role, enforcing gating and the spend ceiling.
   *
   * The budget check happens here, not at the UI, and before the call rather
   * than after — see BudgetGuard for why overshoot is bounded by one step.
   */
  resolve(alias: string, role: string): ResolvedModel {
    this.budget.assertCanProceed()
    const entry = this.catalog.resolve(alias, role)
    return {
      entry,
      model: this.openrouter(entry.upstreamModel),
      vendor: vendorOf(entry.upstreamModel),
      providerTools: this.providerTools,
    }
  }

  /**
   * An image model, routed through the same provider as everything else.
   *
   * On the gateway rather than reachable from a tool so image spend cannot
   * bypass the meter. Not in the catalog because the catalog is about
   * user-facing aliases and role gating for CHAT models; an image model is
   * chosen by the tool, not by the person.
   */
  imageModel(modelId: string): ImageModel {
    return this.openrouter.imageModel(modelId)
  }

  /** The always-available floor, for when a caller's choice is unavailable. */
  resolveFloor(): ResolvedModel {
    const entry = this.catalog.floor()
    return {
      entry,
      model: this.openrouter(entry.upstreamModel),
      vendor: vendorOf(entry.upstreamModel),
      providerTools: this.providerTools,
    }
  }

  /**
   * Prices a completed request and adds it to the run and session totals.
   *
   * `webSearches` is passed in rather than read from usage because the
   * provider's usage accounting has no field for server tool calls — the agent
   * counts them off the tool stream. Omitting them would understate the bill by
   * more than the tokens themselves on a search-heavy turn.
   */
  recordUsage(
    alias: string,
    usage: LanguageModelUsage | undefined,
    extras: { webSearches?: number } = {},
  ): CostBuckets {
    const cost = priceUsageReport(usage, this.catalog.ratesFor(alias), extras)
    this.budget.record(cost)
    return cost
  }

  /**
   * Prices usage WITHOUT adding it to the totals.
   *
   * For the per-step trace: each step is priced as it finishes, and the turn's
   * usage is recorded once at the end. Recording per step as well would double
   * every number the user sees.
   */
  priceOnly(
    alias: string,
    usage: LanguageModelUsage | undefined,
    extras: { webSearches?: number } = {},
  ): CostBuckets {
    return priceUsageReport(usage, this.catalog.ratesFor(alias), extras)
  }

  totals(): { run: CostBuckets; session: CostBuckets } {
    return { run: this.meter.runTotal(), session: this.meter.sessionTotal() }
  }

  startRun(): void {
    this.meter.startRun()
  }
}

/** The tool name the provider's server-side search is registered under. */
export const PROVIDER_WEB_SEARCH = 'web_search'

/**
 * Vendor from a gateway model ID such as "anthropic/claude-sonnet-5".
 *
 * The reasoning-artifact rules key on vendor, and a gateway model ID is the
 * only place that information survives — which is the tax for routing
 * everything through one endpoint.
 */
export function vendorOf(upstreamModel: string): string {
  return upstreamModel.includes('/') ? upstreamModel.split('/')[0]!.toLowerCase() : upstreamModel.toLowerCase()
}
