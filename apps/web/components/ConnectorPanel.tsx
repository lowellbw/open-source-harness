'use client'

import { useCallback, useEffect, useState } from 'react'

interface PendingTool {
  name: string
  qualifiedName: string
  serverId: string
  description: string
  status: 'unapproved' | 'changed'
}

interface McpStatus {
  servers: { id: string; era: string; protocolVersion?: string }[]
  errors: { id: string; message: string }[]
  approved: { name: string; serverId: string }[]
  pending: PendingTool[]
}

/**
 * Connector status and the approval surface for MCP tools.
 *
 * A tool is not callable until someone has read what it claims to do. The
 * description is shown in full rather than truncated, because the description
 * IS the thing being approved — it is what the model will act on.
 */
export function ConnectorPanel(props: { sessionId: string }) {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/mcp?sessionId=${props.sessionId}`)
    if (res.ok) setStatus(await res.json())
  }, [props.sessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const approve = async (qualifiedName?: string) => {
    setBusy(true)
    try {
      await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: props.sessionId, qualifiedName, all: !qualifiedName }),
      })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  // Nothing configured is a valid state, not an error — say nothing.
  if (!status || (status.servers.length === 0 && status.errors.length === 0)) return null

  return (
    <div className="border-t px-3 py-2.5" style={{ borderColor: 'var(--border)' }}>
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold tracking-tight">Connectors</span>
        <span className="muted ml-auto text-[11px]">
          {status.approved.length} available
        </span>
      </div>

      {status.servers.map((server) => (
        <div key={server.id} className="muted mt-1.5 flex items-center gap-2 text-[11px]">
          <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: 'var(--ok)' }} />
          <span className="truncate">{server.id}</span>
          <span className="ml-auto shrink-0">{server.era}</span>
        </div>
      ))}

      {status.errors.map((error) => (
        <div key={error.id} className="mt-1.5 text-[11px]" style={{ color: 'var(--danger)' }}>
          {error.id}: {error.message.slice(0, 80)}
        </div>
      ))}

      {status.pending.length > 0 && (
        <div className="mt-3">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium">
              {status.pending.length} need{status.pending.length === 1 ? 's' : ''} review
            </span>
            <button
              onClick={() => void approve()}
              disabled={busy}
              className="muted ml-auto text-[11px] disabled:opacity-50"
            >
              Approve all
            </button>
          </div>

          {status.pending.map((toolItem) => (
            <div
              key={toolItem.qualifiedName}
              className="surface mt-2 rounded-lg border p-2"
              style={{
                borderColor: toolItem.status === 'changed' ? 'var(--danger)' : 'var(--border)',
              }}
            >
              <div className="flex items-center gap-2">
                <span className="mono truncate text-[11px]">{toolItem.name}</span>
                {toolItem.status === 'changed' && (
                  <span className="shrink-0 text-[10px]" style={{ color: 'var(--danger)' }}>
                    changed
                  </span>
                )}
              </div>
              <p className="muted mt-1 text-[11px] leading-relaxed">{toolItem.description}</p>
              {toolItem.status === 'changed' && (
                <p className="mt-1 text-[10px]" style={{ color: 'var(--danger)' }}>
                  This tool&rsquo;s description changed after you approved it. Read it again before
                  allowing it.
                </p>
              )}
              <button
                onClick={() => void approve(toolItem.qualifiedName)}
                disabled={busy}
                className="mt-1.5 text-[11px] disabled:opacity-50"
                style={{ color: 'var(--accent)' }}
              >
                Approve
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
