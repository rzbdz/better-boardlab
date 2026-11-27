/**
 * Modern: the page shell. The top bar, a pinned banner for every board waiting for a person, and the pages (boards,
 * a board, discover, history, settings) by the address's hash. boardd's events keep the state current; changes worth
 * telling go to the operating system when allowed, else to the page's toasts and the bell's list.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { api, onFetched, type PageState } from '../../src/ui/api.ts'
import { CORE_EVENTS, events } from '../../src/ui/events.ts'
import type { ModuleUi } from '../../src/ui/contract.ts'
import { changes, oneLine, onPrefs, prefs, restoreWarning, show, type Note, type Topic } from '../../src/ui/notify.ts'
import { alerts as readAlerts, isTopic, type Alert } from '../../src/ui/alerts.ts'
import { openAsks, resolveAsk } from '../../src/ui/asks.ts'
import { forgetBoard, lastBoard, visitBoard } from '../../src/ui/nav.ts'
import { setActionState, useBoardActions } from './actions.tsx'
import { hhmm, holder, Icon, model, setBoards, setRefresher, UIProvider, upper, useUI, where } from './kit.tsx'
import { marketUis } from '../../src/ui/market-ui.ts'
import { registerModuleUis, ViewPage, viewsFor } from './render.tsx'
import { BoardPage } from './views/board.tsx'
import { HomePage } from './views/home.tsx'
import { canDiscover, DiscoverPage, HistoryPage, NotifyPrefs, SettingsPage, type Theme } from './views/pages.tsx'
import { ApiPage } from './views/api.tsx'
import { ImagesPage } from './views/images.tsx'
import type { Board } from 'boardlab-core/shared/types.ts'

const THEME_KEY = 'boardlab.modern.theme'
/** The newest bus alert this browser has opened the bell on: a count, not the alerts themselves, so it stays small. */
const BUS_SEEN = 'boardlab.modern.bus-seen'
/** The board this browser last had open: what the 板子 tab returns to (src/ui/nav.ts). */
const NAV_KEY = 'boardlab.modern.board'
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

/** The icon beside a note in the bell's list, by what it is about. */
const NOTE_ICON: Record<Topic, 'lock' | 'hand' | 'warn' | 'bell'> = { granted: 'lock', attention: 'hand', stolen: 'warn', free: 'bell', failed: 'warn', aging: 'warn' }

