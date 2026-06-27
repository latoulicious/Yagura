import { useEffect, useState } from 'react'
import { fmtBytes, fmtPct, status, tone, type Container, type Sample } from '../api'
import { grouped, shortLabel } from '../grouping'
import { HostMetrics } from './HostMetrics'
import { StatusDot } from './StatusDot'
import { StatusBadge } from './StatusBadge'

type Live = Record<string, { cpu?: number; mem?: number; mem_limit?: number }>

const isBroken = (c: Container) => status(c.state) !== 'healthy'

export function Overview({ containers }: { containers: Container[] }) {
  const [live, setLive] = useState<Live>({})

  useEffect(() => {
    const es = new EventSource('/api/stream')
    es.onmessage = (e) => {
      const s: Sample = JSON.parse(e.data)
      // probe samples belong to Uptime; host samples to HostMetrics' own stream.
      if (s.source.startsWith('check:') || s.source === 'host') return
      setLive((p) => ({ ...p, [s.source]: { ...p[s.source], [s.metric]: s.value } }))
    }
    return () => es.close()
  }, [])

  return (
    <div className="flex-1 overflow-auto py-6">
      <HostMetrics />
      <div className="mt-2 flex h-8 items-center gap-4 px-4">
        <div className="min-w-0 flex-1 text-xs uppercase tracking-[0.08em] text-text-3">Container</div>
        <div className="w-20 text-right text-xs uppercase tracking-[0.08em] text-text-3">CPU</div>
        <div className="w-48 text-right text-xs uppercase tracking-[0.08em] text-text-3">Memory</div>
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
                  <div className="w-20 text-right font-mono text-text-2">
                    {running ? fmtPct(m.cpu ?? c.cpu) : '—'}
                  </div>
                  <div className="w-48 text-right font-mono text-text-3">
                    {running ? (
                      <>
                        <span className="text-text-2">{fmtBytes(m.mem ?? c.mem)}</span>
                        {lim ? ` / ${fmtBytes(lim)}` : ''}
                      </>
                    ) : (
                      '—'
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
