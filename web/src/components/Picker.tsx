import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Container } from '../api'
import { grouped, shortLabel } from '../grouping'

// Custom container dropdown — native <select> can't style its option list, so this
// is a token-themed listbox. Closes on outside-click and Escape.
export function Picker({
  containers,
  selected,
  onSelect,
}: {
  containers: Container[]
  selected: string | null
  onSelect: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = containers.find((c) => c.id === selected)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-56 items-center gap-2 rounded-[2px] border border-border bg-elevated px-2 py-1 font-mono text-xs text-text-2 outline-none focus:border-border-strong"
      >
        <span className="truncate">{current ? shortLabel(current.name) : 'Select…'}</span>
        <ChevronDown size={14} className="ml-auto shrink-0 text-text-3" />
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute z-10 mt-1 max-h-80 w-56 overflow-auto rounded-[2px] border border-border bg-overlay py-1 shadow-sm"
        >
          {grouped(containers).map(({ def, items }) => (
            <li key={def.key}>
              <div className="px-2 py-1 text-[11px] uppercase tracking-[0.08em] text-text-3">
                {def.label}
              </div>
              {items.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={c.id === selected}
                  onClick={() => {
                    onSelect(c.id)
                    setOpen(false)
                  }}
                  className={`block w-full truncate px-3 py-1 text-left font-mono text-xs hover:bg-elevated ${
                    c.id === selected ? 'text-text' : 'text-text-2'
                  }`}
                >
                  {shortLabel(c.name)}
                </button>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
