/**
 * The serial console for every frontend: a live xterm on a chip's port, streamed from boardd. Kept per board while the
 * page is open, so switching boards and back shows it as it was. `className` styles its box in the frontend's look.
 *
 * A console that drops (the port went away, boardd restarted, the network hiccuped) connects again by itself, sooner at
 * first and then every few seconds, and at once when it is opened again or `reconnect` is called (a frontend's button).
 */
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'
import { api } from './api.ts'

export type ConsoleStatus = 'connecting' | 'live' | 'closed' | 'retry'

interface Live {
  el: HTMLDivElement
  status: ConsoleStatus
  onStatus: (status: ConsoleStatus) => void
  fit(): void
  focus(): void
  /** Connect again now, if not live. */
  reconnect(): void
  dispose(): void
}
const lives = new Map<string, Live>()
const MAX = 4

function open(board: string, die: string | undefined, dark: boolean): Live {
  const key = `${board}\0${die ?? ''}`
  const known = lives.get(key)
  if (known) { known.reconnect(); return known }
  // The terminal fills its box absolutely, so its own size never feeds back into the box it is measured from.
  const el = document.createElement('div')
  el.style.cssText = 'position:absolute;inset:0;overflow:hidden'
  const term = new Terminal({
    cursorBlink: true, fontSize: 13, lineHeight: 1.25, scrollback: 200_000, allowProposedApi: true,
    fontFamily: '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace',
    theme: { background: '#0b0d12', foreground: '#d7dde8', cursor: '#7aa2ff', selectionBackground: '#2a3a5c', black: '#1b1f27', brightBlack: '#5c6370' },
  })
  void dark
  const fit = new FitAddon()
  term.loadAddon(fit)
  let opened = false, frame = 0
  const live: Live = {
    el, status: 'connecting', onStatus: () => {},
    // At most once a frame, and only when the cell grid changes: resizing to the same rows and columns is what made
    // a maximised window shake (fit → reflow → resize event → fit …).
    fit() {
      if (!opened) { term.open(el); opened = true }
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!el.isConnected || !el.clientWidth || !el.clientHeight) return
        const next = fit.proposeDimensions()
        if (next && Number.isFinite(next.cols) && Number.isFinite(next.rows) && (next.cols !== term.cols || next.rows !== term.rows)) term.resize(Math.max(next.cols, 2), Math.max(next.rows, 1))
      })
    },
    focus() { term.focus() },
    reconnect() { if (live.status !== 'live' && !disposed) { window.clearTimeout(retry); connect() } },
    dispose() { disposed = true; window.clearTimeout(retry); source?.close(); term.dispose(); el.remove(); lives.delete(key) },
  }
  const set = (status: ConsoleStatus) => { live.status = status; live.onStatus(status) }
  const url = `api/console?raw=1&board=${encodeURIComponent(board)}${die ? `&die=${encodeURIComponent(die)}` : ''}`
  let source: EventSource | null = null, shown = false, disposed = false, retry: number | undefined, attempts = 0
  // Dropped: close this stream (the browser's own retry would keep a dead one) and open a new one after a pause.
  const dropped = (why: 'closed' | 'retry') => {
    source?.close(); source = null
    if (disposed) return
    set(why)
    window.clearTimeout(retry)
    retry = window.setTimeout(connect, Math.min(1000 * 2 ** attempts++, 10_000))
  }
  function connect() {
    source?.close()
    set(shown ? 'retry' : 'connecting')
    const stream = source = new EventSource(url)
    stream.addEventListener('history', event => {
      if (stream !== source) return
      const lines = JSON.parse((event as MessageEvent).data) as string[]
      if (!shown) { term.write(lines.join('\r\n') + '\r\n'); shown = true } else term.write('\r\n\x1b[2m[串口重新连接]\x1b[0m\r\n')
      attempts = 0
      set('live')
    })
    stream.addEventListener('output', event => { if (stream === source) term.write(JSON.parse((event as MessageEvent).data) as string) })
    stream.addEventListener('closed', event => {
      if (stream !== source) return
      term.write(`\r\n\x1b[2m[串口断开${(event as MessageEvent).data ? `：${JSON.parse((event as MessageEvent).data)}` : ''}，重连中…]\x1b[0m\r\n`)
      dropped('closed')
    })
    stream.onerror = () => { if (stream === source) dropped('retry') }
  }
  connect()
  let pending = '', timer: number | undefined, chain = Promise.resolve()
  term.onData(data => {
    pending += data
    window.clearTimeout(timer)
    timer = window.setTimeout(() => { const out = pending; pending = ''; chain = chain.then(() => api.input(board, die, out)).then(() => {}, () => {}) }, 8)
  })
  lives.set(key, live)
  while (lives.size > MAX) [...lives.values()][0]!.dispose()
  return live
}

window.addEventListener('pagehide', () => { for (const live of [...lives.values()]) live.dispose() })

/** Connect a board's console again now (a frontend's 重连 button). */
export function reconnectConsole(board: string, die?: string) { lives.get(`${board}\0${die ?? ''}`)?.reconnect() }

export function SerialConsole({ board, die, dark, onStatus, className = 'bl-terminal' }: { board: string, die?: string, dark: boolean, onStatus?: (status: ConsoleStatus) => void, className?: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [, setStatus] = useState<ConsoleStatus>('connecting')
  useEffect(() => {
    const live = open(board, die, dark)
    live.onStatus = status => { setStatus(status); onStatus?.(status) }
    // Inside the box's padding, so a frontend still pads its console.
    const pad = getComputedStyle(host.current!)
    live.el.style.inset = `${pad.paddingTop} ${pad.paddingRight} ${pad.paddingBottom} ${pad.paddingLeft}`
    host.current!.appendChild(live.el)
    const observer = new ResizeObserver(() => live.fit())
    observer.observe(host.current!)
    live.fit(); requestAnimationFrame(() => live.focus())
    onStatus?.(live.status)
    return () => { observer.disconnect(); live.el.remove(); live.onStatus = () => {} }
  }, [board, die])
  return <div ref={host} className={className} style={{ position: 'relative', overflow: 'hidden' }} />
}

export const STATUS_TEXT: Record<ConsoleStatus, string> = { connecting: '连接中', live: '实时', closed: '已断开，重连中', retry: '重连中' }
