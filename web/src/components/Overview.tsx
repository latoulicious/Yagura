import { useEffect, useState } from 'react'
import { fmtBytes, fmtPct, status, tone, type Container, type Sample } from '../api'
import { grouped, shortLabel } from '../grouping'
import { HostMetrics } from './HostMetrics'
import { Sparkline } from './Sparkline'
import { StatusDot } from './StatusDot'
import { StatusBadge } from './StatusBadge'

type Live = Record<string, { cpu?: number; mem?: number; mem_limit?: number }>
type Bufs = Record<string, { cpu: number[]; mem: number[] }>

// Rolling sparkline length — same window as HostMetrics.
const WINDOW = 60

const isBroken = (c: Container) => status(c.state) !== 'healthy'

export function Overview({ containers }: { containers: Container[] }) {
  const [live, setLive] = useState<Live>({})
  const [bufs, setBufs] = useState<Bufs>({})

  useEffect(() => {
    const es = new EventSource('/api/stream')
    es.onmessage = (e) => {
      const s: Sample = JSON.parse(e.data)
      // probe samples belong to Uptime; host samples to HostMetrics' own stream.
      if (s.source.startsWith('check:') || s.source === 'host') return
      setLive((p) => ({ ...p, [s.source]: { ...p[s.source], [s.metric]: s.value } }))
      if (s.metric === 'cpu' || s.metric === 'mem') {
        const metric = s.metric
        setBufs((p) => {
          const cur = p[s.source] ?? { cpu: [], mem: [] }
          return { ...p, [s.source]: { ...cur, [metric]: [...cur[metric], s.value].slice(-WINDOW) } }
        })
      }
    }
    return () => es.close()
  }, [])

  return (
    <div className="flex-1 overflow-auto py-6">
      <HostMetrics />
      <div className="mt-2 flex h-8 items-center gap-4 px-4">
        <div className="min-w-0 flex-1 text-xs uppercase tracking-[0.08em] text-text-3">Container</div>
        <div className="w-36 text-right text-xs uppercase tracking-[0.08em] text-text-3">CPU</div>
        <div className="w-64 text-right text-xs uppercase tracking-[0.08em] text-text-3">Memory</div>
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
              const st = status(c.state)
              return (
                <div key={c.id} className="flex h-10 items-center gap-4 px-4 hover:bg-elevated">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <StatusDot tone={tone(st)} />
                    <span className="truncate text-text-2">{shortLabel(c.name)}</span>
                    {st !== 'healthy' && <StatusBadge status={st} />}
                  </div>
                  <div className="flex w-36 items-center justify-end gap-2 font-mono text-text-2">
                    {running && (
                      <div className="h-6 w-16">
                        <Sparkline data={b.cpu} tone={tone(st)} />
                      </div>
                    )}
                    <span>{running ? fmtPct(m.cpu ?? c.cpu) : '—'}</span>
                  </div>
                  <div className="flex w-64 items-center justify-end gap-2 font-mono text-text-3">
                    {running && (
                      <div className="h-6 w-16">
                        <Sparkline data={b.mem} tone={tone(st)} />
                      </div>
                    )}
                    {running ? (
                      <span>
                        <span className="text-text-2">{fmtBytes(m.mem ?? c.mem)}</span>
                        {lim ? ` / ${fmtBytes(lim)}` : ''}
                      </span>
                    ) : (
                      <span>—</span>
                    )}
                  </div>
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
