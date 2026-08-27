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

export interface Citation {
  url: string
  title: string
}

export interface Step {
  n: number
  activeTools?: string[]
  toolCalls?: number
  durationMs?: number
  costUsd?: number
  done: boolean
}

export interface Subagent {
  id: string
  task: string
  costUsd?: number
  reportChars?: number
  stoppedBy?: string
  done: boolean
}

export interface Turn {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  reasoning: string
  tools: ToolInvocation[]
  sources: Citation[]
  steps: Step[]
  subagents: Subagent[]
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
      {(turn.steps.length > 1 || turn.subagents.length > 0) && (
        <Timeline steps={turn.steps} subagents={turn.subagents} />
      )}
      {turn.tools.map((tool) => (
        <ToolView key={tool.id} tool={tool} />
      ))}
      {turn.text && <Markdown text={turn.text} />}
      {turn.sources.length > 0 && <Sources sources={turn.sources} />}
    </div>
  )
}

/**
 * Pages the model actually read.
 *
 * Rendered as links rather than a tool card because provider-side search leaves
 * no tool call to expand — and because the useful thing about a citation is
 * being able to click it, not being able to inspect the call that produced it.
 */
function Sources({ sources }: { sources: Citation[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {sources.map((source) => (
        <a
          key={source.url}
          href={source.url}
          target="_blank"
          // Untrusted destinations: noopener stops the opened page reaching back
          // through window.opener.
          rel="noopener noreferrer"
          title={source.url}
          className="surface inline-flex max-w-[18rem] items-center gap-1.5 truncate rounded-full border px-2.5 py-1 text-[11px] transition-opacity hover:opacity-70"
          style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
        >
          <span style={{ color: 'var(--accent)' }}>↗</span>
          <span className="truncate">{source.title || hostOf(source.url)}</span>
        </a>
      ))}
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * What the turn actually did, step by step.
 *
 * Hidden for a single-step turn with no subagents, because there is nothing to
 * decompose: one request, and the tool cards above already show what it called.
 * It appears exactly when the turn stopped being a single thing.
 */
function Timeline({ steps, subagents }: { steps: Step[]; subagents: Subagent[] }) {
  const [open, setOpen] = useState(false)
  const totalMs = steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0)
  const totalUsd = steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0)
  const scoutUsd = subagents.reduce((sum, s) => sum + (s.costUsd ?? 0), 0)

  return (
    <div className="surface mb-2 rounded-xl border" style={{ borderColor: 'var(--border)' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px]"
      >
        <span className="mono">{steps.length} steps</span>
        {subagents.length > 0 && (
          <span style={{ color: 'var(--accent)' }}>
            {subagents.length} subagent{subagents.length === 1 ? '' : 's'}
          </span>
        )}
        <span className="muted">{(totalMs / 1000).toFixed(1)}s</span>
        <span className="muted">${(totalUsd + scoutUsd).toFixed(4)}</span>
        <span className="muted ml-auto">{open ? 'hide' : 'trace'}</span>
      </button>

      {open && (
        <div className="border-t px-3 py-2" style={{ borderColor: 'var(--border)' }}>
          {steps.map((step) => (
            <div key={step.n} className="flex items-baseline gap-2 py-0.5 text-[12px]">
              <span className="mono muted w-10 shrink-0">#{step.n + 1}</span>
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: step.done ? 'var(--ok)' : 'var(--muted)' }}
              />
              <span className="muted">
                {step.toolCalls ? `${step.toolCalls} tool call${step.toolCalls === 1 ? '' : 's'}` : 'no tool calls'}
              </span>
              {step.activeTools && (
                <span className="mono muted truncate" title={step.activeTools.join(', ')}>
                  {step.activeTools.length} offered
                </span>
              )}
              <span className="muted ml-auto shrink-0">
                {step.durationMs !== undefined && `${(step.durationMs / 1000).toFixed(2)}s`}
                {step.costUsd !== undefined && ` · $${step.costUsd.toFixed(5)}`}
              </span>
            </div>
          ))}

          {subagents.length > 0 && (
            <div
              className="mt-2 border-t pt-2"
              style={{ borderColor: 'var(--border)' }}
            >
              {subagents.map((agent) => (
                <div key={agent.id} className="py-0.5 text-[12px]">
                  <div className="flex items-baseline gap-2">
                    <span
                      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{
                        background:
                          agent.stoppedBy && agent.stoppedBy !== 'complete'
                            ? 'var(--danger)'
                            : agent.done
                              ? 'var(--ok)'
                              : 'var(--muted)',
                      }}
                    />
                    <span style={{ color: 'var(--accent)' }}>subagent</span>
                    <span className="muted ml-auto shrink-0">
                      {agent.reportChars !== undefined && `${agent.reportChars} chars`}
                      {agent.costUsd !== undefined && ` · $${agent.costUsd.toFixed(5)}`}
                    </span>
                  </div>
                  {/*
                    Clamped. A subagent's task is a full instruction — the
                    document reviewer's is a dozen lines — and printing it whole
                    turns the trace into a wall of prompt. The title attribute
                    keeps the rest reachable.
                  */}
                  <p
                    className="muted pl-4 leading-snug"
                    title={agent.task}
                    style={{
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                  >
                    {agent.task}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
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
export function Markdown({ text }: { text: string }) {
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
