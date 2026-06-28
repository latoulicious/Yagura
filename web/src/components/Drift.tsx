import { useEffect, useState } from 'react'
import {
  ago,
  fetchBeats,
  fetchDrift,
  fetchVersions,
  fmtUptime,
  type Beat,
  type Route,
  type Version,
} from '../api'
import { StatusDot } from './StatusDot'

// Poll one endpoint on the shared 10s cadence. Fetchers are module-stable.
function usePoll<T>(fetcher: () => Promise<T>, initial: T): T {
  const [data, setData] = useState<T>(initial)
  useEffect(() => {
    let on = true
    const load = () =>
      fetcher()
        .then((d) => on && setData(d))
        .catch(() => {})
    load()
    const t = setInterval(load, 10000)
    return () => {
      on = false
      clearInterval(t)
    }
  }, [fetcher])
  return data
}

// Red pill for the broken state of a row (orphan / missing / unreachable).
function Pill({ children }: { children: string }) {
  return (
    <span className="rounded-full bg-current/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-offline">
      {children}
    </span>
  )
}

function Section({ label, empty, count, children }: {
  label: string
  empty: string
  count: number
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="px-4 pb-1 pt-6 text-xs uppercase tracking-[0.08em] text-text-3">{label}</div>
      {count === 0 ? <div className="px-4 py-2 text-sm text-text-3">{empty}</div> : children}
    </div>
  )
}

const Row = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-10 items-center gap-4 border-b border-border-subtle px-4 hover:bg-elevated">
    {children}
  </div>
)

// Tunnel route-drift, heartbeats, and per-env versions — the net-new P4 surface.
export function Drift() {
  const routes = usePoll(fetchDrift, [] as Route[])
  const beats = usePoll(fetchBeats, [] as Beat[])
  const versions = usePoll(fetchVersions, [] as Version[])

  const sortedRoutes = [...routes].sort(
    (a, b) => Number(a.up) - Number(b.up) || a.hostname.localeCompare(b.hostname),
  )
  const sortedBeats = [...beats].sort(
    (a, b) => Number(b.missing) - Number(a.missing) || a.name.localeCompare(b.name),
  )
  const sortedVersions = [...versions].sort(
    (a, b) => Number(a.ok) - Number(b.ok) || a.label.localeCompare(b.label),
  )

  return (
    <div className="flex-1 overflow-auto py-6">
      <Section label="Routes" count={routes.length} empty="No routes — cloudflared config not found.">
        {sortedRoutes.map((r) => (
          <Row key={r.hostname}>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <StatusDot tone={r.up ? 'healthy' : 'offline'} />
              <span className="truncate text-text-2">{r.hostname}</span>
            </div>
            <div className="w-48 truncate font-mono text-xs text-text-3">{r.target}</div>
            <div className="w-28">
              {r.up ? <span className="text-text-3">up</span> : <Pill>orphan</Pill>}
            </div>
          </Row>
        ))}
      </Section>

      <Section label="Heartbeats" count={beats.length} empty="No heartbeats configured.">
        {sortedBeats.map((b) => (
          <Row key={b.name}>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <StatusDot tone={b.missing ? 'offline' : 'healthy'} />
              <span className="truncate text-text-2">{b.name}</span>
            </div>
            <div className="w-32 font-mono text-xs text-text-3">{ago(b.last_ts)}</div>
            <div className="w-32 font-mono text-xs text-text-3">every {fmtUptime(b.deadline_s)}</div>
            <div className="w-28">
              {b.missing ? <Pill>missing</Pill> : <span className="text-text-3">ok</span>}
            </div>
          </Row>
        ))}
      </Section>

      <Section label="Versions" count={versions.length} empty="No version targets configured.">
        {sortedVersions.map((v) => (
          <Row key={v.label}>
            <span className="min-w-0 flex-1 truncate text-text-2">{v.label}</span>
            <div className="w-32 truncate font-mono text-xs text-text-3">{v.version ?? '—'}</div>
            <div className="w-32 truncate font-mono text-xs text-text-3">{v.commit ?? '—'}</div>
            <div className="w-28">
              {v.ok ? <span className="text-text-3">ok</span> : <Pill>unreachable</Pill>}
            </div>
          </Row>
        ))}
      </Section>
    </div>
  )
}
