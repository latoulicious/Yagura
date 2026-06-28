import { useEffect, useState } from 'react'
import {
  DISK_LIMIT,
  RAM_LIMIT,
  fetchHostHistory,
  fmtBytes,
  fmtBytesPerSec,
  fmtPct,
  pct,
  toneForPct,
  type Host,
  type Sample,
  type Tone,
} from '../api'
import { Sparkline } from './Sparkline'

// Rolling sparkline length — keep in step with db.rs HOST_WINDOW_SECS / 5s tick.
const WINDOW = 60

// Curated host stats above the container grid — a tile per metric: live number,
// avg/pk, and a rolling sparkline. Disk and network I/O pair their two directions
// in one tile. Seeded from /api/host/history, advanced live over /api/stream.
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
  const swapPct = pct(h.swap_used, h.swap_total)
  const diskPct = pct(h.disk_used, h.disk_total)
  const bytes2 = (used?: number, total?: number) => `${fmtBytes(used)} / ${fmtBytes(total)}`

  return (
    <div>
      <div className="px-4 pb-2 pt-2 text-xs uppercase tracking-[0.08em] text-text-3">Host</div>
      <div className="grid grid-cols-2 gap-2 px-4 lg:grid-cols-3">
        <Tile label="CPU" primary={fmtPct(h.cpu)} series={ser('cpu')} fmt={fmtPct} tone={toneForPct(h.cpu)} />
        <Tile
          label="Memory"
          primary={fmtPct(memPct)}
          secondary={bytes2(h.mem_used, h.mem_total)}
          series={ser('mem_used')}
          fmt={fmtBytes}
          tone={toneForPct(memPct)}
          breach={(memPct ?? 0) > RAM_LIMIT}
        />
        <Tile
          label="Swap"
          primary={fmtPct(swapPct)}
          secondary={bytes2(h.swap_used, h.swap_total)}
          series={ser('swap_used')}
          fmt={fmtBytes}
          tone={toneForPct(swapPct)}
        />
        <Tile
          label="Disk"
          primary={fmtPct(diskPct)}
          secondary={bytes2(h.disk_used, h.disk_total)}
          series={ser('disk_used')}
          fmt={fmtBytes}
          tone={toneForPct(diskPct)}
          breach={(diskPct ?? 0) > DISK_LIMIT}
        />
        <DualTile
          label="Disk I/O"
          items={[
            { sub: 'read', primary: fmtBytesPerSec(h.disk_read), series: ser('disk_read') },
            { sub: 'write', primary: fmtBytesPerSec(h.disk_write), series: ser('disk_write') },
          ]}
        />
        <DualTile
          label="Network I/O"
          items={[
            { sub: 'rx', primary: fmtBytesPerSec(h.net_rx), series: ser('net_rx') },
            { sub: 'tx', primary: fmtBytesPerSec(h.net_tx), series: ser('net_tx') },
          ]}
        />
      </div>
    </div>
  )
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

// One host metric tile: label + optional context, big live value, avg/pk meta,
// and a full-width sparkline beneath (visual-design §Sparklines).
function Tile({
  label,
  primary,
  secondary,
  series,
  fmt = (n) => n.toFixed(1),
  tone = 'healthy',
  breach,
}: {
  label: string
  primary: string
  secondary?: string
  series?: number[]
  fmt?: (n: number) => string
  tone?: Tone
  breach?: boolean
}) {
  const meta = series && series.length ? `avg ${fmt(mean(series))} · pk ${fmt(Math.max(...series))}` : null
  return (
    <div className="rounded-[2px] border border-border bg-base p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs uppercase tracking-[0.08em] text-text-3">{label}</span>
        {secondary && <span className="truncate font-mono text-xs text-text-3">{secondary}</span>}
      </div>
      <div className={`mt-1 font-mono text-xl ${breach ? 'font-medium text-offline' : 'text-text'}`}>
        {primary}
      </div>
      <div className="h-3 font-mono text-xs text-text-3">{meta}</div>
      <div className="mt-2 h-6">{series && <Sparkline data={series} tone={tone} />}</div>
    </div>
  )
}

// Two paired directions (read/write, rx/tx) in one tile — sublabel, live value,
// and a sparkline each.
function DualTile({
  label,
  items,
}: {
  label: string
  items: { sub: string; primary: string; series: number[]; tone?: Tone }[]
}) {
  return (
    <div className="rounded-[2px] border border-border bg-base p-3">
      <div className="text-xs uppercase tracking-[0.08em] text-text-3">{label}</div>
      <div className="mt-2 grid grid-cols-2 gap-3">
        {items.map((it) => (
          <div key={it.sub}>
            <div className="flex items-baseline justify-between gap-1">
              <span className="text-[11px] uppercase tracking-[0.08em] text-text-3">{it.sub}</span>
              <span className="font-mono text-sm text-text">{it.primary}</span>
            </div>
            <div className="mt-2 h-6">
              <Sparkline data={it.series} tone={it.tone ?? 'healthy'} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
