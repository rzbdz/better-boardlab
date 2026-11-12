/**
 * The web terminal for every frontend (the terminal module's `terminal.page`): a list of terminals beside the open one,
 * each a tmux session on boardd's machine, drawn by xterm. Output streams in (SSE) and keystrokes go back in small
 * batches; the stream reconnects by itself when it drops, goes quiet, or the page comes back to the foreground, and the
 * screen is redrawn whole. Class names start with `term-` for the frontend to style.
 */
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as Xterm } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'
import { call } from './api.ts'

export interface TerminalInfo { id: string, name: string, session: string, createdAt: string, createdBy: string, alive: boolean, viewers: number }
type Status = 'connecting' | 'live' | 'retry' | 'closed'
const STATUS: Record<Status, string> = { connecting: '连接中', live: '已连接', retry: '重连中', closed: '已结束' }

export const terminals = {
  list: (base: string) => call<TerminalInfo[]>('GET', base),
  create: (base: string, name: string) => call<TerminalInfo>('POST', base, { name }),
  rename: (base: string, id: string, name: string) => call('POST', `${base}/rename`, { id, name }),
  remove: (base: string, id: string) => call('POST', `${base}/remove`, { id }),
}

function Screen({ base, terminal, onStatus }: { base: string, terminal: TerminalInfo, onStatus: (status: Status) => void }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = host.current!
    const term = new Xterm({
      cursorBlink: true, fontSize: 13, lineHeight: 1.2, scrollback: 200_000, allowProposedApi: true, macOptionIsMeta: true,
      fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace',
      theme: { background: '#0b0c0e', foreground: '#d6d7da', cursor: '#e5e5e7', selectionBackground: '#3e6ae155' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    let source: EventSource | null = null, retry: number | undefined, quiet: number | undefined, attempts = 0, stopped = false, frame = 0
    const set = (status: Status) => onStatus(status)
    const size = () => ({ rows: term.rows, cols: term.cols })
    const refit = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!el.clientWidth || !el.clientHeight) return
        const next = fit.proposeDimensions()
        if (next && Number.isFinite(next.cols) && Number.isFinite(next.rows) && (next.cols !== term.cols || next.rows !== term.rows)) {
          term.resize(Math.max(next.cols, 10), Math.max(next.rows, 2))
          void call('POST', `${base}/resize`, { id: terminal.id, ...size() }).catch(() => {})
        }
      })
    }
    // No word for 45 s (boardd pings every 20 s): the connection is dead even if the browser has not noticed.
    const alive = () => { window.clearTimeout(quiet); quiet = window.setTimeout(() => dropped(), 45_000) }
    const dropped = () => {
      source?.close(); source = null
      if (stopped) return
      set('retry')
      window.clearTimeout(retry)
      retry = window.setTimeout(connect, Math.min(500 * 2 ** attempts++, 8_000))
    }
    function connect() {
      source?.close()
      window.clearTimeout(retry)
      const { rows, cols } = size()
      const stream = source = new EventSource(`${base}/stream?id=${encodeURIComponent(terminal.id)}&rows=${rows}&cols=${cols}`)
      stream.addEventListener('ready', () => { if (stream !== source) return; attempts = 0; set('live'); alive() })
      stream.addEventListener('ping', () => { if (stream === source) alive() })
      stream.addEventListener('output', event => { if (stream !== source) return; alive(); term.write(JSON.parse((event as MessageEvent).data) as string) })
      stream.addEventListener('closed', event => {
        if (stream !== source) return
        term.write(`\r\n\x1b[2m[${JSON.parse((event as MessageEvent).data)}，重新打开…]\x1b[0m\r\n`)
        dropped()
      })
      stream.onerror = () => { if (stream === source) dropped() }
    }
    // Keystrokes in order, a few milliseconds' worth per request.
    let pending = '', timer: number | undefined, chain = Promise.resolve()
    term.onData(data => {
      pending += data
      window.clearTimeout(timer)
      timer = window.setTimeout(() => { const out = pending; pending = ''; chain = chain.then(() => call('POST', `${base}/input`, { id: terminal.id, data: out })).then(() => {}, () => {}) }, 6)
    })
    const back = () => { if (document.visibilityState === 'visible' && !source) connect() }
    const online = () => connect()
    document.addEventListener('visibilitychange', back)
    window.addEventListener('online', online)
    const observer = new ResizeObserver(refit)
    observer.observe(el)
    refit()
    requestAnimationFrame(() => { refit(); connect(); term.focus() })
    return () => {
      stopped = true
      window.clearTimeout(retry); window.clearTimeout(quiet); window.clearTimeout(timer)
      source?.close(); observer.disconnect()
      document.removeEventListener('visibilitychange', back); window.removeEventListener('online', online)
      term.dispose()
    }
  }, [base, terminal.id])
  return <div ref={host} className="term-screen" style={{ position: 'relative', overflow: 'hidden' }} />
}

