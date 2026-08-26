'use client'

export interface ModelInfo {
  alias: string
  tier: string
  contextWindow: number
  inputPerMtok: number
  outputPerMtok: number
  isFloor: boolean
  /** The provider's own ID. Hidden from end users by §6.2; shown here because
   *  whoever is running this locally is the admin and needs to know what is
   *  actually being called. */
  upstreamModel?: string
  provider?: string
}

const LABELS: Record<string, string> = {
  idle: 'Ready',
  thinking: 'Thinking',
  calling_tool: 'Running a tool',
  awaiting_approval: 'Waiting for you',
  compacting: 'Compacting context',
}

export function TopBar(props: {
  models: ModelInfo[]
  current: string
  onSelect: (alias: string) => void
  cost: { run: number; session: number }
  status: keyof typeof LABELS
  disabled: boolean
}) {
  const active = props.models.find((m) => m.alias === props.current)

  return (
    <header
      className="chrome z-10 flex items-center gap-4 border-b px-4 py-2.5"
      style={{ borderColor: 'var(--border)' }}
    >
      <span className="text-[13px] font-semibold tracking-tight">Workspace</span>

      <label className="flex items-center gap-2 text-[13px]">
        <span className="muted">Model</span>
        <select
          value={props.current}
          onChange={(e) => props.onSelect(e.target.value)}
          disabled={props.disabled}
          className="surface rounded-md border px-2 py-1 text-[13px] outline-none disabled:opacity-50"
          style={{ borderColor: 'var(--border)' }}
        >
          {props.models.map((m) => (
            <option key={m.alias} value={m.alias}>
              {m.alias}
              {m.isFloor ? ' · always available' : ''}
            </option>
          ))}
        </select>
      </label>

      {active && (
        <span className="muted hidden items-baseline gap-2 text-[12px] lg:inline-flex">
          {active.upstreamModel && (
            <span className="mono" title="The provider model behind this alias">
              {active.upstreamModel}
            </span>
          )}
          <span>
            ${active.inputPerMtok.toFixed(2)} in / ${active.outputPerMtok.toFixed(2)} out per Mtok
            {' · '}
            {(active.contextWindow / 1000).toFixed(0)}k context
          </span>
        </span>
      )}

      <div className="ml-auto flex items-center gap-4">
        <span className={`text-[12px] ${props.status !== 'idle' ? 'thinking' : 'muted'}`}>
          {LABELS[props.status]}
        </span>
        <span className="mono text-[12px]" title="This turn / this session">
          ${props.cost.run.toFixed(4)}{' '}
          <span className="muted">/ ${props.cost.session.toFixed(4)}</span>
        </span>
      </div>
    </header>
  )
}