function Banner({ board, you, fresh }: { board: Board, you: string, fresh: boolean }) {
  const act = useBoardActions(board), m = model(board, you)
  return (
    <div className={`b${fresh ? ' enter' : ''}`}><Icon name="hand" /><span className="t">{where(board)}</span>
      <span className="msg ell"><b>{upper(board.name)}</b> {board.lab?.attention}{m.holder ? ` · ${m.mine ? '你' : holder(m.holder).name}在等` : ''}</span>
      <span className="acts"><button className="pill sm" onClick={() => go(`#/board/${encodeURIComponent(board.name)}`)}>去看看</button>
        {m.canConfirm && <button className="pill sm dark" disabled={act.has('confirm')} onClick={act.confirm}>{act.has('confirm') && <span className="spin" />}我操作好了</button>}</span>
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
  // What boardd's notification bus holds: everything anyone should know, whether this page was open or not. It is read
  // with the state and kept current by the bus's own `alert` event; the bell shows it beside the page's own notices.
  const [bus, setBus] = useState<Alert[]>([])
  // The newest alert this page knows of (so one `alert` event is read once), and the newest this person has looked at.
  const busAt = useRef(0)
  const [busSeen, setBusSeen] = useState(() => { try { return Number(localStorage.getItem(BUS_SEEN)) || 0 } catch { return 0 } })
  const newAlerts = bus.filter(alert => alert.id > busSeen).length
  const [watched, setWatched] = useState(prefs.get().watched)
  const [theme, dark, setTheme] = useTheme()
  const last = useRef<PageState | null>(null)
  const seen = useRef(new Set<string>())
  useEffect(() => onPrefs(p => setWatched(p.watched)), [])
  const readBus = useCallback(async () => {
    try {
      const answer = await readAlerts(50)
      setBus(answer.alerts)
      busAt.current = answer.alerts[0]?.id ?? 0
    } catch { /* the page says it cannot reach boardd elsewhere */ }
  }, [])
  useEffect(() => { void readBus() }, [readBus])

  const version = useRef<string | null>(null)
  const refresh = useCallback(async () => {
    try {
      const next = await api.state()
      // boardd came back on another version (an update): load the page that goes with it.
      void fetch('api/system/version').then(r => r.ok ? r.json() : null).then((v: { revision?: string } | null) => {
        if (!v?.revision) return
        if (version.current && version.current !== v.revision) location.reload()
        version.current = v.revision
      }).catch(() => {})
      setBoards(next.boards); setActionState(next.boards, next.you, next.labs.filter(l => l.canRediscover).map(l => l.id), next.labs)
      if (last.current) {
        const told = changes(last.current.boards, next.boards, next.you, prefs.get().watched)
        if (told.length) setNotes(list => [...told.map(n => ({ ...n, at: new Date().toISOString(), read: false })), ...list].slice(0, 100))
        for (const note of told) {
          const open = () => go(`#/board/${encodeURIComponent(note.board)}`)
          if (!show(note, open) && prefs.get().enabled[note.topic]) ui.toast(note.title, note.body, { label: '查看', run: open })
        }
        // An agent asks a person to plug, connect or press something: new asks reach them wherever they are.
        const asks = (next as unknown as { human?: { open: number, items: Array<{ id: number, title: string, body: string, actor: string }> } }).human
        const asked = new Set(((last.current as unknown as { human?: { items: Array<{ id: number }> } }).human?.items ?? []).map(item => item.id))
        for (const item of asks?.items ?? []) {
          if (asked.has(item.id)) continue
          const note = { topic: 'attention' as const, board: `human-${item.id}`, title: `人工请求：${item.title}`, body: item.body || '做完后在「人工请求」页点「我做好了」' }
          setNotes(list => [{ ...note, at: new Date().toISOString(), read: false }, ...list].slice(0, 100))
          const open = () => go('#/p/human')
          if (!show(note, open) && prefs.get().enabled[note.topic]) ui.toast(note.title, note.body, { label: '去看', run: open })
        }
        // A discovery (usually a person resetting boards one by one) asks for a hand: say it wherever the person is.
        const lines = new Map(last.current.labs.map(lab => [lab.id, lab.discovery?.line ?? '']))
        for (const lab of next.labs) {
          const line = lab.discovery?.line ?? ''
          if (!lab.discovery?.running || !/^ACTION NEEDED/.test(line) || lines.get(lab.id) === line) continue
          const note = { topic: 'attention' as const, board: lab.id, title: `${lab.id}：需要你操作`, body: line.replace(/^ACTION NEEDED\s*/, '') }
          setNotes(list => [{ ...note, at: new Date().toISOString(), read: false }, ...list].slice(0, 100))
          const open = () => go('#/discover')
          if (!show(note, open) && prefs.get().enabled[note.topic]) ui.toast(note.title, note.body, { label: '查看', run: open })
        }
      }
      last.current = next
      setState(next); setConnected(true); setError(null)
    } catch (e) { setConnected(false); setError((e as Error).message) }
    setRefreshKey(k => k + 1)
  }, [])

  // A module's view that fetched its own data (the site, the certificate) draws it as soon as it arrives.
  useEffect(() => onFetched(() => setRefreshKey(k => k + 1)), [])
  useEffect(() => setRefresher(refresh), [refresh])
  useEffect(() => {
    void refresh()
    // The stream keeps itself open (a proxy dropping it, boardd restarting): this page hears each event, and re-reads
    // the state as soon as it is back, so nothing has to be reloaded by hand.
    const soon = (() => {
      let timer: number | undefined
      return () => { window.clearTimeout(timer); timer = window.setTimeout(refresh, 150) }
    })()
    const stop = events().listen({
      names: [...CORE_EVENTS, 'alert'],
      event: (name, data) => {
        if (name === 'alert') {
          // The bus raised something (a failed run, an aging match, a person's request): the bell's list grows now, and
          // a fresh alert is said the same way a change is — the system's notification when allowed, else the page's.
          const alert = data as { id?: number, topic?: string, title?: string, board?: string | null }
          if (typeof alert.id === 'number' && alert.id > busAt.current) {
            busAt.current = alert.id
            void readBus()
            const topic = alert.topic ?? 'attention'
            if (isTopic(topic)) {
              const note: Note = { topic, board: alert.board ?? `alert-${alert.id}`, title: alert.title ?? '通知', body: '' }
              const open = () => go('#/p/alerts')
              if (!show(note, open) && prefs.get().enabled[topic]) ui.toast(note.title, '', { label: '去看', run: open })
            }
          }
          return
        }
        if (name === 'lab-ports') {
          const news = data as { host?: string, added?: string[] }
          if (news.host && news.added?.length) ui.toast(`${news.host} 接上了新线`, news.added.join('、'))
          return
        }
        if (name === 'hello') return
        soon()
      },
      // The stream is gone (this page cannot tell why, and boardd may be answering): read the state, and only a read
      // that fails marks the page disconnected.
      lost: soon,
      // boardd answers again: the page is connected, and what changed while the stream was out is read now.
      back: () => { setConnected(true); soon() },
    })
    const tick = window.setInterval(refresh, 30_000)
    return () => { stop(); window.clearInterval(tick) }
  }, [refresh, readBus])
  useEffect(() => { const on = () => { setWhere(route()); setFull(false); window.scrollTo(0, 0) }; window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on) }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, .xterm, [role=dialog]') || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '/' && where_.page === 'boards') { e.preventDefault(); document.getElementById('board-search')?.focus() }
      else if (where_.page === 'board' && (e.key === 'f' || e.key === 'F')) setFull(f => !f)
      // Escape never leaves the console: it is vim's key (F and the handle button do the same, and keep working).
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [where_.page, full])
  useEffect(() => { document.body.classList.toggle('console-full', where_.page === 'board' && full) }, [where_.page, full])

  // A failure the page reports is kept in the bell's list too, so it can be read again after the toast is gone.
  useEffect(() => ui.onNote(note => setNotes(list => [{ ...note, read: false }, ...list].slice(0, 100))), [ui])

  const openNotes = () => {
    setNotes(list => list.map(n => ({ ...n, read: true })))
    void readBus()
    // Opened is looked at: the bell goes quiet until something new is raised.
    const newest = bus[0]?.id ?? busSeen
    setBusSeen(newest)
    try { localStorage.setItem(BUS_SEEN, String(newest)) } catch {}
    ui.layer(close => <>
      <header><h2>通知</h2><span className="acts"><button className="pill sm icon" aria-label="关闭" onClick={close}><Icon name="x" /></button></span></header>
      <div className="list">{bus.length ? bus.map(alert => (
        <button key={`bus-${alert.id}`} className="note" onClick={() => { close(); go('#/p/alerts') }}>
          <span className={`ic ${alert.topic}`}><Icon name={NOTE_ICON[alert.topic as Note['topic']] ?? 'bell'} /></span>
          <div><b>{alert.title}</b><p>{[alert.body, alert.board].filter(Boolean).join(' · ')}</p><time>{hhmm(alert.at)}{alert.delivered.length ? ` · ${alert.delivered.map(item => item.channel).join('、')}` : ''}</time></div>
        </button>
      )) : notes.map((n, i) => (
        <button key={i} className={`note${n.read ? '' : ' unread'}`} onClick={() => { close(); if (!n.board.startsWith('page') && !n.board.startsWith('human-')) go(`#/board/${encodeURIComponent(n.board)}`) }}>
          <span className={`ic ${n.topic}`}><Icon name={NOTE_ICON[n.topic] ?? 'bell'} /></span><div><b>{n.title}</b><p>{n.body}</p><time>{hhmm(n.at)}</time></div>
        </button>
      ))}
      {!bus.length && !notes.length && <p className="sub" style={{ padding: 16 }}>没有通知。</p>}</div>
      <div className="prefs"><NotifyPrefs /></div>
    </>, 'drawer')
  }

  const page = where_.page
  // A board's page is what the next press of the 板子 tab returns to: recorded as it opens, whichever way it was reached.
  useEffect(() => { if (page === 'board' && where_.arg) visitBoard(NAV_KEY, where_.arg) }, [page, where_.arg])
  // Pressing 板子 leaves the address alone when it would not change (a hash set to itself fires nothing), so the
  // decision is made here: from a board, the overview; anywhere else, the board last looked at, when it still exists.
  const onBoards = (event: ReactMouseEvent) => {
    if (page === 'board') { event.preventDefault(); go('#/'); return }
    const name = lastBoard(NAV_KEY)
    if (!name) return
    event.preventDefault()
    if (!state?.boards.some(b => b.name === name)) { forgetBoard(NAV_KEY, name); go('#/'); return }
    go(`#/board/${encodeURIComponent(name)}`)
  }
  // The bell counts what was raised since this person last looked, page notices included.
  const unread = newAlerts + notes.filter(n => !n.read).length
  const attn = state?.boards.filter(b => b.lab?.attention) ?? []
  const asks = openAsks(state)
  const [asking, setAsking] = useState<Set<number>>(() => new Set())
  const answerAsk = async (id: number, status: 'done' | 'canceled') => {
    setAsking(was => new Set([...was, id]))
    try { ui.toast((await resolveAsk(id, status)).message) }
    catch (error) { ui.fail('没能告诉对方', error) }
    finally { setAsking(was => { const next = new Set(was); next.delete(id); return next }); void refresh() }
  }
  for (const b of attn) if (!seen.current.has(b.name)) setTimeout(() => seen.current.add(b.name), 400)
  // Modules' own pages (the terminal, say) get a tab each, before settings.
  const pages = state ? viewsFor(state, 'page') : []
  const nav: Array<[string, string, number?]> = [['boards', '板子'], ...(state && !canDiscover(state) ? [] : [['discover', '发现', state?.proposals.filter(p => p.status === 'pending').length] as [string, string, number]]), ['history', '历史'],
    // The image markets get a tab once boardd has one set up.
    ...((state?.markets ?? []).length ? [['images', '镜像'] as [string, string]] : []),
    ...pages.map(view => [`p/${view.id}`, view.title ?? view.id] as [string, string]), ['api', 'API'], ['settings', '设置']]
  const me = state ? holder(state.you) : null
  return <>
    <header className={`top${page === 'board' || page === 'p' ? ' wide' : ''}`}><div className="in">
      <a className="brand" href="#/">Boardlab</a>
      <nav className="nav">{nav.map(([k, l, c]) => <a key={k} href={`#/${k}`} onClick={k === 'boards' ? onBoards : undefined} className={page === k || `${page}/${where_.arg}` === k || (k === 'boards' && page === 'board') ? 'on' : ''}>{l}{c ? <span className="cnt">{c}</span> : null}</a>)}</nav>
      <div className="right">
        {!connected && <span className="conn"><Icon name="warn" />与 boardd 断开，重试中…</span>}
        <button className="bell" aria-label="通知" onClick={openNotes}><Icon name="bell" />{unread ? <b>{unread}</b> : null}</button>
        {me && <button className="me" title={state!.you} onClick={() => go('#/settings')}><i>{me.name[0]?.toUpperCase()}</i><span className="nmx">{me.name}</span></button>}
      </div>
    </div></header>
    {state && restoreWarning(state.restored) && <div className="banner"><div className="b restored"><Icon name="warn" /><div className="msg"><b>{restoreWarning(state.restored)!.title}</b> <span className="sub">{restoreWarning(state.restored)!.body}</span></div>
      <span className="acts"><button className="pill sm dark" onClick={() => void api.acknowledgeRestore().then(() => refresh()).catch(e => ui.fail('确认失败', e))}>知道了</button></span></div></div>}
    {state && attn.length > 0 && page !== 'board' && <div className="banner">{attn.map(b => <Banner key={b.name} board={b} you={state.you} fresh={!seen.current.has(b.name)} />)}</div>}
    {asks && asks.open > 0 && !(page === 'p' && where_.arg === 'human') && <div className="banner">{asks.items.slice(0, 2).map(ask => (
      <div key={ask.id} className="b">
        <Icon name="hand" /><div className="msg"><b>{ask.title}</b>{ask.body ? ` ${oneLine(ask.body)}` : ''}{asks.open > 2 && ask === asks.items[0] ? <span className="sub"> · 共 {asks.open} 件待处理</span> : null}</div>
        <span className="acts"><button className="pill sm" onClick={() => go('#/p/human')}>详情</button>
          <button className="pill sm dark" disabled={asking.has(ask.id)} onClick={() => void answerAsk(ask.id, 'done')}>{asking.has(ask.id) ? <span className="spin" /> : null}我做好了</button></span>
      </div>))}</div>}
    {state && (state.yields ?? []).length > 0 && <div className="banner">{state.yields.map(y => (
      <div key={y.id} className="b"><Icon name="hand" /><div className="msg"><b>{holder(y.holder).name}</b> 想用 <b>{upper(y.board)}</b>（{y.purpose}）· 拿锁的是你</div>
        <span className="acts"><button className="pill sm" onClick={() => void api.answerYield(y.board, 'deny').then(() => refresh()).catch(e => ui.fail('回答失败', e))}>继续用</button>
          <button className="pill sm dark" onClick={() => void api.answerYield(y.board, 'yield').then(() => refresh()).catch(e => ui.fail('回答失败', e))}>让出</button></span></div>))}</div>}
    <main className={connected ? '' : 'stale'}>
      {!state ? <div className="empty-state" style={{ paddingTop: 120 }}>{error ? <><p>连不上 boardd：{error}</p><button className="pill sm dark" onClick={() => void refresh()}>重试</button></> : <span className="spin" />}</div>
        : page === 'board' ? <BoardPage state={state} name={where_.arg} dark={dark} full={full} setFull={setFull} watched={watched} />
        : page === 'discover' ? <DiscoverPage state={state} open={name => go(`#/board/${encodeURIComponent(name)}`)} />
        : page === 'history' ? <HistoryPage state={state} refreshKey={refreshKey} initialBoard={where_.query.get('board') ?? ''} />
        : page === 'p' && pages.some(view => view.id === where_.arg) ? <ViewPage view={pages.find(view => view.id === where_.arg)!} />
        : page === 'images' ? <ImagesPage state={state} initial={{ market: where_.query.get('market') ?? '', soc: where_.query.get('soc') ?? '' }} />
        : page === 'api' ? <ApiPage />
        : page === 'settings' ? <SettingsPage state={state} theme={theme} onTheme={setTheme} onIdentity={() => void refresh()} focus={where_.arg} />
        : <HomePage state={state} watched={watched} open={name => go(`#/board/${encodeURIComponent(name)}`)} />}
    </main>
  </>
}

/** Start the page with the distribution's module UIs. */
export function mountPage(uis: ModuleUi[]) {
  registerModuleUis(uis)
  // Modules from a market bring their page parts at load; the page draws them with these once they are in. A part that
  // arrives later needs a re-render, so the page is drawn again (its state is fetched again anyway).
  void marketUis().then(parts => { if (parts.length) registerModuleUis([...uis, ...parts.map(part => part.ui)]) })
  createRoot(document.getElementById('root')!).render(<UIProvider><Shell /></UIProvider>)
}
