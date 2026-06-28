import { useEffect, useRef, useState } from 'react'
import type { Container } from '../api'
import { Picker } from './Picker'

const MAX_LINES = 5000

export function LogView({
  containers,
  selected,
  onSelect,
}: {
  containers: Container[]
  selected: string | null
  onSelect: (id: string) => void
}) {
  const [lines, setLines] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [follow, setFollow] = useState(true)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLines([])
    if (!selected) return
    const es = new EventSource(`/api/logs/${selected}`)
    es.onmessage = (e) =>
      setLines((prev) => {
        const next = prev.length >= MAX_LINES ? prev.slice(-(MAX_LINES - 1000)) : prev
        return [...next, e.data]
      })
    return () => es.close()
  }, [selected])

  const shown = filter
    ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : lines

  useEffect(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [shown, follow])

  if (!containers.length) {
    return <div className="flex flex-1 items-center justify-center text-sm text-text-3">No containers.</div>
  }

  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-4 border-b border-border px-4">
        <Picker containers={containers} selected={selected} onSelect={onSelect} />
        <input
          aria-label="Filter logs"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter…"
          className="w-64 rounded-[2px] border border-transparent bg-elevated px-2 py-1 font-mono text-xs outline-none focus:border-border-strong"
        />
        <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-text-2">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          follow
        </label>
        <span className="ml-auto font-mono text-xs text-text-3">{shown.length} lines</span>
      </div>
      <div
        ref={boxRef}
        className="flex-1 overflow-auto whitespace-pre-wrap break-all px-4 py-2 font-mono text-[13px] leading-[1.45]"
      >
        {shown.map((l, i) => (
          <div key={i} className="text-text-2">
            {l}
          </div>
        ))}
      </div>
    </>
  )
}
