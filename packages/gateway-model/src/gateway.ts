import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel, LanguageModelUsage } from 'ai'
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
}

export interface ResolvedModel {
  entry: ModelEntry
  model: LanguageModel
  /** Normalised vendor, for the reasoning-artifact rules. */
  vendor: string
}

export class ModelGateway {
  readonly catalog: ModelCatalog
  readonly meter: Meter
  readonly budget: BudgetGuard

  private readonly openrouter: ReturnType<typeof createOpenRouter>

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
    }
  }

  /** The always-available floor, for when a caller's choice is unavailable. */
  resolveFloor(): ResolvedModel {
    const entry = this.catalog.floor()
    return {
      entry,
      model: this.openrouter(entry.upstreamModel),
      vendor: vendorOf(entry.upstreamModel),
    }
  }

  /** Prices a completed request and adds it to the run and session totals. */
  recordUsage(alias: string, usage: LanguageModelUsage | undefined): CostBuckets {
    const cost = priceUsageReport(usage, this.catalog.ratesFor(alias))
    this.budget.record(cost)
    return cost
  }

  totals(): { run: CostBuckets; session: CostBuckets } {
    return { run: this.meter.runTotal(), session: this.meter.sessionTotal() }
  }

  startRun(): void {
    this.meter.startRun()
  }
}

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
