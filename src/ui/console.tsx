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
import { CONSOLE_WORDS, consoleErrorText, createConsoleSession, type ConsoleSession } from './console-session.ts'

import type { ConsoleStatus } from './console-session.ts'
export type { ConsoleStatus } from './console-session.ts'
export { consoleStatusText } from './console-session.ts'

interface Live {
  el: HTMLDivElement
  status: ConsoleStatus
  /** Why it is not live, when boardd said (see ConsoleSession.reason). */
  reason: string | null
  onStatus: (status: ConsoleStatus, reason: string | null) => void
  onError: (text: string) => void
  fit(): void
  focus(): void
  /** Connect again now, if not live. */
  reconnect(): void
  /** Clear the screen and everything scrolled out of it; the console stays connected. */
  clear(): void
  /** Go to the newest output and type there again. */
  bottom(): void
  /** Whether the view is scrolled up from the newest output, and how many lines arrived since. */
  away: { up: boolean, unseen: number }
  onAway: (away: { up: boolean, unseen: number }) => void
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
  let session!: ConsoleSession
  const live: Live = {
    el, status: 'connecting', reason: null, onStatus: () => {}, onError: text => console.error(`Console input: ${text}`),
    // At most once a frame, and only when the cell grid changes: resizing to the same rows and columns is what made
    // a maximised window shake (fit → reflow → resize event → fit …).
    fit() {
      if (!opened) { term.open(el); opened = true; el.querySelector('.xterm-viewport')?.addEventListener('scroll', () => look(), { passive: true }) }
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!el.isConnected || !el.clientWidth || !el.clientHeight) return
        const next = fit.proposeDimensions()
        if (next && Number.isFinite(next.cols) && Number.isFinite(next.rows) && (next.cols !== term.cols || next.rows !== term.rows)) term.resize(Math.max(next.cols, 2), Math.max(next.rows, 1))
      })
    },
    focus() { term.focus() },
    reconnect() { session.reconnect() },
    clear() { term.clear(); term.focus() },
    bottom() { term.scrollToBottom(); term.focus() },
    away: { up: false, unseen: 0 }, onAway: () => {},
    dispose() { session.dispose(); term.dispose(); el.remove(); lives.delete(key) },
  }
  // Scrolled up means the viewport is above the newest line. New output while away is counted (in lines it moved the
  // bottom by), so the button can say how much is waiting below.
  let base = 0
  const tell = (next: { up: boolean, unseen: number }) => {
    if (next.up === live.away.up && next.unseen === live.away.unseen) return
    live.away = next; live.onAway(next)
  }
  const look = () => {
    const buffer = term.buffer.active
    const up = buffer.viewportY < buffer.baseY
    const grew = Math.max(0, buffer.baseY - base); base = buffer.baseY
    tell({ up, unseen: up ? live.away.unseen + (live.away.up ? grew : 0) : 0 })
  }
  term.onScroll(look)
  term.onWriteParsed(look)
  session = createConsoleSession({
    board, die,
    onOutput: data => term.write(data),
    onStatus: (status, reason) => { live.status = status; live.reason = reason; live.onStatus(status, reason) },
    onError: error => live.onError(consoleErrorText(error)),
  })
  term.onData(session.input)
  lives.set(key, live)
  while (lives.size > MAX) [...lives.values()][0]!.dispose()
  return live
}

window.addEventListener('pagehide', () => { for (const live of [...lives.values()]) live.dispose() })

/** Connect a board's console again now (a frontend's 重连 button). */
export function reconnectConsole(board: string, die?: string) { lives.get(`${board}\0${die ?? ''}`)?.reconnect() }

/** Clear a board's console (a frontend's 清屏 button): the screen and its scrollback, without disconnecting. */
export function clearConsole(board: string, die?: string) { lives.get(`${board}\0${die ?? ''}`)?.clear() }

const SPOT_KEY = 'boardlab.console.jump'
/** Where the person left the button, as fractions of the console box (so it stays put when the box resizes). */
function savedSpot(): { x: number, y: number } | null {
  try { const v = JSON.parse(localStorage.getItem(SPOT_KEY) ?? 'null'); return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? { x: Math.min(1, Math.max(0, v.x)), y: Math.min(1, Math.max(0, v.y)) } : null } catch { return null }
}

/**
 * The floating "to the newest output" button: shown only while the view is scrolled up, with the number of lines
 * that arrived since. It can be dragged anywhere inside the console (a press that moves is a drag, not a click) and
 * stays where it was left. `className` lets a frontend give it its look.
 */
