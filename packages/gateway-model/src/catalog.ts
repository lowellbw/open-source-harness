import { z } from 'zod'
import { modelRatesSchema, type ModelRates } from '@workspace/protocol'

/**
 * The org model catalog (PLAN-V2 §6.1, §6.2).
 *
 * Three design decisions copied deliberately from the products that do this
 * well:
 *
 *  - an org-wide ceiling with role allowlists beneath it (Claude Enterprise);
 *  - allow/blocklists plus auto-block-new-models (Cursor Enterprise);
 *  - a cheap model that is ALWAYS available, so no configuration can brick the
 *    product for someone.
 *
 * Users pick aliases and tiers, never provider model IDs — which is what lets
 * an admin swap the model behind "Standard" without retraining anyone.
 */

export const tierSchema = z.enum(['light', 'standard', 'premium'])
export type Tier = z.infer<typeof tierSchema>

export const modelEntrySchema = z.object({
  /** User-facing name, decoupled from the provider's ID. */
  alias: z.string().min(1),
  tier: tierSchema,
  provider: z.string().min(1),
  upstreamModel: z.string().min(1),
  contextWindow: z.number().int().positive(),
  rates: modelRatesSchema,
  /** Empty means every role. */
  enabledForRoles: z.array(z.string()).default([]),
  /**
   * The floor. At least one entry must set this, it may not be role-gated, and
   * it should be the cheapest thing in the catalog.
   */
  alwaysAvailable: z.boolean().default(false),
})

export type ModelEntry = z.infer<typeof modelEntrySchema>

export class CatalogError extends Error {
  constructor(
    message: string,
    readonly code: 'no_floor' | 'floor_gated' | 'unknown_alias' | 'not_permitted' | 'duplicate_alias',
  ) {
    super(message)
    this.name = 'CatalogError'
  }
}

export class ModelCatalog {
  private readonly byAlias = new Map<string, ModelEntry>()

  constructor(entries: ModelEntry[]) {
    for (const raw of entries) {
      const entry = modelEntrySchema.parse(raw)
      if (this.byAlias.has(entry.alias)) {
        throw new CatalogError(`Duplicate alias: ${entry.alias}`, 'duplicate_alias')
      }
      this.byAlias.set(entry.alias, entry)
    }

    // These invariants are enforced at construction rather than checked at call
    // time, because the failure they prevent is a user with no usable model —
    // which should be impossible to configure, not merely unlikely.
    const floors = [...this.byAlias.values()].filter((e) => e.alwaysAvailable)
    if (floors.length === 0) {
      throw new CatalogError(
        'Catalog has no always-available model. One entry must be the floor so no role can be left with nothing.',
        'no_floor',
      )
    }
    const gated = floors.find((f) => f.enabledForRoles.length > 0)
    if (gated) {
      throw new CatalogError(
        `Always-available model "${gated.alias}" is role-gated, which defeats the point of a floor.`,
        'floor_gated',
      )
    }
  }

  list(): ModelEntry[] {
    return [...this.byAlias.values()]
  }

  /** What this role may actually pick. Never empty — the floor guarantees it. */
  listForRole(role: string): ModelEntry[] {
    return this.list().filter((e) => this.permits(e, role))
  }

  get(alias: string): ModelEntry {
    const entry = this.byAlias.get(alias)
    if (!entry) throw new CatalogError(`Unknown model alias: ${alias}`, 'unknown_alias')
    return entry
  }

  /**
   * Resolve for use. Gating lives here rather than in the UI because §4 assumes
   * the UI is bypassed.
   */
  resolve(alias: string, role: string): ModelEntry {
    const entry = this.get(alias)
    if (!this.permits(entry, role)) {
      throw new CatalogError(
        `Role "${role}" is not permitted to use model "${alias}"`,
        'not_permitted',
      )
    }
    return entry
  }

  /** The cheapest thing this role can always reach. */
  floor(): ModelEntry {
    // Construction guarantees at least one; pick the cheapest by input rate so
    // adding a second floor cannot silently make the default more expensive.
    return this.list()
      .filter((e) => e.alwaysAvailable)
      .sort((a, b) => a.rates.inputPerMtok - b.rates.inputPerMtok)[0]!
  }

  ratesFor(alias: string): ModelRates {
    return this.get(alias).rates
  }

  private permits(entry: ModelEntry, role: string): boolean {
    if (entry.alwaysAvailable) return true
    if (entry.enabledForRoles.length === 0) return true
    return entry.enabledForRoles.includes(role)
  }
}

/**
 * Default catalog, priced from the live OpenRouter listing on 26 Aug 2026.
 *
 * The 25x spread between the floor and the premium tier is what makes §6.1's
 * "always available" rule nearly free to honour.
 */
export function defaultCatalog(): ModelCatalog {
  return new ModelCatalog([
    {
      alias: 'Light',
      tier: 'light',
      provider: 'openrouter',
      upstreamModel: 'openai/gpt-5.6-luna',
      contextWindow: 1_050_000,
      rates: { inputPerMtok: 0.2, outputPerMtok: 1.2, cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 },
      enabledForRoles: [],
      alwaysAvailable: true,
    },
    {
      alias: 'Standard',
      tier: 'standard',
      provider: 'openrouter',
      upstreamModel: 'anthropic/claude-sonnet-5',
      contextWindow: 1_000_000,
      rates: { inputPerMtok: 2, outputPerMtok: 10, cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 },
      enabledForRoles: [],
      alwaysAvailable: false,
    },
    {
      alias: 'Premium',
      tier: 'premium',
      provider: 'openrouter',
      upstreamModel: 'anthropic/claude-opus-5',
      contextWindow: 1_000_000,
      rates: { inputPerMtok: 5, outputPerMtok: 25, cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 },
      enabledForRoles: ['staff'],
      alwaysAvailable: false,
    },
    {
      alias: 'Fast',
      tier: 'light',
      provider: 'openrouter',
      upstreamModel: 'google/gemini-3.7-flash',
      contextWindow: 1_048_576,
      rates: { inputPerMtok: 0.38, outputPerMtok: 1.88, cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 },
      enabledForRoles: [],
      alwaysAvailable: false,
    },
  ])
}
