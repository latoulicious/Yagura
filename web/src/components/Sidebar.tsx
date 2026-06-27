import { ChevronDown, ChevronRight } from 'lucide-react'
import { health, HEALTH_TEXT, type Container } from '../api'
import { grouped, shortLabel } from '../grouping'
import { usePersisted } from '../usePersisted'

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
      <div className="flex h-12 shrink-0 items-center border-b border-border px-4 text-xs uppercase tracking-widest text-text-3">
        Containers
      </div>
      <div className="overflow-y-auto py-1">
        {grouped(containers).map(({ def, items }) => {
          const open = !collapsed.includes(def.key)
          const broken = items.some(isBroken)
          const rows = [...items].sort(
            (a, b) =>
              Number(isBroken(b)) - Number(isBroken(a)) ||
              shortLabel(a.name).localeCompare(shortLabel(b.name)),
          )
          return (
            <div key={def.key} className="mb-1">
              <button
                onClick={() => toggle(def.key)}
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs uppercase tracking-wider text-text-3 hover:text-text-2"
              >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span>{def.label}</span>
                <span className="text-text-3/60">{items.length}</span>
                {broken && <span className="ml-auto size-1.5 rounded-full bg-offline" />}
              </button>
              {open &&
                rows.map((c) => {
                  const h = health(c.state)
                  const bad = h !== 'healthy'
                  return (
                    <button
                      key={c.id}
                      onClick={() => onSelect(c.id)}
                      className={`flex w-full items-center gap-2 border-l-2 py-1 pl-6 pr-3 text-left hover:bg-elevated ${
                        selected === c.id ? 'border-accent bg-elevated' : 'border-transparent'
                      }`}
                    >
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${
                          bad ? `${HEALTH_TEXT[h]} bg-current` : 'bg-text-3/40'
                        }`}
                      />
                      <span className={`truncate ${bad ? `font-medium ${HEALTH_TEXT[h]}` : 'text-text-2'}`}>
                        {shortLabel(c.name)}
                      </span>
                    </button>
                  )
                })}
            </div>
          )
        })}
        {!containers.length && <div className="px-4 py-3 text-xs text-text-3">No containers.</div>}
      </div>
    </aside>
  )
}
