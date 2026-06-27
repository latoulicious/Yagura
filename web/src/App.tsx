import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { fetchOverview, type Container } from './api'
import { Sidebar } from './components/Sidebar'
import { LogView } from './components/LogView'
import { Overview } from './components/Overview'
import { Uptime } from './components/Uptime'
import { usePersisted } from './usePersisted'

type Tab = 'logs' | 'overview' | 'uptime'

export function App() {
  const [containers, setContainers] = useState<Container[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [theme, setTheme] = usePersisted<'dark' | 'light'>('yagura.theme', 'dark')

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

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
    <div className="flex h-full flex-col bg-bg text-text font-sans text-sm">
      <header className="shrink-0 border-b border-border">
        <div className="flex h-11 items-center px-3">
          <span className="font-mono text-xs uppercase tracking-widest text-text-3">櫓 Yagura</span>
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="ml-auto inline-flex size-8 items-center justify-center rounded-md text-text-3 hover:bg-elevated hover:text-text"
            title="Toggle theme"
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
        <div className="flex h-10 items-center gap-2 border-t border-border px-3">
          <TabBtn active={tab === 'overview'} onClick={() => setTab('overview')}>
            Overview
          </TabBtn>
          <TabBtn active={tab === 'uptime'} onClick={() => setTab('uptime')}>
            Uptime
          </TabBtn>
          <TabBtn active={tab === 'logs'} onClick={() => setTab('logs')}>
            Logs
          </TabBtn>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <Sidebar containers={containers} selected={selected} onSelect={setSelected} />
        <main className="flex min-w-0 flex-1 flex-col">
          {tab === 'logs' ? (
            <LogView containerId={selected} />
          ) : tab === 'overview' ? (
            <Overview containers={containers} />
          ) : (
            <Uptime />
          )}
        </main>
      </div>
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
      className={`rounded-md px-3 py-1 text-sm ${
        active ? 'bg-accent/10 text-accent' : 'text-text-3 hover:text-text-2'
      }`}
    >
      {children}
    </button>
  )
}
