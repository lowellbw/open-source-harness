'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

interface Entry {
  name: string
  path: string
  type: 'file' | 'directory' | 'other'
  size: number
}

export function FilePanel(props: { sessionId: string; version: number }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [path, setPath] = useState('/')
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    // No thread, nothing to list. Asking anyway used to create one.
    if (!props.sessionId) return
    const res = await fetch(
      `/api/files?sessionId=${encodeURIComponent(props.sessionId)}&path=${encodeURIComponent(path)}`,
    )
    if (!res.ok) return
    const data = await res.json()
    setEntries(data.entries)
  }, [props.sessionId, path])

  // `version` is bumped by the page whenever the agent touches the filesystem,
  // so the panel reflects the agent's work without polling.
  useEffect(() => {
    void refresh()
  }, [refresh, props.version])

  const upload = async (files: FileList | null) => {
    if (!files?.length || !props.sessionId) return
    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        const form = new FormData()
        form.set('sessionId', props.sessionId)
        form.set('file', file)
        await fetch('/api/files', { method: 'POST', body: form })
      }
      await refresh()
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const up = () => {
    if (path === '/') return
    const parts = path.split('/').filter(Boolean)
    parts.pop()
    setPath('/' + parts.join('/'))
  }

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        void upload(e.dataTransfer.files)
      }}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2.5" style={{ borderColor: 'var(--border)' }}>
        <span className="text-[13px] font-semibold tracking-tight">Files</span>
        <button
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="muted ml-auto text-[12px] disabled:opacity-50"
        >
          {uploading ? 'Uploading…' : 'Upload'}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => void upload(e.target.files)}
        />
      </div>

      <div className="flex items-center gap-2 px-3 py-1.5">
        <button onClick={up} disabled={path === '/'} className="muted text-[12px] disabled:opacity-30">
          ↑
        </button>
        <span className="mono truncate text-[11px]">{path}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {entries.length === 0 && (
          <p className="muted px-2 py-6 text-center text-[12px] leading-relaxed">
            Empty. Drop files here, or ask the agent to create some.
          </p>
        )}
        {entries.map((entry) => (
          <div key={entry.path} className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] hover:bg-black/5 dark:hover:bg-white/5">
            {entry.type === 'directory' ? (
              <button onClick={() => setPath(entry.path)} className="flex-1 truncate text-left">
                {entry.name}/
              </button>
            ) : (
              <>
                <span className="flex-1 truncate">{entry.name}</span>
                <span className="muted shrink-0 text-[11px]">{formatSize(entry.size)}</span>
                <a
                  href={`/api/files?sessionId=${props.sessionId}&path=${encodeURIComponent(entry.path)}&download=1`}
                  className="muted shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                  title="Download"
                >
                  ↓
                </a>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
