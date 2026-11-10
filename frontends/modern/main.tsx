/**
 * Modern: the page shell. The top bar, a pinned banner for every board waiting for a person, and the pages (boards,
 * a board, discover, history, settings) by the address's hash. boardd's events keep the state current; changes worth
 * telling go to the operating system when allowed, else to the page's toasts and the bell's list.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api, type PageState } from '../../src/ui/api.ts'
import type { ModuleUi } from '../../src/ui/contract.ts'
import { changes, onPrefs, prefs, show, type Note } from '../../src/ui/notify.ts'
import { setActionState, useBoardActions } from './actions.tsx'
import { hhmm, holder, Icon, model, setBoards, UIProvider, upper, useUI, where } from './kit.tsx'
import { registerModuleUis } from './render.tsx'
import { BoardPage } from './views/board.tsx'
import { HomePage } from './views/home.tsx'
import { canDiscover, DiscoverPage, HistoryPage, NotifyPrefs, SettingsPage, type Theme } from './views/pages.tsx'
import type { Board } from 'boardlab-core/shared/types.ts'

const THEME_KEY = 'boardlab.modern.theme'
const route = () => { const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?'); const [page = 'boards', arg = ''] = path!.split('/'); return { page: page || 'boards', arg: decodeURIComponent(arg), query: new URLSearchParams(query) } }
const go = (hash: string) => { location.hash = hash }

function useTheme(): [Theme, boolean, (t: Theme) => void] {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const [theme, setTheme] = useState<Theme>(() => { try { return (localStorage.getItem(THEME_KEY) as Theme) || 'system' } catch { return 'system' } })
  const [systemDark, setSystemDark] = useState(query.matches)
  useEffect(() => { const on = (e: MediaQueryListEvent) => setSystemDark(e.matches); query.addEventListener?.('change', on); return () => query.removeEventListener?.('change', on) }, [])
  const dark = theme === 'dark' || (theme === 'system' && systemDark)
  useEffect(() => { document.documentElement.classList.toggle('dark', dark) }, [dark])
  return [theme, dark, t => { try { localStorage.setItem(THEME_KEY, t) } catch {} setTheme(t) }]
}

interface Logged extends Note { at: string, read: boolean }

function Banner({ board, you, fresh }: { board: Board, you: string, fresh: boolean }) {
  const act = useBoardActions(board), m = model(board, you)
  return (
    <div className={`b${fresh ? ' enter' : ''}`}><Icon name="hand" /><span className="t">{where(board)}</span>
      <span className="msg ell"><b>{upper(board.name)}</b> {board.lab?.attention}{m.holder ? ` · ${m.mine ? '你' : holder(m.holder).name}在等` : ''}</span>
      <span className="acts"><button className="pill sm" onClick={() => go(`#/board/${encodeURIComponent(board.name)}`)}>去看看</button>
        {m.canConfirm && <button className="pill sm dark" disabled={!!act.busy} onClick={act.confirm}>{act.busy === 'confirm' && <span className="spin" />}我操作好了</button>}</span>
    </div>
  )
}

function Shell() {
  const ui = useUI()
  const [state, setState] = useState<PageState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(true)
  const [where_, setWhere] = useState(route())
  const [full, setFull] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [notes, setNotes] = useState<Logged[]>([])
  const [watched, setWatched] = useState(prefs.get().watched)
  const [theme, dark, setTheme] = useTheme()
  const last = useRef<PageState | null>(null)
  const seen = useRef(new Set<string>())
  useEffect(() => onPrefs(p => setWatched(p.watched)), [])

  const refresh = useCallback(async () => {
    try {
      const next = await api.state()
      setBoards(next.boards); setActionState(next.boards, next.you, next.labs.filter(l => l.canRediscover).map(l => l.id))
      if (last.current) {
        const told = changes(last.current.boards, next.boards, next.you, prefs.get().watched)
        if (told.length) setNotes(list => [...told.map(n => ({ ...n, at: new Date().toISOString(), read: false })), ...list].slice(0, 100))
        for (const note of told) {
          const open = () => go(`#/board/${encodeURIComponent(note.board)}`)
          if (!show(note, open) && prefs.get().enabled[note.topic]) ui.toast(note.title, note.body, { label: '查看', run: open })
        }
      }
      last.current = next
      setState(next); setConnected(true); setError(null)
    } catch (e) { setConnected(false); setError((e as Error).message) }
    setRefreshKey(k => k + 1)
  }, [])

  useEffect(() => {
    void refresh()
    const source = new EventSource('api/events')
    let timer: number | undefined
    const soon = () => { window.clearTimeout(timer); timer = window.setTimeout(refresh, 150) }
    for (const event of ['changed', 'scan', 'lease-stolen', 'lease-granted', 'attention']) source.addEventListener(event, soon)
    source.addEventListener('lab-ports', event => { const data = JSON.parse((event as MessageEvent).data) as { host?: string, added?: string[] }; if (data.host && data.added?.length) ui.toast(`${data.host} 接上了新线`, data.added.join('、')) })
    // A stream hiccup is not a lost boardd: re-read the state, and only a failed read marks the page disconnected.
    source.onerror = soon
    const tick = window.setInterval(refresh, 30_000)
    return () => { source.close(); window.clearInterval(tick) }
  }, [refresh])
  useEffect(() => { const on = () => { setWhere(route()); setFull(false); window.scrollTo(0, 0) }; window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on) }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, .xterm, [role=dialog]') || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '/' && where_.page === 'boards') { e.preventDefault(); document.getElementById('board-search')?.focus() }
      else if (where_.page === 'board' && (e.key === 'f' || e.key === 'F')) setFull(f => !f)
      else if (where_.page === 'board' && e.key === 'Escape' && full) setFull(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [where_.page, full])
  useEffect(() => { document.body.classList.toggle('console-full', where_.page === 'board' && full) }, [where_.page, full])

  const openNotes = () => {
    setNotes(list => list.map(n => ({ ...n, read: true })))
    ui.layer(close => <>
      <header><h2>通知</h2><span className="acts"><button className="pill sm icon" aria-label="关闭" onClick={close}><Icon name="x" /></button></span></header>
      <div className="list">{notes.length ? notes.map((n, i) => (
        <button key={i} className={`note${n.read ? '' : ' unread'}`} onClick={() => { close(); go(`#/board/${encodeURIComponent(n.board)}`) }}>
          <span className={`ic ${n.topic}`}><Icon name={{ granted: 'lock', attention: 'hand', stolen: 'warn', free: 'bell' }[n.topic]} /></span><div><b>{n.title}</b><p>{n.body}</p><time>{hhmm(n.at)}</time></div>
        </button>
      )) : <p className="sub" style={{ padding: 16 }}>没有通知。</p>}</div>
      <div className="prefs"><NotifyPrefs /></div>
    </>, 'drawer')
  }

  const page = where_.page
  const unread = notes.filter(n => !n.read).length
  const attn = state?.boards.filter(b => b.lab?.attention) ?? []
  for (const b of attn) if (!seen.current.has(b.name)) setTimeout(() => seen.current.add(b.name), 400)
  const nav: Array<[string, string, number?]> = [['boards', '板子'], ...(state && !canDiscover(state) ? [] : [['discover', '发现', state?.proposals.filter(p => p.status === 'pending').length] as [string, string, number]]), ['history', '历史'], ['settings', '设置']]
  const me = state ? holder(state.you) : null
  return <>
    <header className={`top${page === 'board' ? ' wide' : ''}`}><div className="in">
      <a className="brand" href="#/">Boardlab</a>
      <nav className="nav">{nav.map(([k, l, c]) => <a key={k} href={`#/${k}`} className={page === k || (k === 'boards' && page === 'board') ? 'on' : ''}>{l}{c ? <span className="cnt">{c}</span> : null}</a>)}</nav>
      <div className="right">
        {!connected && <span className="conn"><Icon name="warn" />与 boardd 断开，重试中…</span>}
        <button className="bell" aria-label="通知" onClick={openNotes}><Icon name="bell" />{unread ? <b>{unread}</b> : null}</button>
        {me && <button className="me" title={state!.you} onClick={() => go('#/settings')}><i>{me.name[0]?.toUpperCase()}</i><span className="nmx">{me.name}</span></button>}
      </div>
    </div></header>
    {state && attn.length > 0 && page !== 'board' && <div className="banner">{attn.map(b => <Banner key={b.name} board={b} you={state.you} fresh={!seen.current.has(b.name)} />)}</div>}
    <main className={connected ? '' : 'stale'}>
      {!state ? <div className="empty-state" style={{ paddingTop: 120 }}>{error ? <><p>连不上 boardd：{error}</p><button className="pill sm dark" onClick={() => void refresh()}>重试</button></> : <span className="spin" />}</div>
        : page === 'board' ? <BoardPage state={state} name={where_.arg} dark={dark} full={full} setFull={setFull} watched={watched} />
        : page === 'discover' ? <DiscoverPage state={state} open={name => go(`#/board/${encodeURIComponent(name)}`)} />
        : page === 'history' ? <HistoryPage state={state} refreshKey={refreshKey} initialBoard={where_.query.get('board') ?? ''} />
        : page === 'settings' ? <SettingsPage state={state} theme={theme} onTheme={setTheme} onIdentity={() => void refresh()} />
        : <HomePage state={state} watched={watched} open={name => go(`#/board/${encodeURIComponent(name)}`)} />}
    </main>
  </>
}

/** Start the page with the distribution's module UIs. */
export function mountPage(uis: ModuleUi[]) {
  registerModuleUis(uis)
  createRoot(document.getElementById('root')!).render(<UIProvider><Shell /></UIProvider>)
}
