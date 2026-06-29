import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { fetchOverview, fmtUptime, type Bufs, type Container, type Live, type Sample } from './api'
import { Drift } from './components/Drift'
import { Footer } from './components/Footer'
import { LogView } from './components/LogView'
import { Overview } from './components/Overview'
import { Releases } from './components/Releases'
import { Uptime } from './components/Uptime'
import { usePersisted } from './usePersisted'

type Tab = 'logs' | 'overview' | 'uptime' | 'drift' | 'deploy'

// Rolling sparkline window for the container grid (30 points).
const WINDOW = 30

export function App() {
  const [containers, setContainers] = useState<Container[]>([])
  const [host, setHost] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [theme, setTheme] = usePersisted<'dark' | 'light'>('yagura.theme', 'light')
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [uptime, setUptime] = useState<number | null>(null)
  const [live, setLive] = useState<Live>({})
  const [bufs, setBufs] = useState<Bufs>({})

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  // One container/host stream for App — header uptime plus the container live
  // values and rolling sparkline buffers. Owned here so the buffers survive tab
  // switches (Overview unmounts; this doesn't).
  useEffect(() => {
    const es = new EventSource('/api/stream')
    es.onmessage = (e) => {
      const s: Sample = JSON.parse(e.data)
      if (s.source === 'host') {
        if (s.metric === 'uptime') setUptime(s.value)
        return
      }
      if (s.source.startsWith('check:')) return
      setLive((p) => ({ ...p, [s.source]: { ...p[s.source], [s.metric]: s.value } }))
      if (s.metric === 'cpu' || s.metric === 'mem') {
        const metric = s.metric
        setBufs((p) => {
          const cur = p[s.source] ?? { cpu: [], mem: [] }
          return { ...p, [s.source]: { ...cur, [metric]: [...cur[metric], s.value].slice(-WINDOW) } }
        })
      }
    }
    return () => es.close()
  }, [])

  useEffect(() => {
    let on = true
    const load = () =>
      fetchOverview()
        .then(({ host, containers }) => {
          if (!on) return
          setHost(host)
          setContainers(containers)
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
          <TabBtn active={tab === 'drift'} onClick={() => setTab('drift')}>
            Drift
          </TabBtn>
          <TabBtn active={tab === 'deploy'} onClick={() => setTab('deploy')}>
            Deploy
          </TabBtn>
          {uptime != null && (
            <span className="ml-auto font-mono text-xs text-text-3">up {fmtUptime(uptime)}</span>
          )}
        </div>
      </header>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {tab === 'logs' ? (
          <LogView containers={containers} selected={selected} onSelect={setSelected} />
        ) : tab === 'overview' ? (
          <Overview containers={containers} host={host} live={live} bufs={bufs} />
        ) : tab === 'uptime' ? (
          <Uptime />
        ) : tab === 'drift' ? (
          <Drift />
        ) : (
          <Releases />
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
