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

export type StatusKind = 'active' | 'maintenance' | 'down'

// running = active, paused = intentional maintenance, anything else = down.
export function statusOf(state: string): { kind: StatusKind; label: string } {
  switch (state) {
    case 'running':
      return { kind: 'active', label: 'active' }
    case 'paused':
      return { kind: 'maintenance', label: 'maintenance' }
    default:
      return { kind: 'down', label: 'down' }
  }
}

export type Check = {
  id: number
  kind: string
  target: string
  interval_s: number
  enabled: boolean
  up: boolean | null
  latency_ms: number | null
  since: number | null
  last_down: number | null
}

export type CheckResult = { ts: number; up: boolean; latency_ms: number | null }

export async function fetchChecks(): Promise<Check[]> {
  const r = await fetch('/api/checks')
  if (!r.ok) throw new Error(`checks ${r.status}`)
  return r.json()
}

export async function fetchHistory(id: number, limit = 60): Promise<CheckResult[]> {
  const r = await fetch(`/api/checks/${id}/history?limit=${limit}`)
  if (!r.ok) throw new Error(`history ${r.status}`)
  return r.json()
}

export async function createCheck(body: {
  kind: string
  target: string
  interval_s: number
}): Promise<void> {
  const r = await fetch('/api/checks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`create ${r.status}`)
}

export async function deleteCheck(id: number): Promise<void> {
  const r = await fetch(`/api/checks/${id}`, { method: 'DELETE' })
  if (!r.ok) throw new Error(`delete ${r.status}`)
}

// Coarse relative time for "last incident". Good enough for an ops glance.
export function ago(ts: number | null): string {
  if (ts == null) return '—'
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function fmtMs(v: number | null | undefined): string {
  return v == null ? '—' : `${v} ms`
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
