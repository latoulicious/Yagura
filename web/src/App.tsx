import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { fetchOverview, type Container } from './api'
import { Footer } from './components/Footer'
import { LogView } from './components/LogView'
import { Overview } from './components/Overview'
import { Uptime } from './components/Uptime'
import { usePersisted } from './usePersisted'

type Tab = 'logs' | 'overview' | 'uptime'

export function App() {
  const [containers, setContainers] = useState<Container[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [theme, setTheme] = usePersisted<'dark' | 'light'>('yagura.theme', 'light')
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    let on = true
    const load = () =>
      fetchOverview()
        .then((c) => {
          if (!on) return
          setContainers(c)
          setUpdatedAt(Date.now())
        })
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
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            aria-pressed={theme === 'dark'}
            className="ml-auto inline-flex size-8 items-center justify-center rounded-[2px] text-text-3 hover:bg-elevated hover:text-text"
            title="Toggle theme"
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
        <div className="flex h-10 items-center gap-4 border-t border-border px-3">
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
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {tab === 'logs' ? (
          <LogView containers={containers} selected={selected} onSelect={setSelected} />
        ) : tab === 'overview' ? (
          <Overview containers={containers} />
        ) : (
          <Uptime />
        )}
      </main>
      <Footer containers={containers} updatedAt={updatedAt} />
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
      className={`inline-flex h-10 items-center border-b-2 px-1 text-sm ${
        active
          ? 'border-accent-primary text-text'
          : 'border-transparent text-text-3 hover:text-text-2'
      }`}
    >
      {children}
    </button>
  )
}
