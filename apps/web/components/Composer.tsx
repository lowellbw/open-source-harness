'use client'

import { useRef, useState } from 'react'

export function Composer(props: { onSend: (text: string) => void; disabled: boolean }) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const submit = () => {
    const text = value.trim()
    if (!text || props.disabled) return
    props.onSend(text)
    setValue('')
    if (ref.current) ref.current.style.height = 'auto'
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 pb-6">
      <div
        className="surface flex items-end gap-2 rounded-2xl border p-2 shadow-sm"
        style={{ borderColor: 'var(--border)' }}
      >
        <textarea
          ref={ref}
          value={value}
          rows={1}
          placeholder="Ask for something, or point at a file…"
          disabled={props.disabled}
          onChange={(e) => {
            setValue(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`
          }}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline. The common case should be
            // the cheap one.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          className="max-h-[200px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[14px] outline-none disabled:opacity-50"
        />
        <button
          onClick={submit}
          disabled={props.disabled || !value.trim()}
          className="rounded-xl px-3 py-1.5 text-[13px] font-medium text-white transition-opacity disabled:opacity-30"
          style={{ background: 'var(--accent)' }}
        >
          Send
        </button>
      </div>
      <p className="muted mt-2 text-center text-[11px]">
        Files live in the workspace. Writes and commands ask first.
      </p>
    </div>
  )
}
