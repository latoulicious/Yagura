import type { Status } from '../api'

// Text pill (visual-design.md §Badges). Drawn only for non-healthy states —
// a healthy row stays calm with just its dot.
const STYLE: Record<Status, string> = {
  healthy: 'text-healthy',
  degraded: 'text-degraded',
  suspended: 'text-offline',
  maintenance: 'text-unknown',
}

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span
      className={`shrink-0 rounded-full bg-current/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${STYLE[status]}`}
    >
      {status}
    </span>
  )
}
