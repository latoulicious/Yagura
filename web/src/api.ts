export type Container = {
  id: string
  name: string
  state: string
  status: string
  cpu: number | null
  mem: number | null
  mem_limit: number | null
}

export type Sample = { ts: number; source: string; metric: string; value: number }

export async function fetchOverview(): Promise<Container[]> {
  const r = await fetch('/api/overview')
  if (!r.ok) throw new Error(`overview ${r.status}`)
  const j = await r.json()
  return j.containers ?? []
}

export type Health = 'healthy' | 'degraded' | 'offline' | 'unknown'

// Calm-until-broken: only non-running states carry a status color.
export function health(state: string): Health {
  switch (state) {
    case 'running':
      return 'healthy'
    case 'restarting':
    case 'paused':
      return 'degraded'
    case 'exited':
    case 'dead':
    case 'removing':
      return 'offline'
    default:
      return 'unknown'
  }
}

export const HEALTH_TEXT: Record<Health, string> = {
  healthy: 'text-healthy',
  degraded: 'text-degraded',
  offline: 'text-offline',
  unknown: 'text-unknown',
}

export function fmtPct(v: number | null | undefined): string {
  return v == null ? '—' : `${v.toFixed(1)}%`
}

export function fmtBytes(v: number | null | undefined): string {
  if (v == null) return '—'
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let i = 0
  let n = v
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`
}
