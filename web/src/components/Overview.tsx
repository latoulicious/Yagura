import { ago, fmtBytes, fmtPct, pct, status, tone, toneForPct, type Bufs, type Container, type Live } from '../api'
import { grouped, shortLabel } from '../grouping'
import { HostMetrics } from './HostMetrics'
import { Sparkline } from './Sparkline'
import { StatusDot } from './StatusDot'
import { StatusBadge } from './StatusBadge'

const isBroken = (c: Container) => status(c.state) !== 'healthy'

// Presentational — live metrics + sparkline buffers come from App so they persist
// across tab switches (the SSE subscription lives there, not here).
export function Overview({
  containers,
  host,
  live,
  bufs,
}: {
  containers: Container[]
  host: string
  live: Live
  bufs: Bufs
}) {
  return (
    <div className="flex-1 overflow-auto py-6">
      <HostMetrics />
      <div className="mt-2 flex h-8 items-center gap-4 px-4 text-xs uppercase tracking-[0.08em] text-text-3">
        <div className="min-w-0 flex-1">Container</div>
        <div className="w-40">Host</div>
        <div className="w-28">Status</div>
        <div className="w-28">Created</div>
        <div className="w-36 text-right">CPU</div>
        <div className="w-48 text-right">Memory</div>
      </div>

      {grouped(containers).map(({ def, items }) => {
        const rows = [...items].sort(
          (a, b) =>
            Number(isBroken(b)) - Number(isBroken(a)) ||
            shortLabel(a.name).localeCompare(shortLabel(b.name)),
        )
        return (
          <div key={def.key}>
            <div className="px-4 pb-1 pt-6 text-xs uppercase tracking-[0.08em] text-text-3">
              {def.label}
            </div>
            {rows.map((c) => {
              const m = live[c.id] ?? {}
              const b = bufs[c.id] ?? { cpu: [], mem: [] }
              const running = c.state === 'running'
              const lim = m.mem_limit ?? c.mem_limit
              const cpu = m.cpu ?? c.cpu
              const memPct = pct(m.mem ?? c.mem ?? undefined, lim ?? undefined)
              const st = status(c.state)
              return (
                <div key={c.id} className="border-b border-border-subtle">
                  <div className="flex h-10 items-center gap-4 px-4 hover:bg-elevated">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <StatusDot tone={tone(st)} />
                      <span className="truncate text-text-2">{shortLabel(c.name)}</span>
                    </div>
                    <div className="w-40 truncate text-text-3">{host}</div>
                    <div className="w-28">
                      {st === 'healthy' ? (
                        <span className="text-text-3">{c.state}</span>
                      ) : (
                        <StatusBadge status={st} />
                      )}
                    </div>
                    <div className="w-28 font-mono text-xs text-text-3">{ago(c.created)}</div>
                    <div className="flex w-36 items-center justify-end gap-2 font-mono text-text-2">
                      {running && (
                        <div className="h-6 w-16">
                          <Sparkline data={b.cpu} tone={toneForPct(cpu)} />
                        </div>
                      )}
                      <span>{running ? fmtPct(cpu) : '—'}</span>
                    </div>
                    <div className="flex w-48 items-center justify-end gap-2 font-mono text-text-2">
                      {running && (
                        <div className="h-6 w-16">
                          <Sparkline data={b.mem} tone={toneForPct(memPct)} />
                        </div>
                      )}
                      <span>{running ? fmtBytes(m.mem ?? c.mem) : '—'}</span>
                    </div>
                  </div>
                  {/* Recent lifecycle events under the container — calm, muted, newest-first.
                      Bad-event tinting (die/oom) can come later; the word carries it. */}
                  {c.events?.length ? (
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 px-4 pb-1.5 pl-8 font-mono text-[11px] text-text-3">
                      {c.events.map((e, i) => (
                        <span key={i}>
                          {e.kind}
                          {e.payload ? ` ${e.payload}` : ''} · {ago(e.ts)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )
      })}
      {!containers.length && <div className="px-4 pt-6 text-sm text-text-3">No containers.</div>}
    </div>
  )
}