function JumpToBottom({ live, box, className }: { live: Live, box: HTMLDivElement | null, className: string }) {
  const [away, setAway] = useState(live.away)
  const [spot, setSpot] = useState(savedSpot)
  const drag = useRef<{ id: number, x: number, y: number, moved: boolean } | null>(null)
  const self = useRef<HTMLButtonElement>(null)
  useEffect(() => { live.onAway = setAway; setAway(live.away); return () => { live.onAway = () => {} } }, [live])
  const place = (clientX: number, clientY: number) => {
    if (!box || !self.current || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return
    const r = box.getBoundingClientRect(), b = self.current.getBoundingClientRect()
    // The same formula the style uses: left = 8 + x * (width - 16 - own width), so it stays inside at any width.
    const roomX = r.width - 16 - b.width, roomY = r.height - 16 - b.height
    const x = roomX > 0 ? (clientX - r.left - b.width / 2 - 8) / roomX : 1, y = roomY > 0 ? (clientY - r.top - b.height / 2 - 8) / roomY : 1
    setSpot({ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) })
  }
  if (!away.up) return null
  const at = spot ?? { x: 1, y: 1 }
  return (
    <button ref={self} type="button" className={`${className}${away.unseen ? ' has-new' : ''}`} aria-label="滚到最新输出" title="滚到最新输出（可拖动）"
      style={{ position: 'absolute', zIndex: 4, touchAction: 'none', left: `calc(8px + (100% - 16px) * ${at.x})`, top: `calc(8px + (100% - 16px) * ${at.y})`, transform: `translate(${-at.x * 100}%, ${-at.y * 100}%)` }}
      onPointerDown={event => { if (event.button > 0) return; drag.current = { id: event.pointerId ?? 0, x: event.clientX, y: event.clientY, moved: false }; try { event.currentTarget.setPointerCapture(event.pointerId) } catch {} }}
      onPointerMove={event => {
        const d = drag.current
        if (!d || d.id !== (event.pointerId ?? 0)) return
        if (!d.moved && Math.hypot(event.clientX - d.x, event.clientY - d.y) < 4) return
        d.moved = true; place(event.clientX, event.clientY)
      }}
      onPointerUp={event => {
        const d = drag.current; drag.current = null
        if (!d || d.id !== (event.pointerId ?? 0)) return
        if (d.moved) { setSpot(current => { try { if (current) localStorage.setItem(SPOT_KEY, JSON.stringify(current)) } catch {} return current }) }
        else live.bottom()
      }}
      onPointerCancel={() => { drag.current = null }}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); live.bottom() } }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      {away.unseen > 0 && <span>{away.unseen > 999 ? '999+' : away.unseen} 行新输出</span>}
    </button>
  )
}

/** `onStatus` gets the console's status and, when it is not live, why (as `consoleStatusText` shows it). */
export function SerialConsole({ board, die, dark, onStatus, className = 'bl-terminal', jumpClassName = 'bl-jump' }: { board: string, die?: string, dark: boolean, onStatus?: (status: ConsoleStatus, reason: string | null) => void, className?: string, jumpClassName?: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [, setStatus] = useState<ConsoleStatus>('connecting')
  const [current, setCurrent] = useState<Live | null>(null)
  useEffect(() => {
    const live = open(board, die, dark)
    setCurrent(live)
    live.onStatus = (status, reason) => { setStatus(status); onStatus?.(status, reason) }
    // Inside the box's padding, so a frontend still pads its console.
    const pad = getComputedStyle(host.current!)
    live.el.style.inset = `${pad.paddingTop} ${pad.paddingRight} ${pad.paddingBottom} ${pad.paddingLeft}`
    host.current!.appendChild(live.el)
    const observer = new ResizeObserver(() => live.fit())
    observer.observe(host.current!)
    live.fit(); requestAnimationFrame(() => live.focus())
    onStatus?.(live.status, live.reason)
    return () => { observer.disconnect(); live.el.remove(); live.onStatus = () => {}; setCurrent(null) }
  }, [board, die])
  return <div ref={host} className={className} style={{ position: 'relative', overflow: 'hidden' }}>{current && <JumpToBottom live={current} box={host.current} className={jumpClassName} />}</div>
}

/** The word for each status; `consoleStatusText(status, reason, STATUS_TEXT)` adds why, when boardd said. */
export const STATUS_TEXT: Record<ConsoleStatus, string> = CONSOLE_WORDS
