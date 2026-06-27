import { useEffect, useState } from 'react'
import { fmtBytes, fmtPct, health, type Container, type Sample } from '../api'
import { grouped, shortLabel } from '../grouping'
import { StatusBadge } from './StatusBadge'

type Live = Record<string, { cpu?: number; mem?: number; mem_limit?: number }>

const isBroken = (c: Container) => health(c.state) !== 'healthy'

export function Overview({ containers }: { containers: Container[] }) {
  const [live, setLive] = useState<Live>({})

  useEffect(() => {
    const es = new EventSource('/api/stream')
    es.onmessage = (e) => {
      const s: Sample = JSON.parse(e.data)
      if (s.source.startsWith('check:')) return // probe samples belong to the Uptime tab
      setLive((p) => ({ ...p, [s.source]: { ...p[s.source], [s.metric]: s.value } }))
    }
    return () => es.close()
  }, [])

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="grid grid-cols-[1fr_6rem_12rem] items-baseline gap-x-8">
        <div className="text-xs uppercase tracking-wider text-text-3">Container</div>
        <div className="text-right text-xs uppercase tracking-wider text-text-3">CPU</div>
        <div className="text-right text-xs uppercase tracking-wider text-text-3">Memory</div>

        {grouped(containers).map(({ def, items }) => {
          const rows = [...items].sort(
            (a, b) =>
              Number(isBroken(b)) - Number(isBroken(a)) ||
              shortLabel(a.name).localeCompare(shortLabel(b.name)),
          )
          return (
            <div key={def.key} className="contents">
              <div className="col-span-3 pb-1 pt-5 text-xs uppercase tracking-wider text-text-3/70">
                {def.label}
              </div>
              {rows.map((c) => {
                const m = live[c.id] ?? {}
                const running = c.state === 'running'
                const lim = m.mem_limit ?? c.mem_limit
                return (
                  <div key={c.id} className="contents">
                    <div className="flex items-center gap-2 py-0.5">
                      <span className="truncate text-text-2">{shortLabel(c.name)}</span>
                      <StatusBadge state={c.state} />
                    </div>
                    <div className="py-0.5 text-right font-mono text-text-2">
                      {running ? fmtPct(m.cpu ?? c.cpu) : '—'}
                    </div>
                    <div className="py-0.5 text-right font-mono text-text-3">
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
        {!containers.length && <div className="col-span-3 text-xs text-text-3">No containers.</div>}
      </div>
    </div>
  )
}
