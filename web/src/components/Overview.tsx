import { useEffect, useState } from 'react'
import { fmtBytes, fmtPct, health, HEALTH_TEXT, type Container, type Sample } from '../api'

type Live = Record<string, { cpu?: number; mem?: number; mem_limit?: number }>

const broken = (c: Container) => health(c.state) !== 'healthy'

export function Overview({ containers }: { containers: Container[] }) {
  const [live, setLive] = useState<Live>({})

  useEffect(() => {
    const es = new EventSource('/api/stream')
    es.onmessage = (e) => {
      const s: Sample = JSON.parse(e.data)
      setLive((prev) => ({ ...prev, [s.source]: { ...prev[s.source], [s.metric]: s.value } }))
    }
    return () => es.close()
  }, [])

  const rows = [...containers].sort(
    (a, b) => Number(broken(b)) - Number(broken(a)) || a.name.localeCompare(b.name),
  )

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mb-3 text-xs uppercase tracking-widest text-text-3">Services</div>
      <div className="grid grid-cols-[1fr_6rem_10rem] items-baseline gap-x-8 gap-y-1.5">
        <div className="text-xs uppercase tracking-wider text-text-3">Container</div>
        <div className="text-right text-xs uppercase tracking-wider text-text-3">CPU</div>
        <div className="text-right text-xs uppercase tracking-wider text-text-3">Memory</div>

        {rows.map((c) => {
          const m = live[c.id] ?? {}
          const cpu = m.cpu ?? c.cpu
          const mem = m.mem ?? c.mem
          const lim = m.mem_limit ?? c.mem_limit
          const h = health(c.state)
          const isBroken = h !== 'healthy'
          const running = c.state === 'running'
          return (
            <div key={c.id} className="contents">
              <div className={`truncate ${isBroken ? `font-medium ${HEALTH_TEXT[h]}` : 'text-text-2'}`}>
                {c.name || c.id.slice(0, 12)}
              </div>
              <div className="text-right font-mono text-text-2">{running ? fmtPct(cpu) : '—'}</div>
              <div className="text-right font-mono text-text-3">
                {running ? (
                  <>
                    <span className="text-text-2">{fmtBytes(mem)}</span>
                    {lim ? ` / ${fmtBytes(lim)}` : ''}
                  </>
                ) : (
                  '—'
                )}
              </div>
            </div>
          )
        })}
        {!rows.length && <div className="text-xs text-text-3">No containers.</div>}
      </div>
    </div>
  )
}
