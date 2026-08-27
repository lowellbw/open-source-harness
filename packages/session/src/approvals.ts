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
  /**
   * A class of action this approval belongs to, if the user may consent to the
   * whole class for the session — `python`, `shell`.
   *
   * Present so the UI can offer "allow for this session" as a THIRD choice,
   * beside once and never.
   */
  scope?: string
  resolve: (decision: ApprovalDecision) => void
}

/**
 * `session` means allow this, and everything else in the same scope, until the
 * session ends.
 *
 * It exists because of a real tension in §9. Arbitrary code cannot be judged
 * reversible in advance, so it must be gated; but prompting on every cell of a
 * data analysis is exactly the pattern §9 warns about — it manufactures consent
 * instead of obtaining it, and after the fourth prompt nobody is reading.
 *
 * The honest resolution is to ask once, clearly, for something the user
 * understands as a class of action, rather than repeatedly for instances of it.
 * The grant is per ApprovalGate — one session — and is never written to disk. A
 * persisted grant is a standing permission nobody remembers giving.
 */
export type ApprovalDecision = 'allow' | 'deny' | 'session'

export const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000

export class ApprovalGate {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly grantedScopes = new Set<string>()

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
  request(
    reason: string,
    payload: unknown,
    options: { scope?: string } = {},
  ): Promise<'allow' | 'deny'> {
    // Already consented to this class of action for this session.
    if (options.scope && this.grantedScopes.has(options.scope)) {
      return Promise.resolve('allow')
    }

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
        ...(options.scope ? { scope: options.scope } : {}),
        resolve: (decision) => {
          clearTimeout(timer)
          this.pending.delete(approvalId)
          if (decision === 'session' && options.scope) {
            this.grantedScopes.add(options.scope)
          }
          // `session` is an allow that also remembers.
          resolve(decision === 'deny' ? 'deny' : 'allow')
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
        ...(options.scope ? { scope: options.scope } : {}),
      })
    })
  }

  /** Scopes consented to for this session. For the UI to show and revoke. */
  grantedForSession(): string[] {
    return [...this.grantedScopes]
  }

  /** Withdraws a session grant. The next action in that scope asks again. */
  revokeScope(scope: string): void {
    this.grantedScopes.delete(scope)
  }

  /** Returns false when the id is unknown — already answered, or timed out. */
  resolve(approvalId: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(approvalId)
    if (!entry) return false
    entry.resolve(decision)
    this.emit({
      type: 'approval.resolved',
      runId: 'ui',
      ts: Date.now(),
      approvalId,
      decision: decision === 'deny' ? 'deny' : 'allow',
    })
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
