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
import { consoleErrorText, createConsoleSession, type ConsoleSession } from './console-session.ts'

import type { ConsoleStatus } from './console-session.ts'
export type { ConsoleStatus } from './console-session.ts'

interface Live {
  el: HTMLDivElement
  status: ConsoleStatus
  onStatus: (status: ConsoleStatus) => void
  onError: (text: string) => void
  fit(): void
  focus(): void
  /** Connect again now, if not live. */
  reconnect(): void
  /** Clear the screen and everything scrolled out of it; the console stays connected. */
  clear(): void
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
    el, status: 'connecting', onStatus: () => {}, onError: text => console.error(`Console input: ${text}`),
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
    reconnect() { session.reconnect() },
    clear() { term.clear(); term.focus() },
    dispose() { session.dispose(); term.dispose(); el.remove(); lives.delete(key) },
  }
  session = createConsoleSession({
    board, die,
    onOutput: data => term.write(data),
    onStatus: status => { live.status = status; live.onStatus(status) },
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
