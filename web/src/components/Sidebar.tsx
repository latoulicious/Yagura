import { health, HEALTH_TEXT, type Container } from '../api'

const broken = (c: Container) => health(c.state) !== 'healthy'

export function Sidebar({
  containers,
  selected,
  onSelect,
}: {
  containers: Container[]
  selected: string | null
  onSelect: (id: string) => void
}) {
  // Broken sorts to top, then alphabetical (calm-until-broken).
  const sorted = [...containers].sort(
    (a, b) => Number(broken(b)) - Number(broken(a)) || a.name.localeCompare(b.name),
  )

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-base">
      <div className="flex h-12 shrink-0 items-center border-b border-border px-4 text-xs uppercase tracking-widest text-text-3">
        Containers
      </div>
      <ul className="overflow-y-auto">
        {sorted.map((c) => {
          const h = health(c.state)
          const isBroken = h !== 'healthy'
          return (
            <li key={c.id}>
              <button
                onClick={() => onSelect(c.id)}
                className={`w-full border-l-2 px-4 py-2 text-left hover:bg-elevated ${
                  selected === c.id ? 'border-accent bg-elevated' : 'border-transparent'
                }`}
              >
                <div className={`flex items-center gap-2 ${isBroken ? 'font-medium' : ''}`}>
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${
                      isBroken ? `${HEALTH_TEXT[h]} bg-current` : 'bg-text-3/40'
                    }`}
                  />
                  <span className={`truncate ${isBroken ? HEALTH_TEXT[h] : 'text-text-2'}`}>
                    {c.name || c.id.slice(0, 12)}
                  </span>
                </div>
                <div className="truncate pl-3.5 font-mono text-xs text-text-3">{c.status}</div>
              </button>
            </li>
          )
        })}
        {!containers.length && (
          <li className="px-4 py-3 text-xs text-text-3">No containers.</li>
        )}
      </ul>
    </aside>
  )
}