/** The page: the list (new, rename, remove) and the chosen terminal. */
export function TerminalPage({ base = 'api/terminals', onError }: { base?: string, onError?: (title: string, error: unknown) => void }) {
  const [list, setList] = useState<TerminalInfo[] | null>(null)
  const [current, setCurrent] = useState<string | null>(() => { try { return localStorage.getItem('boardlab.terminal') } catch { return null } })
  const [editing, setEditing] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>('connecting')
  const fail = (title: string, error: unknown) => onError ? onError(title, error) : console.error(title, error)
  const load = async () => { try { const rows = await terminals.list(base); setList(rows); return rows } catch (error) { fail('读不到终端列表', error); return null } }
  useEffect(() => { void load().then(rows => { if (rows && rows.length && !rows.some(row => row.id === current)) choose(rows[0]!.id) }) }, [])
  const choose = (id: string | null) => { setCurrent(id); try { id ? localStorage.setItem('boardlab.terminal', id) : localStorage.removeItem('boardlab.terminal') } catch {} }
  const add = async () => { try { const made = await terminals.create(base, ''); await load(); choose(made.id) } catch (error) { fail('新建终端失败', error) } }
  const rename = async (id: string, name: string) => { setEditing(null); if (!name.trim()) return; try { await terminals.rename(base, id, name.trim()); await load() } catch (error) { fail('改名失败', error) } }
  const remove = async (row: TerminalInfo) => {
    if (!window.confirm(`删除「${row.name}」？它的 tmux 会话和里面在跑的程序都会结束。`)) return
    try { await terminals.remove(base, row.id); const rows = await load(); if (current === row.id) choose(rows?.[0]?.id ?? null) } catch (error) { fail('删除失败', error) }
  }
  const open = list?.find(row => row.id === current) ?? null
  return (
    <div className="term-page">
      <aside className="term-list">
        <div className="term-list-head"><b>终端</b><button className="term-add" onClick={() => void add()}>＋ 新建</button></div>
        {list?.map(row => (
          <div key={row.id} className={`term-item${row.id === current ? ' on' : ''}`} onClick={() => choose(row.id)}>
            <span className={`term-dot${row.alive ? ' alive' : ''}`} />
            {editing === row.id
              ? <input autoFocus defaultValue={row.name} className="term-rename" onClick={event => event.stopPropagation()} onBlur={event => void rename(row.id, event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') void rename(row.id, (event.target as HTMLInputElement).value); if (event.key === 'Escape') setEditing(null) }} />
              : <span className="term-name" title={`${row.session} · ${row.createdBy}`} onDoubleClick={() => setEditing(row.id)}>{row.name}</span>}
            <span className="term-actions">
              <button title="改名" onClick={event => { event.stopPropagation(); setEditing(row.id) }}>✎</button>
              <button title="删除" onClick={event => { event.stopPropagation(); void remove(row) }}>✕</button>
            </span>
          </div>
        ))}
        {list && !list.length && <p className="term-empty">还没有终端。新建一个，就是 boardd 机器上的一个 tmux 会话，关掉页面也还在。</p>}
      </aside>
      <section className="term-main">
        {open ? <>
          <div className="term-bar"><b>{open.name}</b><span className="term-session">tmux {open.session}</span>{open.alive
            ? <span className={`term-status ${status}`}>{STATUS[status]}</span>
            : <span className="term-status closed" title="tmux 会话已经不在了（主机重启或会话被结束）；这里打开会新建一个 shell">会话已丢失</span>}</div>
          <Screen key={open.id} base={base} terminal={open} onStatus={setStatus} />
        </> : <div className="term-none">{list ? '选一个终端，或者新建一个' : '读取中…'}</div>}
      </section>
    </div>
  )
}
