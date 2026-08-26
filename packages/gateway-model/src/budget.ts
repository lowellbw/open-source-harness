import type { CostBuckets } from '@workspace/protocol'
import type { Meter } from './meter.js'

/**
 * Hard spend ceiling, enforced in the gateway.
 *
 * Two reasons this is not a UI concern and not a prompt instruction:
 *
 *  - §4 requires quotas be enforced where the UI can be bypassed.
 *  - A spend limit is exactly the class of rule that must live outside the
 *    model's context. The compaction research is clear that in-context
 *    constraints decay; a ceiling the agent cannot argue with does not.
 *
 * Also immediately practical: the OpenRouter key this is developed against has
 * no upstream spend limit set, and an agent loop that compacts twice over a
 * large document is precisely the shape of thing that runs away.
 */

export interface BudgetLimits {
  perRunUsd: number
  perSessionUsd: number
}

export const defaultBudgetLimits: BudgetLimits = {
  perRunUsd: 5,
  perSessionUsd: 15,
}

export class BudgetExceededError extends Error {
  constructor(
    readonly scope: 'run' | 'session',
    readonly spentUsd: number,
    readonly limitUsd: number,
  ) {
    super(
      `Budget exceeded for ${scope}: $${spentUsd.toFixed(4)} of $${limitUsd.toFixed(2)}. Run halted.`,
    )
    this.name = 'BudgetExceededError'
  }
}

export class BudgetGuard {
  constructor(
    private readonly meter: Meter,
    private readonly limits: BudgetLimits = defaultBudgetLimits,
  ) {}

  /**
   * Call before every model request.
   *
   * Checking before rather than after is what bounds the damage: a request's
   * cost cannot be known until it returns, so the ceiling is enforced by
   * refusing the *next* call once it is reached. Overshoot is therefore bounded
   * by one step's cost, which is the tightest guarantee available without
   * pre-flight estimation. Callers wanting a tighter bound should set a lower
   * ceiling, not expect this to predict the future.
   */
  assertCanProceed(): void {
    const run = this.meter.runTotal().usd
    if (run >= this.limits.perRunUsd) {
      throw new BudgetExceededError('run', run, this.limits.perRunUsd)
    }
    const session = this.meter.sessionTotal().usd
    if (session >= this.limits.perSessionUsd) {
      throw new BudgetExceededError('session', session, this.limits.perSessionUsd)
    }
  }

  /** True when the next `assertCanProceed` would throw. */
  isTripped(): boolean {
    try {
      this.assertCanProceed()
      return false
    } catch {
      return true
    }
  }

  remaining(): { runUsd: number; sessionUsd: number } {
    return {
      runUsd: Math.max(0, this.limits.perRunUsd - this.meter.runTotal().usd),
      sessionUsd: Math.max(0, this.limits.perSessionUsd - this.meter.sessionTotal().usd),
    }
  }

  /** Fraction of the tighter of the two ceilings consumed, for soft-limit warnings. */
  utilisation(): number {
    const run = this.meter.runTotal().usd / this.limits.perRunUsd
    const session = this.meter.sessionTotal().usd / this.limits.perSessionUsd
    return Math.min(1, Math.max(run, session))
  }

  record(cost: CostBuckets): void {
    this.meter.record(cost)
  }
}
