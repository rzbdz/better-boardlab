/**
 * The shadcn frontend: boardlab in shadcn/ui's look (zinc, Radix primitives, Tailwind). A slim sidebar, a 48px top
 * bar, and the boards page with the list and the chosen board's workspace side by side. Module views render through
 * render.tsx; boardd's events keep everything current; notifications go to the operating system when allowed.
 */
import { Bell, LayoutGrid, Radar, Settings, History as HistoryIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { toast, Toaster } from 'sonner'
import { api, identity, type PageState } from '../../src/ui/api.ts'
import type { ModuleUi } from '../../src/ui/contract.ts'
import { who } from '../../src/ui/format.ts'
import { changes, prefs, show as notifySystem } from '../../src/ui/notify.ts'
import { registerModuleUis } from './render.tsx'
import { Button, Dialog, Input, Tip, TooltipProvider, cn } from './ui/index.tsx'
import { BoardsPage } from './views/boards.tsx'
import { canDiscover, DiscoverPage, HistoryPage, SettingsPage, type Mode } from './views/pages.tsx'

type Page = 'boards' | 'discover' | 'history' | 'settings'
const PAGES: Record<Page, string> = { boards: '板子', discover: '发现', history: '历史', settings: '设置' }
const ICONS: Record<Page, JSX.Element> = { boards: <LayoutGrid />, discover: <Radar />, history: <HistoryIcon />, settings: <Settings /> }
const MODE_KEY = 'boardlab.shadcn.mode'

function useMode(): [Mode, boolean, (mode: Mode) => void] {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const [mode, setMode] = useState<Mode>(() => { try { return (localStorage.getItem(MODE_KEY) as Mode | null) ?? 'system' } catch { return 'system' } })
  const [systemDark, setSystemDark] = useState(query.matches)
  useEffect(() => { const on = (event: MediaQueryListEvent) => setSystemDark(event.matches); query.addEventListener?.('change', on); return () => query.removeEventListener?.('change', on) }, [])
  const dark = mode === 'dark' || (mode === 'system' && systemDark)
  useEffect(() => { document.documentElement.classList.toggle('dark', dark); document.documentElement.style.colorScheme = dark ? 'dark' : 'light' }, [dark])
  return [mode, dark, next => { try { localStorage.setItem(MODE_KEY, next) } catch {} setMode(next) }]
}

function Shell() {
  const [state, setState] = useState<PageState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(true)
  const [page, setPage] = useState<Page>(() => (Object.keys(PAGES).find(key => `#${key}` === location.hash) as Page | undefined) ?? 'boards')
  const [board, setBoard] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState(identity.get())
  const [mode, dark, setMode] = useMode()
  const last = useRef<PageState | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await api.state()
      if (last.current) for (const note of changes(last.current.boards, next.boards, next.you, prefs.get().watched)) {
        const open = () => { setPage('boards'); setBoard(note.board) }
        if (!notifySystem(note, open) && prefs.get().enabled[note.topic]) toast(note.title, { description: note.body, action: { label: '查看', onClick: open }, duration: note.topic === 'attention' ? Infinity : 6000 })
      }
      last.current = next
      setState(next); setConnected(true); setError(null)
    } catch (failure) { setConnected(false); setError((failure as Error).message) }
    setRefreshKey(key => key + 1)
  }, [])

  useEffect(() => {
    void refresh()
    const source = new EventSource('api/events')
    let timer: number | undefined
    const soon = () => { window.clearTimeout(timer); timer = window.setTimeout(refresh, 150) }
    for (const event of ['changed', 'scan', 'lease-stolen', 'lease-granted', 'attention']) source.addEventListener(event, soon)
    source.addEventListener('lab-ports', event => {
      const data = JSON.parse((event as MessageEvent).data) as { host?: string, added?: string[] }
      if (data.host && data.added?.length) toast(`${data.host} 接上了新线`, { description: data.added.join('、') })
    })
    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)
    const tick = window.setInterval(refresh, 30_000)
    return () => { source.close(); window.clearInterval(tick) }
  }, [refresh])
  useEffect(() => { history.replaceState(null, '', `#${page}`) }, [page])

  const pages = (Object.keys(PAGES) as Page[]).filter(key => key !== 'discover' || !state || canDiscover(state))
  const waiting = state?.boards.filter(item => item.lab?.attention).length ?? 0
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-52 shrink-0 flex-col border-r bg-muted/30 md:flex">
        <div className="flex h-12 items-center gap-2 border-b px-4 text-sm font-semibold tracking-tight"><span className="size-4 rounded bg-foreground" />boardlab</div>
        <nav className="grid gap-0.5 p-2">{pages.map(key => (
          <button key={key} onClick={() => setPage(key)} className={cn('flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-4', page === key && 'bg-accent text-foreground')}>
            {ICONS[key]}{PAGES[key]}{key === 'discover' && state?.proposals.length ? <span className="ml-auto rounded bg-foreground px-1.5 text-[10px] text-background">{state.proposals.length}</span> : null}
          </button>
        ))}</nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-12 items-center justify-between gap-3 border-b bg-background/80 px-5 backdrop-blur">
          <div className="flex items-center gap-3">
            <div className="flex gap-1 md:hidden">{pages.map(key => <Button key={key} size="icon" variant={page === key ? 'secondary' : 'ghost'} className="h-7 w-7" onClick={() => setPage(key)} aria-label={PAGES[key]}>{ICONS[key]}</Button>)}</div>
            <h1 className="text-sm font-semibold tracking-tight">{PAGES[page]}</h1>
          </div>
          <div className="flex items-center gap-3">
            {!connected && <span className="text-xs text-warn">与 boardd 的连接中断，重试中…</span>}
            {waiting > 0 && <Tip text="有板子在等人操作"><span className="relative"><Bell className="size-4" /><span className="absolute -right-1.5 -top-1.5 rounded-full bg-warn px-1 text-[9px] font-semibold text-white">{waiting}</span></span></Tip>}
            <Tip text="我是谁（锁和排队按名字区分）">
              <button data-testid="identity" onClick={() => setNaming(true)} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-accent">
                <span className="grid size-6 place-items-center rounded-full bg-foreground text-[11px] font-semibold text-background">{(state ? who(state.you) : '?').slice(0, 1).toUpperCase()}</span>{state ? who(state.you) : ''}
              </button>
            </Tip>
          </div>
        </header>
        <main className={cn('flex-1 p-3', page !== 'boards' && 'p-5')}>
          {!state ? <div className="grid place-items-center py-32 text-[13px] text-muted-foreground">{error ? <div className="grid gap-3 text-center"><span>连不上 boardd：{error}</span><Button size="sm" onClick={() => void refresh()}>重试</Button></div> : '加载中…'}</div>
            : page === 'boards' ? <BoardsPage state={state} dark={dark} selected={board} onSelect={setBoard} />
            : page === 'discover' ? <DiscoverPage state={state} />
            : page === 'history' ? <HistoryPage state={state} refreshKey={refreshKey} />
            : <SettingsPage state={state} mode={mode} onMode={setMode} />}
        </main>
      </div>
      <Dialog open={naming} onOpenChange={setNaming} title="我是谁" description="几个人用同一个页面时，各自填自己的名字，排队和锁才分得清。留空则使用 boardd 所在机器的用户。"
        footer={<><Button size="sm" variant="outline" onClick={() => setNaming(false)}>取消</Button><Button size="sm" onClick={() => { if (name && !/^[A-Za-z0-9_.@-]{1,40}$/.test(name)) return void toast.error('名字只能用字母、数字和 . _ - @'); identity.set(name.trim()); setNaming(false); void refresh() }}>保存</Button></>}>
        <Input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="字母、数字、. _ - @" />
      </Dialog>
      <Toaster position="bottom-right" theme={dark ? 'dark' : 'light'} toastOptions={{ className: 'text-[13px]' }} />
    </div>
  )
}

/** Start the page with the distribution's module UIs. */
export function mountPage(uis: ModuleUi[]) {
  registerModuleUis(uis)
  createRoot(document.getElementById('root')!).render(<TooltipProvider><Shell /></TooltipProvider>)
}
