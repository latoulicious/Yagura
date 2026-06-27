import { useEffect, useState } from 'react'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { fetchOverview, type Container } from './api'
import { Sidebar } from './components/Sidebar'
import { LogView } from './components/LogView'
import { Overview } from './components/Overview'
import { usePersisted } from './usePersisted'

type Tab = 'logs' | 'overview'

export function App() {
  const [containers, setContainers] = useState<Container[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('logs')
  const [sidebar, setSidebar] = usePersisted<boolean>('yagura.sidebar', true)

  useEffect(() => {
    let on = true
    const load = () =>
      fetchOverview()
        .then((c) => on && setContainers(c))
        .catch(() => {})
    load()
    const t = setInterval(load, 10000)
    return () => {
      on = false
      clearInterval(t)
    }
  }, [])

  useEffect(() => {
    if (!containers.length) {
      setSelected(null)
      return
    }
    if (!selected || !containers.some((c) => c.id === selected)) {
      setSelected(containers.find((c) => c.state === 'running')?.id ?? containers[0].id)
    }
  }, [containers, selected])

  return (
    <div className="flex h-full bg-bg text-text font-sans text-sm">
      {sidebar && <Sidebar containers={containers} selected={selected} onSelect={setSelected} />}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-4">
          <span className="mr-4 font-mono text-xs uppercase tracking-widest text-text-3">櫓 Yagura</span>
          <TabBtn active={tab === 'logs'} onClick={() => setTab('logs')}>
            Logs
          </TabBtn>
          <TabBtn active={tab === 'overview'} onClick={() => setTab('overview')}>
            Overview
          </TabBtn>
          <button
            onClick={() => setSidebar(!sidebar)}
            className="ml-auto text-text-3 hover:text-text-2"
            title={sidebar ? 'Collapse sidebar' : 'Show sidebar'}
          >
            {sidebar ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
        </header>
        {tab === 'logs' ? <LogView containerId={selected} /> : <Overview containers={containers} />}
      </main>
    </div>
  )
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-3 py-1 text-sm ${
        active ? 'bg-elevated text-text' : 'text-text-3 hover:text-text-2'
      }`}
    >
      {children}
    </button>
  )
}
