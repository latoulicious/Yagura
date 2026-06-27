import { useEffect, useState } from 'react'
import { DISK_LIMIT, RAM_LIMIT, fetchChecks, pct, type Container, type Sample } from '../api'

// 32px summary bar (visual-design.md §Page Structure). Counts derive from the
// existing endpoints; last-updated ticks off App's overview poll.
export function Footer({ containers, updatedAt }: { containers: Container[]; updatedAt: number | null }) {
  const [down, setDown] = useState(0)
  const [breached, setBreached] = useState(0)

  // Probes-down from /api/checks — cheap poll on the overview cadence.
  useEffect(() => {
    let on = true
    const load = () =>
      fetchChecks()
        .then((cs) => on && setDown(cs.filter((c) => c.up === false).length))
        .catch(() => {})
    load()
    const t = setInterval(load, 10000)
    return () => {
      on = false
      clearInterval(t)
    }
  }, [])

  // Host-breach live off the stream (no history download). Track the 4 scalars
  // the thresholds need and recompute on each host sample.
  useEffect(() => {
    const h: Record<string, number> = {}
    const es = new EventSource('/api/stream')
    es.onmessage = (e) => {
      const s: Sample = JSON.parse(e.data)
      if (s.source !== 'host') return
      h[s.metric] = s.value
      const mem = pct(h.mem_used, h.mem_total)
      const disk = pct(h.disk_used, h.disk_total)
      setBreached(Number((mem ?? 0) > RAM_LIMIT) + Number((disk ?? 0) > DISK_LIMIT))
    }
    return () => es.close()
  }, [])

  const running = containers.filter((c) => c.state === 'running').length
  return (
    <footer className="flex h-8 shrink-0 items-center justify-between border-t border-border px-4 text-xs text-text-3">
      <div className="flex gap-4">
        <span>
          {running}/{containers.length} running
        </span>
        <span>{down} down</span>
        <span>{breached} breached</span>
      </div>
      <span className="font-mono">
        {updatedAt ? `updated ${new Date(updatedAt).toLocaleTimeString('en-GB', { hour12: false })}` : '—'}
      </span>
    </footer>
  )
}
