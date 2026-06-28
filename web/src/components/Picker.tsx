import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Container } from '../api'
import { grouped, shortLabel } from '../grouping'

// Custom container dropdown — native <select> can't style its option list, so this
// is a token-themed listbox with full keyboard support (arrows/Home/End/Enter/Esc).
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
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const groups = grouped(containers)
  const options = groups.flatMap((g) => g.items) // flat nav order, group order preserved
  const current = containers.find((c) => c.id === selected)
  const activeId = options[active]?.id

  // Outside-click closes. Escape is handled on the trigger (it keeps focus).
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // Keep the active option scrolled into view as it moves.
  useEffect(() => {
    if (!open || !activeId) return
    listRef.current?.querySelector(`#opt-${CSS.escape(activeId)}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, activeId])

  const toggle = () => {
    if (!open) {
      const i = options.findIndex((c) => c.id === selected)
      setActive(i >= 0 ? i : 0)
    }
    setOpen((o) => !o)
  }

  const choose = (id: string) => {
    onSelect(id)
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        toggle()
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActive((a) => Math.min(a + 1, options.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setActive((a) => Math.max(a - 1, 0))
        break
      case 'Home':
        e.preventDefault()
        setActive(0)
        break
      case 'End':
        e.preventDefault()
        setActive(options.length - 1)
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (activeId) choose(activeId)
        break
      case 'Escape':
        e.preventDefault()
        setOpen(false)
        break
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-activedescendant={open && activeId ? `opt-${activeId}` : undefined}
        onClick={toggle}
        onKeyDown={onKeyDown}
        className="flex w-56 items-center gap-2 rounded-[2px] border border-border bg-elevated px-2 py-1 font-mono text-xs text-text-2 outline-none focus:border-border-strong"
      >
        <span className="truncate">{current ? shortLabel(current.name) : 'Select…'}</span>
        <ChevronDown size={14} className="ml-auto shrink-0 text-text-3" />
      </button>
      {open && (
        <ul
          ref={listRef}
          role="listbox"
          className="absolute z-10 mt-1 max-h-80 w-56 overflow-auto rounded-[2px] border border-border bg-overlay py-1 shadow-sm"
        >
          {groups.map(({ def, items }) => (
            <li key={def.key}>
              <div className="px-2 py-1 text-[11px] uppercase tracking-[0.08em] text-text-3">
                {def.label}
              </div>
              {items.map((c) => (
                <button
                  key={c.id}
                  id={`opt-${c.id}`}
                  type="button"
                  role="option"
                  aria-selected={c.id === selected}
                  onMouseEnter={() => setActive(options.indexOf(c))}
                  onClick={() => choose(c.id)}
                  className={`block w-full truncate px-3 py-1 text-left font-mono text-xs ${
                    options[active]?.id === c.id ? 'bg-elevated' : ''
                  } ${c.id === selected ? 'text-text' : 'text-text-2'}`}
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
