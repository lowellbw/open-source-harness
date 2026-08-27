'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Message, WorkspaceEvent } from '@workspace/protocol'
import { FilePanel } from '@/components/FilePanel'
import { ThreadList } from '@/components/ThreadList'
import { Thread, type Turn } from '@/components/Thread'
import { Composer } from '@/components/Composer'
import { TopBar, type ModelInfo } from '@/components/TopBar'
import { ApprovalPrompt, type Approval } from '@/components/ApprovalPrompt'
import { ConnectorPanel } from '@/components/ConnectorPanel'

export default function Page() {
  const [threadId, setThreadId] = useState<string | null>(null)
  const [threadsVersion, setThreadsVersion] = useState(0)
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
    if (!threadId) return
    const res = await fetch(`/api/models?sessionId=${threadId}`)
    if (!res.ok) return
    const data = await res.json()
    setModels(data.models)
    setCurrent(data.current)
    setCost({ run: data.totals.run.usd, session: data.totals.session.usd })
  }, [threadId])

  useEffect(() => {
    void refreshModels()
  }, [refreshModels])

  /**
   * Land on a thread at startup: the most recent one, or a new one on a first
   * run. Opening to an empty screen with a thread list you have to notice is
   * worse than opening where you left off.
   */
  useEffect(() => {
    if (threadId) return
    void (async () => {
      const res = await fetch('/api/threads')
      const { threads } = res.ok ? await res.json() : { threads: [] }
      if (threads.length > 0) {
        setThreadId(threads[0].id)
        return
      }
      const created = await fetch('/api/threads', { method: 'POST' })
      if (created.ok) {
        setThreadId((await created.json()).id)
        setThreadsVersion((v) => v + 1)
      }
    })()
  }, [threadId])

  /** Render a thread's stored transcript when it is opened. */
  useEffect(() => {
    if (!threadId) return
    let cancelled = false
    void (async () => {
      const res = await fetch(`/api/threads/${threadId}`)
      if (!res.ok || cancelled) return
      const data = (await res.json()) as { messages: Message[] }
      if (cancelled) return
      setTurns(data.messages.map(toTurn).filter((t): t is Turn => t !== null))
      setError(null)
      setApproval(null)
      setFilesVersion((v) => v + 1)
    })()
    return () => {
      cancelled = true
    }
  }, [threadId])

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
            sources: [],
          },
        ])
        break

      case 'model.switched':
        setCurrent(event.to)
        break

      case 'source.cited':
        setTurns((prev) =>
          withLastAssistant(prev, (turn) =>
            // Deduplicated by URL: a model that cites the same page for three
            // separate claims should not produce three identical chips.
            turn.sources.some((s) => s.url === event.url)
              ? turn
              : { ...turn, sources: [...turn.sources, { url: event.url, title: event.title }] },
          ),
        )
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
      if (!threadId) return
      setError(null)
      setBusy(true)

      const userTurn: Turn = { id: `u-${Date.now()}`, role: 'user', text, reasoning: '', tools: [], sources: [] }
      const assistantTurn: Turn = { id: `a-${Date.now()}`, role: 'assistant', text: '', reasoning: '', tools: [], sources: [] }
      setTurns((prev) => [...prev, userTurn, assistantTurn])

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: threadId, message: text, modelAlias: current }),
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
        // Picks up the auto-title derived from the first message, and the
        // updated message count and spend.
        setThreadsVersion((v) => v + 1)
      }
    },
    [applyEvent, current, refreshModels, threadId],
  )

  const resolveApproval = useCallback(async (approvalId: string, decision: 'allow' | 'deny') => {
    await fetch('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: threadId, approvalId, decision }),
    })
    setApproval(null)
    setStatus('thinking')
  }, [threadId])

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
        <aside
          className="hidden w-72 shrink-0 flex-col border-r md:flex"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="min-h-0 flex-[2] overflow-hidden border-b" style={{ borderColor: 'var(--border)' }}>
            <ThreadList
              current={threadId}
              version={threadsVersion}
              onSelect={setThreadId}
              onChanged={() => setThreadId(null)}
            />
          </div>
          <div className="min-h-0 flex-[3]">
            <FilePanel sessionId={threadId ?? ''} version={filesVersion} />
          </div>
          <ConnectorPanel sessionId={threadId ?? ''} />
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

/**
 * Renders a stored message as a turn.
 *
 * Tool calls are not replayed. The store keeps the conversation, not the
 * transcript of every tool invocation, and reconstructing a live-looking tool
 * card from a finished run would imply the run is still happening.
 */
function toTurn(message: Message): Turn | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null
  const text = message.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
  if (!text) return null
  return { id: message.id, role: message.role, text, reasoning: '', tools: [], sources: [] }
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
