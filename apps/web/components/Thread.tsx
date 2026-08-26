'use client'

import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export interface ToolInvocation {
  id: string
  name: string
  args: unknown
  state: 'running' | 'done' | 'error'
  result?: unknown
}

export interface Turn {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  reasoning: string
  tools: ToolInvocation[]
}

export function Thread(props: { turns: Turn[]; status: string }) {
  const endRef = useRef<HTMLDivElement>(null)
  const [stick, setStick] = useState(true)

  useEffect(() => {
    // Only auto-scroll when the reader is already at the bottom; yanking them
    // back while they are reading earlier output is worse than not scrolling.
    if (stick) endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [props.turns, stick])

  if (props.turns.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="max-w-md text-center">
          <h1 className="text-[22px] font-semibold tracking-tight">Your workspace</h1>
          <p className="muted mt-2 text-[14px] leading-relaxed">
            Upload files on the left, then ask for something. The agent can read and write in the
            workspace and run commands — it will ask before anything irreversible.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto"
      onScroll={(e) => {
        const el = e.currentTarget
        setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
      }}
    >
      <div className="mx-auto w-full max-w-3xl px-6 py-6">
        {props.turns.map((turn) => (
          <TurnView key={turn.id} turn={turn} />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  )
}

function TurnView({ turn }: { turn: Turn }) {
  if (turn.role === 'system') {
    return (
      <p className="muted my-4 text-center text-[11px]">{turn.text}</p>
    )
  }

  if (turn.role === 'user') {
    return (
      <div className="mb-5 flex justify-end">
        <div
          className="max-w-[85%] rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed text-white"
          style={{ background: 'var(--accent)' }}
        >
          {turn.text}
        </div>
      </div>
    )
  }

  return (
    <div className="mb-6">
      {turn.reasoning && <Collapsible label="Reasoning" body={turn.reasoning} />}
      {turn.tools.map((tool) => (
        <ToolView key={tool.id} tool={tool} />
      ))}
      {turn.text && <Markdown text={turn.text} />}
    </div>
  )
}

function ToolView({ tool }: { tool: ToolInvocation }) {
  const [open, setOpen] = useState(false)
  const colour =
    tool.state === 'error' ? 'var(--danger)' : tool.state === 'done' ? 'var(--ok)' : 'var(--muted)'

  return (
    <div className="surface mb-2 rounded-xl border" style={{ borderColor: 'var(--border)' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px]"
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: colour }} />
        <span className="mono">{tool.name}</span>
        <span className="muted">{tool.state === 'running' ? 'running…' : tool.state}</span>
        <span className="muted ml-auto">{open ? 'hide' : 'details'}</span>
      </button>
      {open && (
        <div className="border-t px-3 py-2" style={{ borderColor: 'var(--border)' }}>
          <Labelled label="Input" value={tool.args} />
          {tool.result !== undefined && <Labelled label="Output" value={tool.result} />}
        </div>
      )}
    </div>
  )
}

function Labelled({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="muted mb-1 text-[11px] uppercase tracking-wide">{label}</div>
      <pre className="mono max-h-64 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed">
        {typeof value === 'string' ? value : safeJson(value)}
      </pre>
    </div>
  )
}

function Collapsible({ label, body }: { label: string; body: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mb-2">
      <button onClick={() => setOpen((v) => !v)} className="muted text-[12px]">
        {open ? '▾' : '▸'} {label}
      </button>
      {open && (
        <div className="muted mt-1 whitespace-pre-wrap border-l pl-3 text-[12px] leading-relaxed" style={{ borderColor: 'var(--border)' }}>
          {body}
        </div>
      )}
    </div>
  )
}

/**
 * Renders assistant output as Markdown.
 *
 * The product's whole job is producing documents, tables and code, so leaving
 * raw fences and asterisks on screen reads as broken. Styling is applied per
 * element rather than via a typography plugin, to stay inside the muted-border,
 * tight-rhythm look §7 asks for.
 */
function Markdown({ text }: { text: string }) {
  return (
    <div className="text-[14px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: (p) => <p className="mb-3 last:mb-0" {...p} />,
          ul: (p) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0" {...p} />,
          ol: (p) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0" {...p} />,
          h1: (p) => <h1 className="mb-2 mt-4 text-[17px] font-semibold tracking-tight first:mt-0" {...p} />,
          h2: (p) => <h2 className="mb-2 mt-4 text-[15px] font-semibold tracking-tight first:mt-0" {...p} />,
          h3: (p) => <h3 className="mb-2 mt-3 text-[14px] font-semibold tracking-tight first:mt-0" {...p} />,
          a: (p) => <a className="underline underline-offset-2" style={{ color: 'var(--accent)' }} {...p} />,
          blockquote: (p) => (
            <blockquote className="muted mb-3 border-l pl-3" style={{ borderColor: 'var(--border)' }} {...p} />
          ),
          hr: () => <hr className="my-4" style={{ borderColor: 'var(--border)' }} />,
          table: (p) => (
            <div className="mb-3 overflow-x-auto">
              <table className="w-full border-collapse text-[13px]" {...p} />
            </div>
          ),
          th: (p) => (
            <th className="border px-2 py-1 text-left font-medium" style={{ borderColor: 'var(--border)' }} {...p} />
          ),
          td: (p) => <td className="border px-2 py-1" style={{ borderColor: 'var(--border)' }} {...p} />,
          code: ({ className, children, ...rest }) => {
            const fenced = /language-/.test(className ?? '')
            if (!fenced) {
              return (
                <code
                  className="mono rounded px-1 py-0.5 text-[12.5px]"
                  style={{ background: 'color-mix(in srgb, var(--border) 55%, transparent)' }}
                  {...rest}
                >
                  {children}
                </code>
              )
            }
            return (
              <code className="mono block text-[12.5px] leading-relaxed" {...rest}>
                {children}
              </code>
            )
          },
          pre: (p) => (
            <pre
              className="surface mb-3 overflow-x-auto rounded-xl border p-3 last:mb-0"
              style={{ borderColor: 'var(--border)' }}
              {...p}
            />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}
