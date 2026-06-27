import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Line, LineChart, ResponsiveContainer } from 'recharts'
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
} from '../api'

type Live = Record<number, { up?: boolean; latency_ms?: number }>

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
    <div className="flex-1 overflow-auto p-6">
      <div className="grid grid-cols-[1fr_6rem_5rem_8rem_7rem_2rem] items-center gap-x-6">
        <div className="text-xs uppercase tracking-wider text-text-3">Probe</div>
        <div className="text-right text-xs uppercase tracking-wider text-text-3">Latency</div>
        <div className="text-xs uppercase tracking-wider text-text-3">Status</div>
        <div className="text-xs uppercase tracking-wider text-text-3">Trend</div>
        <div className="text-xs uppercase tracking-wider text-text-3">Last incident</div>
        <div />

        {rows.map((c) => {
          const up = upOf(c)
          const latency = live[c.id]?.latency_ms ?? c.latency_ms
          const down = up === false
          return (
            <div key={c.id} className="contents">
              <div className="flex items-center gap-2 py-1">
                <span className={`truncate ${down ? 'font-medium text-offline' : 'text-text-2'}`}>
                  {c.target}
                </span>
                <span className="font-mono text-[10px] uppercase text-text-3">{c.kind}</span>
              </div>
              <div className="py-1 text-right font-mono text-text-2">{fmtMs(latency)}</div>
              <div className={`py-1 text-xs ${down ? 'font-medium text-offline' : 'text-text-3'}`}>
                {up == null ? 'unknown' : up ? 'up' : 'down'}
              </div>
              <Sparkline id={c.id} />
              <div className="py-1 font-mono text-xs text-text-3">{ago(c.last_down)}</div>
              <button
                onClick={() => deleteCheck(c.id).then(load).catch(() => {})}
                className="inline-flex size-6 items-center justify-center rounded text-text-3 hover:bg-elevated hover:text-offline"
                title="Delete probe"
              >
                <Trash2 size={14} />
              </button>
            </div>
          )
        })}
        {!checks.length && <div className="col-span-6 py-2 text-xs text-text-3">No probes.</div>}
      </div>

      <AddRow onAdd={load} />
    </div>
  )
}

function Sparkline({ id }: { id: number }) {
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

  if (data.length < 2) return <div className="h-6" />
  return (
    <div className="h-6 w-32">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data.map((d) => ({ v: d.latency_ms ?? 0 }))}>
          <Line
            type="monotone"
            dataKey="v"
            dot={false}
            stroke="var(--color-text-3)"
            strokeWidth={1}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
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
    <div className="mt-8 flex items-center gap-2 border-t border-border pt-4">
      <div className="flex overflow-hidden rounded-md border border-border">
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
        className="w-72 rounded-md border border-border bg-elevated px-2 py-1 font-mono text-xs text-text-2 outline-none placeholder:text-text-3 focus:border-border-strong"
      />
      <input
        type="number"
        min={5}
        value={interval}
        onChange={(e) => setIntervalS(Number(e.target.value))}
        title="interval seconds"
        className="w-16 rounded-md border border-border bg-elevated px-2 py-1 font-mono text-xs text-text-2 outline-none [appearance:textfield] focus:border-border-strong [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <span className="text-xs text-text-3">s</span>
      <button
        onClick={submit}
        className="rounded-md border border-border px-3 py-1 text-xs text-text-2 hover:bg-elevated"
      >
        Add probe
      </button>
    </div>
  )
}
