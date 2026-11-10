/**
 * The serial console for every frontend: a live xterm on a chip's port, streamed from boardd. Kept per board while the
 * page is open, so switching boards and back shows it as it was. `className` styles its box in the frontend's look.
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
  dispose(): void
}
const lives = new Map<string, Live>()
const MAX = 4

function open(board: string, die: string | undefined, dark: boolean): Live {
  const key = `${board}\0${die ?? ''}`
  const known = lives.get(key)
  if (known) return known
  const el = document.createElement('div')
  el.style.height = '100%'
  const term = new Terminal({
    cursorBlink: true, fontSize: 13, lineHeight: 1.25, scrollback: 50_000, allowProposedApi: true,
    fontFamily: '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace',
    theme: { background: '#0b0d12', foreground: '#d7dde8', cursor: '#7aa2ff', selectionBackground: '#2a3a5c', black: '#1b1f27', brightBlack: '#5c6370' },
  })
  void dark
  const fit = new FitAddon()
  term.loadAddon(fit)
  let opened = false
  const live: Live = {
    el, status: 'connecting', onStatus: () => {},
    fit() { if (!opened) { term.open(el); opened = true } try { fit.fit() } catch {} },
    focus() { term.focus() },
    dispose() { source.close(); term.dispose(); el.remove(); lives.delete(key) },
  }
  const set = (status: ConsoleStatus) => { live.status = status; live.onStatus(status) }
  const source = new EventSource(`api/console?raw=1&board=${encodeURIComponent(board)}${die ? `&die=${encodeURIComponent(die)}` : ''}`)
  let shown = false
  source.addEventListener('history', event => {
    const lines = JSON.parse((event as MessageEvent).data) as string[]
    if (!shown) { term.write(lines.join('\r\n') + '\r\n'); shown = true } else term.write('\r\n\x1b[2m[串口重新连接]\x1b[0m\r\n')
    set('live')
  })
  source.addEventListener('output', event => term.write(JSON.parse((event as MessageEvent).data) as string))
  source.addEventListener('closed', () => set('closed'))
  source.onerror = () => set(source.readyState === EventSource.CLOSED ? 'closed' : 'retry')
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

export function SerialConsole({ board, die, dark, onStatus, className = 'bl-terminal' }: { board: string, die?: string, dark: boolean, onStatus?: (status: ConsoleStatus) => void, className?: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [, setStatus] = useState<ConsoleStatus>('connecting')
  useEffect(() => {
    const live = open(board, die, dark)
    live.onStatus = status => { setStatus(status); onStatus?.(status) }
    host.current!.appendChild(live.el)
    const observer = new ResizeObserver(() => live.fit())
    observer.observe(host.current!)
    requestAnimationFrame(() => { live.fit(); live.focus() })
    onStatus?.(live.status)
    return () => { observer.disconnect(); live.el.remove(); live.onStatus = () => {} }
  }, [board, die])
  return <div ref={host} className={className} />
}

export const STATUS_TEXT: Record<ConsoleStatus, string> = { connecting: '连接中', live: '实时', closed: '已关闭', retry: '重连中' }
