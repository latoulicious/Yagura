import { useEffect, useRef, useState } from 'react'

const MAX_LINES = 5000

export function LogView({ containerId }: { containerId: string | null }) {
  const [lines, setLines] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [follow, setFollow] = useState(true)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLines([])
    if (!containerId) return
    const es = new EventSource(`/api/logs/${containerId}`)
    es.onmessage = (e) =>
      setLines((prev) => {
        const next = prev.length >= MAX_LINES ? prev.slice(-(MAX_LINES - 1000)) : prev
        return [...next, e.data]
      })
    return () => es.close()
  }, [containerId])

  const shown = filter
    ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : lines

  useEffect(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [shown, follow])

  if (!containerId) {
    return <div className="flex flex-1 items-center justify-center text-text-3">Select a container.</div>
  }

  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-4 border-b border-border px-4">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter…"
          className="w-64 rounded border border-transparent bg-elevated px-2 py-1 font-mono text-xs outline-none focus:border-border-strong"
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
