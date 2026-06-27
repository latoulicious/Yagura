import { useEffect, useState } from 'react'
import {
  DISK_LIMIT,
  RAM_LIMIT,
  fetchHostHistory,
  fmtBytes,
  fmtBytesPerSec,
  fmtLoad,
  fmtPct,
  fmtUptime,
  pct,
  type Host,
  type Sample,
} from '../api'
import { Sparkline } from './Sparkline'

// Rolling sparkline length — keep in step with db.rs HOST_WINDOW_SECS / 5s tick.
const WINDOW = 60

// Curated host stats above the container grid — live number + rolling sparkline per
// row. Seeded from /api/host/history, then advanced live over /api/stream.
export function HostMetrics() {
  const [now, setNow] = useState<Host>({})
  const [buf, setBuf] = useState<Record<string, number[]>>({})

  // Seed the rolling buffers (and current numbers) from recent history.
  useEffect(() => {
    let on = true
    fetchHostHistory()
      .then((series) => {
        if (!on) return
        const b: Record<string, number[]> = {}
        const latest: Host = {}
        for (const [m, pts] of Object.entries(series)) {
          b[m] = pts.map((p) => p.value).slice(-WINDOW)
          if (pts.length) latest[m] = pts[pts.length - 1].value
        }
        setBuf(b)
        setNow(latest)
      })
      .catch(() => {})
    return () => {
      on = false
    }
  }, [])

  // Advance numbers + sparklines live off the host samples on the stream.
  useEffect(() => {
    const es = new EventSource('/api/stream')
    es.onmessage = (e) => {
      const s: Sample = JSON.parse(e.data)
      if (s.source !== 'host') return
      setNow((p) => ({ ...p, [s.metric]: s.value }))
      setBuf((p) => ({ ...p, [s.metric]: [...(p[s.metric] ?? []), s.value].slice(-WINDOW) }))
    }
    return () => es.close()
  }, [])

  const h = now
  const ser = (m: string) => buf[m] ?? []
  const memPct = pct(h.mem_used, h.mem_total)
  const diskPct = pct(h.disk_used, h.disk_total)
  const bytes2 = (used?: number, total?: number) => `${fmtBytes(used)} / ${fmtBytes(total)}`

  return (
    <div>
      <div className="px-4 pb-1 pt-2 text-xs uppercase tracking-[0.08em] text-text-3">Host</div>
      <Stat label="CPU" primary={fmtPct(h.cpu)} series={ser('cpu')} />
      <Stat
        label="Memory"
        primary={fmtPct(memPct)}
        secondary={bytes2(h.mem_used, h.mem_total)}
        series={ser('mem_used')}
        breach={(memPct ?? 0) > RAM_LIMIT}
      />
      <Stat
        label="Swap"
        primary={fmtPct(pct(h.swap_used, h.swap_total))}
        secondary={bytes2(h.swap_used, h.swap_total)}
        series={ser('swap_used')}
      />
      <Stat
        label="Disk"
        primary={fmtPct(diskPct)}
        secondary={bytes2(h.disk_used, h.disk_total)}
        series={ser('disk_used')}
        breach={(diskPct ?? 0) > DISK_LIMIT}
      />
      <Stat label="Disk read" primary={fmtBytesPerSec(h.disk_read)} series={ser('disk_read')} />
      <Stat label="Disk write" primary={fmtBytesPerSec(h.disk_write)} series={ser('disk_write')} />
      <Stat label="Net rx" primary={fmtBytesPerSec(h.net_rx)} series={ser('net_rx')} />
      <Stat label="Net tx" primary={fmtBytesPerSec(h.net_tx)} series={ser('net_tx')} />
      <Stat
        label="Load"
        primary={fmtLoad(h.load1)}
        secondary={`${fmtLoad(h.load5)} ${fmtLoad(h.load15)}`}
        series={ser('load1')}
      />
      <Stat label="Uptime" primary={fmtUptime(h.uptime)} />
    </div>
  )
}

function Stat({
  label,
  primary,
  secondary,
  series,
  breach,
}: {
  label: string
  primary: string
  secondary?: string
  series?: number[]
  breach?: boolean
}) {
  return (
    <div className="flex h-10 items-center gap-4 px-4 hover:bg-elevated">
      <div className="w-28 shrink-0 text-text-2">{label}</div>
      <div className="h-6 min-w-0 flex-1">
        {series && <Sparkline data={series} tone={breach ? 'offline' : 'healthy'} />}
      </div>
      <div className="flex w-48 items-baseline justify-end gap-2 font-mono">
        {secondary && <span className="text-xs text-text-3">{secondary}</span>}
        <span className={breach ? 'font-medium text-offline' : 'text-text-2'}>{primary}</span>
      </div>
    </div>
  )
}
