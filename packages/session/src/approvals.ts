import { randomUUID } from 'node:crypto'
import type { WorkspaceEvent } from '@workspace/protocol'

/**
 * The human-in-the-loop gate (PLAN-V2 §9).
 *
 * §9 is specific that approvals are shown for irreversibility only. Prompting
 * on every read trains people to click through without looking, which is
 * strictly worse than not prompting: it manufactures consent instead of
 * obtaining it. Reads and listings run freely; only writes over existing data
 * and shell commands stop here.
 *
 * Lives in a package rather than the web app because the Mac shell's sidecar
 * needs the identical gate. Two implementations of "when do we ask permission"
 * is two chances to get it wrong.
 */

export interface PendingApproval {
  approvalId: string
  toolCallId: string
  reason: string
  irreversible: boolean
  payload: unknown
  resolve: (decision: 'allow' | 'deny') => void
}

export const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000

export class ApprovalGate {
  private readonly pending = new Map<string, PendingApproval>()

  constructor(
    private readonly emit: (event: WorkspaceEvent) => void,
    private readonly timeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS,
  ) {}

  /**
   * Blocks the calling tool until a human answers, or the timeout elapses.
   *
   * An unanswered prompt resolves to `deny`. Silence is not consent, and the
   * alternative — defaulting to allow so the agent isn't blocked — makes the
   * gate decorative.
   */
  request(reason: string, payload: unknown): Promise<'allow' | 'deny'> {
    const approvalId = randomUUID()

    return new Promise<'allow' | 'deny'>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(approvalId)
        resolve('deny')
      }, this.timeoutMs)

      this.pending.set(approvalId, {
        approvalId,
        toolCallId: approvalId,
        reason,
        irreversible: true,
        payload,
        resolve: (decision) => {
          clearTimeout(timer)
          this.pending.delete(approvalId)
          resolve(decision)
        },
      })

      this.emit({
        type: 'approval.requested',
        runId: 'ui',
        ts: Date.now(),
        approvalId,
        toolCallId: approvalId,
        reason,
        irreversible: true,
        payload,
      })
    })
  }

  /** Returns false when the id is unknown — already answered, or timed out. */
  resolve(approvalId: string, decision: 'allow' | 'deny'): boolean {
    const entry = this.pending.get(approvalId)
    if (!entry) return false
    entry.resolve(decision)
    this.emit({ type: 'approval.resolved', runId: 'ui', ts: Date.now(), approvalId, decision })
    return true
  }

  list(): Omit<PendingApproval, 'resolve'>[] {
    return [...this.pending.values()].map(({ resolve: _resolve, ...rest }) => rest)
  }

  /**
   * Denies everything outstanding. Called on shutdown so a tool awaiting an
   * answer that will never come does not hold the process open.
   */
  denyAll(): void {
    for (const entry of [...this.pending.values()]) entry.resolve('deny')
  }
}
