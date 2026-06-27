import { ChevronDown, ChevronRight } from 'lucide-react'
import { health, statusOf, type Container } from '../api'
import { grouped, shortLabel } from '../grouping'
import { usePersisted } from '../usePersisted'
import { StatusBadge } from './StatusBadge'

const isBroken = (c: Container) => health(c.state) !== 'healthy'

export function Sidebar({
  containers,
  selected,
  onSelect,
}: {
  containers: Container[]
  selected: string | null
  onSelect: (id: string) => void
}) {
  const [collapsed, setCollapsed] = usePersisted<string[]>('yagura.groups', [])
  const toggle = (k: string) =>
    setCollapsed(collapsed.includes(k) ? collapsed.filter((x) => x !== k) : [...collapsed, k])

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-base">
      <nav className="flex-1 overflow-y-auto p-2">
        {grouped(containers).map(({ def, items }) => {
          const open = !collapsed.includes(def.key)
          const down = items.some((c) => statusOf(c.state).kind === 'down')
          const rows = [...items].sort(
            (a, b) =>
              Number(isBroken(b)) - Number(isBroken(a)) ||
              shortLabel(a.name).localeCompare(shortLabel(b.name)),
          )
          return (
            <div key={def.key} className="mb-2">
              <button
                onClick={() => toggle(def.key)}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs uppercase tracking-wider text-text-3 hover:text-text-2"
              >
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span>{def.label}</span>
                <span className="text-text-3/50">{items.length}</span>
                {down && <span className="ml-auto size-1.5 rounded-full bg-offline" />}
              </button>
              {open &&
                rows.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => onSelect(c.id)}
                    className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left ${
                      selected === c.id ? 'bg-elevated text-text' : 'text-text-2 hover:bg-elevated'
                    }`}
                  >
                    <span className="truncate">{shortLabel(c.name)}</span>
                    <span className="ml-auto">
                      <StatusBadge state={c.state} />
                    </span>
                  </button>
                ))}
            </div>
          )
        })}
        {!containers.length && <div className="px-2 py-3 text-xs text-text-3">No containers.</div>}
      </nav>
      <footer className="shrink-0 border-t border-border px-3 py-2 font-mono text-xs text-text-3">
        {containers.length} containers
      </footer>
    </aside>
  )
}
