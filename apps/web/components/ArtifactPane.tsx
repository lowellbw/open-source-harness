'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Markdown } from '@/components/Thread'

/**
 * Where you look at what the agent made.
 *
 * The chat is a transcript; a transcript is the wrong place to read a document,
 * judge a diagram, or check a deck. This pane is the other half — the thing
 * being worked on, beside the conversation about it.
 *
 * It follows the last file written rather than requiring a click, because the
 * common case is "make me X" and then wanting to see X. Pinning stops that
 * when you are reading something and the agent is still working.
 */

export type ArtifactKind = 'markdown' | 'frame' | 'image' | 'office' | 'text' | 'unsupported'

export function kindOf(path: string): ArtifactKind {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  if (extension === 'md' || extension === 'markdown') return 'markdown'
  if (extension === 'html' || extension === 'htm' || extension === 'svg') return 'frame'
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'].includes(extension)) return 'image'
  if (['docx', 'pptx', 'xlsx', 'pdf'].includes(extension)) return 'office'
  if (['txt', 'csv', 'json', 'ts', 'js', 'py', 'css', 'yml', 'yaml', 'sh'].includes(extension)) {
    return 'text'
  }
  return 'unsupported'
}

/** Files that are ours rather than the user's work. */
function isInternal(path: string): boolean {
  return path.startsWith('/.checkpoints/') || path.startsWith('/.elided/')
}

export function ArtifactPane(props: {
  sessionId: string
  /** Most recently changed file, from workspace.file.changed. */
  latest: string | null
  onClose: () => void
}) {
  const [path, setPath] = useState<string | null>(null)
  const [pinned, setPinned] = useState(false)
  const [body, setBody] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Follow the agent unless the reader has pinned something.
  useEffect(() => {
    if (pinned || !props.latest || isInternal(props.latest)) return
    if (kindOf(props.latest) === 'unsupported') return
    setPath(props.latest)
  }, [props.latest, pinned])

  const kind = useMemo(() => (path ? kindOf(path) : null), [path])

  const fileUrl = useCallback(
    (download = false) =>
      `/api/files?sessionId=${encodeURIComponent(props.sessionId)}&path=${encodeURIComponent(
        path ?? '',
      )}${download ? '&download=1' : ''}`,
    [props.sessionId, path],
  )

  // Text-ish kinds are fetched and rendered here; frames and images are loaded
  // by the browser from their own URL, which is what keeps the frame's content
  // out of this document entirely.
  useEffect(() => {
    if (!path || (kind !== 'markdown' && kind !== 'text')) {
      setBody(null)
      return
    }
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const res = await fetch(fileUrl())
        const text = res.ok ? await res.text() : null
        if (!cancelled) setBody(text)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [path, kind, fileUrl])

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <p className="muted max-w-xs text-center text-[13px]">
          Documents, images and pages the agent makes appear here.
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: 'var(--border)' }}
      >
        <span className="mono truncate text-[12px]" title={path}>
          {path.split('/').pop()}
        </span>
        <button
          onClick={() => setPinned((v) => !v)}
          title={pinned ? 'Following is off — click to follow the agent again' : 'Pin this file'}
          className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px]"
          style={{ color: pinned ? 'var(--accent)' : 'var(--muted)' }}
        >
          {pinned ? 'pinned' : 'following'}
        </button>
        <a
          href={fileUrl(true)}
          download
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px]"
          style={{ color: 'var(--muted)' }}
        >
          download
        </a>
        <button
          onClick={props.onClose}
          aria-label="Close panel"
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px]"
          style={{ color: 'var(--muted)' }}
        >
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && (
          <p className="muted px-4 py-3 text-[12px]">Loading…</p>
        )}

        {kind === 'markdown' && body !== null && (
          <div className="px-4 py-3">
            <Markdown text={body} />
          </div>
        )}

        {kind === 'text' && body !== null && (
          <pre className="mono overflow-x-auto px-4 py-3 text-[12px] leading-relaxed">{body}</pre>
        )}

        {kind === 'image' && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={fileUrl()} alt={path} className="mx-auto block max-w-full p-3" />
        )}

        {kind === 'frame' && (
          /*
           * `allow-scripts` WITHOUT `allow-same-origin`. Those two together are
           * not a sandbox: the frame gets this origin back and can read its
           * cookies and call its API. Omitting same-origin gives the frame an
           * opaque origin instead, and the route's CSP denies it any network.
           * See apps/web/app/artifact/route.ts.
           */
          <iframe
            key={path}
            src={`/artifact?sessionId=${encodeURIComponent(props.sessionId)}&path=${encodeURIComponent(path)}`}
            sandbox="allow-scripts"
            title={path}
            className="h-full w-full border-0"
          />
        )}

        {kind === 'office' && <OfficePreview sessionId={props.sessionId} path={path} />}

        {kind === 'unsupported' && (
          <p className="muted px-4 py-3 text-[12px]">No preview for this file type.</p>
        )}
      </div>
    </div>
  )
}

/**
 * A rendered page of a document, produced by LibreOffice on the server.
 *
 * There is no honest way to render OOXML in a browser without shipping an
 * office suite to it. Rasterising server-side and showing the picture is what
 * the verification loop does anyway — and looking at the actual rendering is
 * the only check that catches a document which is valid, recalculates, and
 * still looks wrong.
 */
function OfficePreview({ sessionId, path }: { sessionId: string; path: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [pages, setPages] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    setState('loading')
    void (async () => {
      try {
        const res = await fetch(
          `/api/preview?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`,
        )
        if (!res.ok) throw new Error(String(res.status))
        const data = (await res.json()) as { pages: string[] }
        if (cancelled) return
        setPages(data.pages)
        setState('ready')
      } catch {
        if (!cancelled) setState('failed')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, path])

  if (state === 'loading') {
    return <p className="muted px-4 py-3 text-[12px]">Rendering…</p>
  }
  if (state === 'failed') {
    return (
      <p className="muted px-4 py-3 text-[12px]">
        Could not render a preview. The file is still downloadable.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {pages.map((page, index) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={page}
          src={page}
          alt={`Page ${index + 1}`}
          className="w-full rounded border"
          style={{ borderColor: 'var(--border)' }}
        />
      ))}
    </div>
  )
}
