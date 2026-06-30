import { useEffect, useRef, useState } from 'react'
import {
  ago,
  fetchReleases,
  streamDeploy,
  type DeployLine,
  type Release,
  type Releases as ReleasesResp,
} from '../api'

// Self-chained poll on the shared 10s cadence (mirrors Drift.tsx) — a slow response
// can't overlap and let a stale result land last. `nonce` forces an immediate
// refetch (e.g. right after a deploy finishes).
function usePoll<T>(fetcher: () => Promise<T>, initial: T, nonce = 0): T {
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
  }, [fetcher, nonce])
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

const ActionBtn = ({ label, disabled, onClick }: {
  label: string
  disabled: boolean
  onClick: () => void
}) => (
  <button
    disabled={disabled}
    onClick={onClick}
    className="rounded-[2px] border border-border px-2 py-1 text-xs text-text-2 hover:bg-elevated hover:text-text disabled:opacity-40"
  >
    {label}
  </button>
)

// Release list per env from the Tsugi agent. With deploy enabled, staging releases
// can be promoted and archived ones rolled back; the deploy log streams live.
export function Releases() {
  const [nonce, setNonce] = useState(0)
  const { ok, releases, deploy_enabled } = usePoll(
    fetchReleases,
    { ok: true, releases: [], deploy_enabled: false } as ReleasesResp,
    nonce,
  )
  const [lines, setLines] = useState<DeployLine[] | null>(null)
  const [running, setRunning] = useState(false)
  const [verb, setVerb] = useState('Deploy')
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [lines])

  const run = async (path: '/api/deploy' | '/api/rollback', verb: string, r: Release) => {
    if (!window.confirm(`${verb} ${r.service} @ ${short(r.commit)} to production?`)) return
    setVerb(verb)
    setLines([])
    setRunning(true)
    try {
      await streamDeploy(path, { service: r.service, env: 'production', commit: r.commit }, (l) =>
        setLines((prev) => [...(prev ?? []), l]),
      )
    } catch (e) {
      setLines((prev) => [...(prev ?? []), { ts: 0, stream: 'stderr', text: String(e) }])
    } finally {
      setRunning(false)
      setNonce((n) => n + 1) // pick up the new release/deployment state now
    }
  }

  const sorted = [...releases].sort(
    (a, b) => a.env.localeCompare(b.env) || a.service.localeCompare(b.service),
  )

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
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
              <div className="w-24 text-right">
                {deploy_enabled && r.status === 'staging' && (
                  <ActionBtn label="Promote" disabled={running} onClick={() => run('/api/deploy', 'Promote', r)} />
                )}
                {deploy_enabled && r.status === 'archived' && (
                  <ActionBtn label="Rollback" disabled={running} onClick={() => run('/api/rollback', 'Rollback', r)} />
                )}
              </div>
            </Row>
          ))}
        </Section>
      </div>
      {lines !== null && (
        <div className="flex max-h-64 shrink-0 flex-col border-t border-border">
          <div className="flex h-8 items-center gap-3 px-4 text-xs text-text-3">
            <span>{running ? `${verb}…` : `${verb} finished`}</span>
            <span className="ml-auto font-mono">{lines.length} lines</span>
            {!running && (
              <button onClick={() => setLines(null)} className="hover:text-text">
                close
              </button>
            )}
          </div>
          <div
            ref={boxRef}
            className="flex-1 overflow-auto whitespace-pre-wrap break-all px-4 pb-2 font-mono text-[13px] leading-[1.45]"
          >
            {lines.map((l, i) => (
              <div key={i} className={l.stream === 'stderr' ? 'text-text' : 'text-text-2'}>
                {l.text}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
