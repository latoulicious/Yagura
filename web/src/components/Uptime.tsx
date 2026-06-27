import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import {
  ago,
  createCheck,
  deleteCheck,
  fetchChecks,
  fetchHistory,
  fmtMs,
  type Check,
  type CheckResult,
  type Sample,
  type Tone,
} from '../api'
import { Sparkline } from './Sparkline'
import { StatusDot } from './StatusDot'

type Live = Record<number, { up?: boolean; latency_ms?: number }>

const toneOf = (up: boolean | null | undefined): Tone =>
  up == null ? 'unknown' : up ? 'healthy' : 'offline'

export function Uptime() {
  const [checks, setChecks] = useState<Check[]>([])
  const [live, setLive] = useState<Live>({})

  const load = () => fetchChecks().then(setChecks).catch(() => {})
  useEffect(() => {
    load()
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const es = new EventSource('/api/stream')
    es.onmessage = (e) => {
      const s: Sample = JSON.parse(e.data)
      if (!s.source.startsWith('check:')) return
      const id = Number(s.source.slice('check:'.length))
      setLive((p) => ({
        ...p,
        [id]:
          s.metric === 'up'
            ? { ...p[id], up: s.value === 1 }
            : { ...p[id], latency_ms: s.value },
      }))
    }
    return () => es.close()
  }, [])

  // Calm-until-broken: down sorts to top, otherwise by target.
  const upOf = (c: Check) => live[c.id]?.up ?? c.up
  const rows = [...checks].sort(
    (a, b) => Number(upOf(b) === false) - Number(upOf(a) === false) || a.target.localeCompare(b.target),
  )

  return (
    <div className="flex-1 overflow-auto py-6">
      <div className="flex h-8 items-center gap-4 px-4">
        <div className="min-w-0 flex-1 text-xs uppercase tracking-[0.08em] text-text-3">Probe</div>
        <div className="w-20 text-right text-xs uppercase tracking-[0.08em] text-text-3">Latency</div>
        <div className="w-32 text-xs uppercase tracking-[0.08em] text-text-3">Trend</div>
        <div className="w-24 text-right text-xs uppercase tracking-[0.08em] text-text-3">Last incident</div>
        <div className="w-6" />
      </div>

      {rows.map((c) => {
        const up = upOf(c)
        const latency = live[c.id]?.latency_ms ?? c.latency_ms
        const down = up === false
        return (
          <div key={c.id} className="flex h-10 items-center gap-4 px-4 hover:bg-elevated">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <StatusDot tone={toneOf(up)} />
              <span className={`truncate ${down ? 'font-medium text-offline' : 'text-text-2'}`}>
                {c.target}
              </span>
              <span className="font-mono text-[10px] uppercase text-text-3">{c.kind}</span>
            </div>
            <div className="w-20 text-right font-mono text-text-2">{fmtMs(latency)}</div>
            <ProbeSparkline id={c.id} down={down} />
            <div className="w-24 text-right font-mono text-xs text-text-3">{ago(c.last_down)}</div>
            <button
              onClick={() => deleteCheck(c.id).then(load).catch(() => {})}
              className="inline-flex size-6 items-center justify-center rounded-[2px] text-text-3 hover:bg-elevated hover:text-offline"
              title="Delete probe"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )
      })}
      {!checks.length && <div className="px-4 pt-6 text-sm text-text-3">No probes.</div>}

      <AddRow onAdd={load} />
    </div>
  )
}

function ProbeSparkline({ id, down }: { id: number; down: boolean }) {
  const [data, setData] = useState<CheckResult[]>([])
  useEffect(() => {
    let on = true
    const load = () => fetchHistory(id).then((d) => on && setData(d)).catch(() => {})
    load()
    const t = setInterval(load, 30000)
    return () => {
      on = false
      clearInterval(t)
    }
  }, [id])

  return (
    <div className="h-6 w-32">
      <Sparkline data={data.map((d) => d.latency_ms ?? 0)} tone={down ? 'offline' : 'healthy'} />
    </div>
  )
}

function AddRow({ onAdd }: { onAdd: () => void }) {
  const [kind, setKind] = useState('http')
  const [target, setTarget] = useState('')
  const [interval, setIntervalS] = useState(60)

  const submit = async () => {
    const t = target.trim()
    if (!t || !Number.isFinite(interval) || interval < 5) return
    try {
      await createCheck({ kind, target: t, interval_s: interval })
      setTarget('')
      onAdd()
    } catch {
      // keep the input so the user can correct and retry
    }
  }

  return (
    <div className="mx-4 mt-8 flex items-center gap-2 border-t border-border pt-4">
      <div className="flex overflow-hidden rounded-[2px] border border-border">
        {(['http', 'tcp'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`px-2.5 py-1 text-xs ${
              kind === k ? 'bg-elevated text-text' : 'text-text-3 hover:text-text-2'
            }`}
          >
            {k}
          </button>
        ))}
      </div>
      <input
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder={kind === 'http' ? 'https://host/path' : 'host:port'}
        className="w-72 rounded-[2px] border border-border bg-elevated px-2 py-1 font-mono text-xs text-text-2 outline-none placeholder:text-text-3 focus:border-border-strong"
      />
      <input
        type="number"
        min={5}
        value={interval}
        onChange={(e) => setIntervalS(Number(e.target.value))}
        title="interval seconds"
        className="w-16 rounded-[2px] border border-border bg-elevated px-2 py-1 font-mono text-xs text-text-2 outline-none [appearance:textfield] focus:border-border-strong [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <span className="text-xs text-text-3">s</span>
      <button
        onClick={submit}
        className="rounded-[2px] border border-border px-3 py-1 text-xs text-text-2 hover:bg-elevated"
      >
        Add probe
      </button>
    </div>
  )
}
