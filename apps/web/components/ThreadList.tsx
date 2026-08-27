'use client'

import { useCallback, useEffect, useState } from 'react'

export interface ThreadSummary {
  id: string
  title: string
  modelAlias: string
  createdAt: number
  updatedAt: number
  messageCount: number
  costUsd: number
}

/**
 * The sidebar of conversations.
 *
 * Reads from the store rather than from live sessions, so a thread you have not
 * opened since restarting still appears — which is the entire point of having
 * persisted it.
 */
export function ThreadList(props: {
  current: string | null
  version: number
  onSelect: (id: string) => void
  onChanged: () => void
}) {
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const refresh = useCallback(async () => {
    const res = await fetch('/api/threads')
    if (!res.ok) return
    setThreads((await res.json()).threads)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, props.version])

  const create = async () => {
    const res = await fetch('/api/threads', { method: 'POST' })
    if (!res.ok) return
    const { id } = await res.json()
    await refresh()
    props.onSelect(id)
  }

  const remove = async (id: string) => {
    // Deleting a conversation destroys its files too, which is precisely the
    // kind of thing §9 says to confirm rather than merely undo.
    if (!confirm('Delete this thread and everything in its workspace?')) return
    await fetch(`/api/threads/${id}`, { method: 'DELETE' })
    await refresh()
    props.onChanged()
  }

  const commitRename = async (id: string) => {
    const title = draft.trim()
    setRenaming(null)
    if (!title) return
    await fetch(`/api/threads/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    await refresh()
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div
        className="flex items-center justify-between border-b px-3 py-2"
        style={{ borderColor: 'var(--border)' }}
      >
        <span className="text-xs font-medium tracking-wide" style={{ color: 'var(--muted)' }}>
          Threads
        </span>
        <button
          onClick={create}
          className="rounded-md px-2 py-0.5 text-xs transition-colors hover:opacity-80"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          New
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {threads.length === 0 && (
          <p className="px-3 py-3 text-xs" style={{ color: 'var(--muted)' }}>
            No threads yet.
          </p>
        )}

        {threads.map((thread) => {
          const active = thread.id === props.current
          return (
            <div
              key={thread.id}
              className="group flex items-center gap-1 px-2 py-1"
              style={{ background: active ? 'var(--surface)' : 'transparent' }}
            >
              {renaming === thread.id ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => void commitRename(thread.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename(thread.id)
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                  className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-sm outline-none"
                  style={{ borderColor: 'var(--accent)', color: 'var(--text)' }}
                />
              ) : (
                <button
                  onClick={() => props.onSelect(thread.id)}
                  onDoubleClick={() => {
                    setRenaming(thread.id)
                    setDraft(thread.title)
                  }}
                  title={`${thread.messageCount} messages · $${thread.costUsd.toFixed(4)}`}
                  className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-sm"
                  style={{ color: active ? 'var(--text)' : 'var(--muted)' }}
                >
                  {thread.title}
                </button>
              )}

              <button
                onClick={() => void remove(thread.id)}
                aria-label="Delete thread"
                className="shrink-0 rounded px-1.5 py-1 text-xs opacity-0 transition-opacity group-hover:opacity-100"
                style={{ color: 'var(--danger)' }}
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
