'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceEvent } from '@workspace/protocol'
import { FilePanel } from '@/components/FilePanel'
import { Thread, type Turn } from '@/components/Thread'
import { Composer } from '@/components/Composer'
import { TopBar, type ModelInfo } from '@/components/TopBar'
import { ApprovalPrompt, type Approval } from '@/components/ApprovalPrompt'

const SESSION_ID = 'default'

export default function Page() {
  const [turns, setTurns] = useState<Turn[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [current, setCurrent] = useState('Standard')
  const [cost, setCost] = useState({ run: 0, session: 0 })
  const [status, setStatus] = useState<'idle' | 'thinking' | 'calling_tool' | 'awaiting_approval' | 'compacting'>('idle')
  const [approval, setApproval] = useState<Approval | null>(null)
  const [busy, setBusy] = useState(false)
  const [filesVersion, setFilesVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const refreshModels = useCallback(async () => {
    const res = await fetch(`/api/models?sessionId=${SESSION_ID}`)
    if (!res.ok) return
    const data = await res.json()
    setModels(data.models)
    setCurrent(data.current)
    setCost({ run: data.totals.run.usd, session: data.totals.session.usd })
  }, [])

  useEffect(() => {
    void refreshModels()
  }, [refreshModels])

  const applyEvent = useCallback((event: WorkspaceEvent) => {
    switch (event.type) {
      case 'status':
        setStatus(event.state)
        break

      case 'message.delta':
        setTurns((prev) => appendDelta(prev, event.messageId, event.delta))
        break

      case 'reasoning.delta':
        setTurns((prev) => appendReasoning(prev, event.messageId, event.delta))
        break

      case 'tool.call.started':
        setTurns((prev) =>
          withLastAssistant(prev, (turn) => ({
            ...turn,
            tools: [
              ...turn.tools,
              { id: event.toolCallId, name: event.name, args: event.args, state: 'running' as const },
            ],
          })),
        )
        break

      case 'tool.call.finished':
        setTurns((prev) =>
          withLastAssistant(prev, (turn) => ({
            ...turn,
            tools: turn.tools.map((t) =>
              t.id === event.toolCallId
                ? { ...t, state: event.isError ? ('error' as const) : ('done' as const), result: event.result }
                : t,
            ),
          })),
        )
        setFilesVersion((v) => v + 1)
        break

      case 'approval.requested':
        setApproval({
          approvalId: event.approvalId,
          reason: event.reason,
          payload: event.payload,
          irreversible: event.irreversible,
        })
        setStatus('awaiting_approval')
        break

      case 'approval.resolved':
        setApproval(null)
        break

      case 'context.compacted':
        setTurns((prev) => [
          ...prev,
          {
            id: `compact-${event.ts}`,
            role: 'system',
            text: `Context compacted (${event.strategy}): ${event.beforeMessages} messages / ${event.beforeTokens.toLocaleString()} tokens → ${event.afterMessages} / ${event.afterTokens.toLocaleString()}`,
            reasoning: '',
            tools: [],
          },
        ])
        break

      case 'model.switched':
        setCurrent(event.to)
        break

      case 'cost.updated':
        setCost({ run: event.run.usd, session: event.session.usd })
        break

      case 'run.error':
        setError(event.message)
        break

      case 'workspace.file.changed':
        setFilesVersion((v) => v + 1)
        break
    }
  }, [])

  const send = useCallback(
    async (text: string) => {
      setError(null)
      setBusy(true)

      const userTurn: Turn = { id: `u-${Date.now()}`, role: 'user', text, reasoning: '', tools: [] }
      const assistantTurn: Turn = { id: `a-${Date.now()}`, role: 'assistant', text: '', reasoning: '', tools: [] }
      setTurns((prev) => [...prev, userTurn, assistantTurn])

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: SESSION_ID, message: text, modelAlias: current }),
        })
        if (!res.body) throw new Error('No response stream')

        // The assistant turn is identified by the first message.started we see,
        // so deltas land on the right bubble even across tool steps.
        let boundId: string | null = null
        await readSse(res.body, (event) => {
          if (event.type === 'message.started' && !boundId) {
            boundId = event.messageId
            setTurns((prev) =>
              prev.map((t) => (t.id === assistantTurn.id ? { ...t, id: event.messageId } : t)),
            )
          }
          applyEvent(event)
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
        setStatus('idle')
        void refreshModels()
        setFilesVersion((v) => v + 1)
      }
    },
    [applyEvent, current, refreshModels],
  )

  const resolveApproval = useCallback(async (approvalId: string, decision: 'allow' | 'deny') => {
    await fetch('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID, approvalId, decision }),
    })
    setApproval(null)
    setStatus('thinking')
  }, [])

  return (
    <div className="flex h-dvh flex-col">
      <TopBar
        models={models}
        current={current}
        onSelect={setCurrent}
        cost={cost}
        status={status}
        disabled={busy}
      />

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-72 shrink-0 border-r md:block" style={{ borderColor: 'var(--border)' }}>
          <FilePanel sessionId={SESSION_ID} version={filesVersion} />
        </aside>

        <main className="flex min-h-0 flex-1 flex-col">
          <Thread turns={turns} status={status} />
          {error && (
            <div className="mx-auto w-full max-w-3xl px-6">
              <p className="mb-2 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>
                {error}
              </p>
            </div>
          )}
          <Composer onSend={send} disabled={busy} />
        </main>
      </div>

      {approval && <ApprovalPrompt approval={approval} onResolve={resolveApproval} />}
    </div>
  )
}

/** Minimal SSE reader — the payloads are single-line JSON by construction. */
async function readSse(body: ReadableStream<Uint8Array>, onEvent: (e: WorkspaceEvent) => void) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const chunks = buffer.split('\n\n')
    buffer = chunks.pop() ?? ''

    for (const chunk of chunks) {
      const line = chunk.trim()
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      try {
        const parsed = JSON.parse(payload)
        if (parsed.type === '__done') return
        onEvent(parsed as WorkspaceEvent)
      } catch {
        // A malformed frame must not kill the stream.
      }
    }
  }
}

function withLastAssistant(turns: Turn[], fn: (t: Turn) => Turn): Turn[] {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.role === 'assistant') {
      const next = [...turns]
      next[i] = fn(turns[i]!)
      return next
    }
  }
  return turns
}

function appendDelta(turns: Turn[], messageId: string, delta: string): Turn[] {
  const index = turns.findIndex((t) => t.id === messageId)
  if (index === -1) return withLastAssistant(turns, (t) => ({ ...t, text: t.text + delta }))
  const next = [...turns]
  next[index] = { ...turns[index]!, text: turns[index]!.text + delta }
  return next
}

function appendReasoning(turns: Turn[], messageId: string, delta: string): Turn[] {
  const index = turns.findIndex((t) => t.id === messageId)
  if (index === -1) return withLastAssistant(turns, (t) => ({ ...t, reasoning: t.reasoning + delta }))
  const next = [...turns]
  next[index] = { ...turns[index]!, reasoning: turns[index]!.reasoning + delta }
  return next
}
