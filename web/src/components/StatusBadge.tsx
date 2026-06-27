import { statusOf, type StatusKind } from '../api'

// active recedes (muted); maintenance/down carry status color.
const STYLE: Record<StatusKind, string> = {
  active: 'text-text-3 bg-white/5',
  maintenance: 'text-degraded bg-degraded/10',
  down: 'text-offline bg-offline/10',
}

export function StatusBadge({ state }: { state: string }) {
  const s = statusOf(state)
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STYLE[s.kind]}`}
    >
      {s.label}
    </span>
  )
}
