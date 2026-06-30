export type ContainerEvent = { ts: number; kind: string; payload: string }

export type Container = {
  id: string
  name: string
  state: string
  status: string
  cpu: number | null
  mem: number | null
  mem_limit: number | null
  created: number
  events: ContainerEvent[]
}

export type Sample = { ts: number; source: string; metric: string; value: number }

// Live container metrics + rolling sparkline buffers, keyed by container id. Owned
// by App (survives tab switches), consumed by Overview.
export type Live = Record<string, { cpu?: number; mem?: number; mem_limit?: number }>
export type Bufs = Record<string, { cpu: number[]; mem: number[] }>

// Host metrics keyed by metric name (cpu, mem_used, …) — the API contract is the
// key set, not a rigid struct, so new curated metrics don't churn the type.
export type Host = Record<string, number>
export type HostSeries = Record<string, { ts: number; value: number }[]>

// Host alert thresholds (mirror alert.rs DISK_LIMIT_PCT / RAM_LIMIT_PCT) — a
// breached metric flips to the offline tint. Shared by HostMetrics + Footer.
export const RAM_LIMIT = 90
export const DISK_LIMIT = 85

export type Overview = { host: string; containers: Container[] }

export async function fetchOverview(): Promise<Overview> {
  const r = await fetch('/api/overview')
  if (!r.ok) throw new Error(`overview ${r.status}`)
  const j = await r.json()
  return { host: j.host ?? '', containers: j.containers ?? [] }
}

export type Route = { hostname: string; target: string; up: boolean; ts: number }
export type Beat = { name: string; deadline_s: number; last_ts: number | null; missing: boolean }
export type Version = { label: string; version: string | null; commit: string | null; ok: boolean }

export async function fetchDrift(): Promise<Route[]> {
  const r = await fetch('/api/drift')
  if (!r.ok) throw new Error(`drift ${r.status}`)
  return r.json()
}

export async function fetchBeats(): Promise<Beat[]> {
  const r = await fetch('/api/beats')
  if (!r.ok) throw new Error(`beats ${r.status}`)
  return r.json()
}

export async function fetchVersions(): Promise<Version[]> {
  const r = await fetch('/api/versions')
  if (!r.ok) throw new Error(`versions ${r.status}`)
  return r.json()
}

export type Release = {
  env: string
  service: string
  commit: string
  tag: string
  deployed_at: number | null
  status: string
}

// ok:false = Tsugi agent unreachable (down / RPC unimplemented), distinct from an
// empty list — the Deploy tab renders the two differently. deploy_enabled gates the
// action buttons (mirrors YAGURA_DEPLOY_ENABLED on the server).
export type Releases = { ok: boolean; releases: Release[]; deploy_enabled: boolean; reason?: string }

export async function fetchReleases(): Promise<Releases> {
  const r = await fetch('/api/releases')
  if (!r.ok) throw new Error(`releases ${r.status}`)
  return r.json()
}

export type DeployLine = { ts: number; stream: string; text: string }

// POST a deploy/rollback and stream its SSE response. EventSource is GET-only, so we
// read the POST body and parse SSE frames ourselves. Resolves when the stream ends.
export async function streamDeploy(
  path: '/api/deploy' | '/api/rollback',
  body: { service: string; env: string; commit: string },
  onLine: (l: DeployLine) => void,
): Promise<void> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok || !r.body) throw new Error(`deploy ${r.status}`)
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  // A frame's data: lines hold one JSON DeployLine; keep-alive comment frames have none.
  const emit = (frame: string) => {
    const data = frame
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n')
    if (!data) return
    try {
      onLine(JSON.parse(data))
    } catch {
      // ignore non-JSON frames
    }
  }
  // SSE frames are blank-line delimited; normalize CRLF so both line endings split.
  const drain = () => {
    buf = buf.replace(/\r\n/g, '\n')
    let sep
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      emit(buf.slice(0, sep))
      buf = buf.slice(sep + 2)
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    drain()
  }
  buf += decoder.decode() // flush any buffered multibyte tail
  drain()
  if (buf.trim()) emit(buf) // a final frame with no trailing blank line
}

export async function fetchHostHistory(): Promise<HostSeries> {
  const r = await fetch('/api/host/history')
  if (!r.ok) throw new Error(`host history ${r.status}`)
  return r.json()
}

// Percent used, or undefined when there's no reading yet — so the UI shows "—"
// (via fmtPct) instead of a misleading 0.0% before data arrives.
export function pct(used: number | undefined, total: number | undefined): number | undefined {
  return used != null && total ? (used / total) * 100 : undefined
}

export type Status = 'healthy' | 'degraded' | 'suspended' | 'maintenance'

// Container state → badge status. Calm-until-broken: running shows no badge.
export function status(state: string): Status {
  switch (state) {
    case 'running':
      return 'healthy'
    case 'restarting':
      return 'degraded'
    case 'paused':
      return 'maintenance'
    default:
      return 'suspended' // exited, dead, removing, created, …
  }
}

// Dot color tone — the semantic palette (status.* tokens in visual-design.md).
export type Tone = 'healthy' | 'degraded' | 'offline' | 'unknown'

export function tone(s: Status): Tone {
  return s === 'suspended' ? 'offline' : s === 'maintenance' ? 'unknown' : s
}

// Chart/value tint by load (visual-design §Charts): >90% offline, >70% degraded,
// else calm text-tertiary. Null (no reading) stays calm.
export function toneForPct(pct: number | null | undefined): Tone {
  if (pct == null) return 'healthy'
  if (pct > 90) return 'offline'
  if (pct > 70) return 'degraded'
  return 'healthy'
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

export function fmtBytesPerSec(v: number | null | undefined): string {
  return v == null ? '—' : `${fmtBytes(v)}/s`
}

// Coarse uptime — days/hours is the glance; seconds precision is noise here.
export function fmtUptime(secs: number | null | undefined): string {
  if (secs == null) return '—'
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function fmtLoad(v: number | null | undefined): string {
  return v == null ? '—' : v.toFixed(2)
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
