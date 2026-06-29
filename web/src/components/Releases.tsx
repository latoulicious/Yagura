import { useEffect, useState } from 'react'
import { ago, fetchReleases, type Releases as ReleasesResp } from '../api'

// Self-chained poll on the shared 10s cadence (mirrors Drift.tsx) — a slow response
// can't overlap and let a stale result land last.
function usePoll<T>(fetcher: () => Promise<T>, initial: T): T {
  const [data, setData] = useState<T>(initial)
  useEffect(() => {
    let on = true
    let timer = 0
    const load = async () => {
      try {
        const d = await fetcher()
        if (on) setData(d)
      } catch {
        // transient; retry next tick
      } finally {
        if (on) timer = window.setTimeout(load, 10000)
      }
    }
    void load()
    return () => {
      on = false
      clearTimeout(timer)
    }
  }, [fetcher])
  return data
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

const short = (commit: string) => (commit ? commit.slice(0, 7) : '—')

// Read-only release list — what's deployed where, per env, from the Tsugi agent.
// No deploy/rollback buttons yet.
export function Releases() {
  const { ok, releases } = usePoll(fetchReleases, { ok: true, releases: [] } as ReleasesResp)

  const sorted = [...releases].sort(
    (a, b) => a.env.localeCompare(b.env) || a.service.localeCompare(b.service),
  )

  return (
    <div className="flex-1 overflow-auto py-6">
      <Section
        label="Releases"
        count={releases.length}
        empty={ok ? 'No releases yet.' : 'Tsugi agent unreachable.'}
      >
        {sorted.map((r) => (
          <Row key={`${r.env}/${r.service}`}>
            <span className="min-w-0 flex-1 truncate text-text-2">{r.service}</span>
            <div className="w-28 truncate text-xs text-text-3">{r.env}</div>
            <div className="w-24 truncate font-mono text-xs text-text-3">{short(r.commit)}</div>
            <div className="w-28 truncate text-xs text-text-3">{r.status || '—'}</div>
            <div className="w-28 font-mono text-xs text-text-3">{ago(r.deployed_at)}</div>
          </Row>
        ))}
      </Section>
    </div>
  )
}
