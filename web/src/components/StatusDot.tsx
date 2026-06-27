import type { Tone } from '../api'

// 6px dot, inline-left of a name. Only degraded pulses (2s); the rest stay static.
const COLOR: Record<Tone, string> = {
  healthy: 'bg-healthy',
  degraded: 'bg-degraded',
  offline: 'bg-offline',
  unknown: 'bg-unknown',
}

export function StatusDot({ tone }: { tone: Tone }) {
  return (
    <span
      role="img"
      aria-label={tone}
      className={`size-1.5 shrink-0 rounded-full ${COLOR[tone]} ${tone === 'degraded' ? 'dot-pulse' : ''}`}
    />
  )
}
