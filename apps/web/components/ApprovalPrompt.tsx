'use client'

export interface Approval {
  approvalId: string
  reason: string
  payload: unknown
  irreversible: boolean
}

/**
 * Shown only for irreversible actions (§9).
 *
 * The payload is displayed rather than summarised: approving something you
 * cannot see is not consent. Deny is the default action — it is focused, and
 * an unanswered prompt times out as a denial server-side.
 */
export function ApprovalPrompt(props: {
  approval: Approval
  onResolve: (approvalId: string, decision: 'allow' | 'deny') => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6">
      <div
        className="surface w-full max-w-lg rounded-2xl border p-5 shadow-xl"
        style={{ borderColor: 'var(--border)' }}
      >
        <h2 className="text-[15px] font-semibold tracking-tight">Approve this action?</h2>
        <p className="mt-1 text-[13px]">{props.approval.reason}</p>

        <pre className="mono mt-3 max-h-48 overflow-auto rounded-lg border p-3 text-[11px] leading-relaxed" style={{ borderColor: 'var(--border)' }}>
          {JSON.stringify(props.approval.payload, null, 2)}
        </pre>

        <p className="muted mt-3 text-[11px]">
          This cannot be undone. Nothing happens until you choose.
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <button
            autoFocus
            onClick={() => props.onResolve(props.approval.approvalId, 'deny')}
            className="surface rounded-lg border px-3 py-1.5 text-[13px]"
            style={{ borderColor: 'var(--border)' }}
          >
            Deny
          </button>
          <button
            onClick={() => props.onResolve(props.approval.approvalId, 'allow')}
            className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-white"
            style={{ background: 'var(--danger)' }}
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  )
}
