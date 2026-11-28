/**
 * The serial console: a live xterm on a chip's port, streamed from boardd. Kept per board while the page is open, so
 * switching boards and back shows it as it was. `className` styles its box in the frontend's look. A frontend that uses
 * this gets the newest output on opening and a view that stays where its person put it; one that draws its own xterm
 * shares only the session (`console-session.ts`).
 *
 * A console that drops (the port went away, boardd restarted, the network hiccuped) connects again by itself, sooner at
 * first and then every few seconds, and at once when it is opened again or `reconnect` is called (a frontend's button).
 */
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import { useEffect, useMemo, useRef, useState } from 'react'
import { BootRail } from './bootrail.tsx'
import { BootMarksAddon, bootMarks, forgetBootMarks, type BootLine, type BootMark } from './boots.ts'
import { CONSOLE_WORDS, consoleErrorText, createConsoleSession, type ConsoleSession } from './console-session.ts'

import type { ConsoleStatus } from './console-session.ts'
export type { ConsoleStatus } from './console-session.ts'
export { consoleStatusText } from './console-session.ts'

/** A console of one chip, kept per board while the page is open (see `open`). */
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
  /** The console's box was (re)placed on the page: measure it and show the newest output. */
  show(): void
  /** Whether the view is scrolled up from the newest output, and how many lines arrived since. */
  away: { up: boolean, unseen: number }
  onAway: (away: { up: boolean, unseen: number }) => void
  /**
   * Find `term` in what the console holds (its screen and scrollback), every match highlighted and the next (or
   * previous) one selected and scrolled to; false when there is none. `onResults` says which match of how many.
   */
  search(term: string, options: { regex: boolean, caseSensitive: boolean }, direction: 'next' | 'previous'): boolean
  clearSearch(): void
  onResults: (results: { index: number, count: number }) => void
  /** Open the search bar (a frontend's button, or Ctrl+F in the console). */
  openSearch(): void
  onOpenSearch: () => void
  /** The boot lines in what the console holds (see BootMarksAddon), and the marks they were found with. */
  boots: BootMarksAddon
  marks: BootMark[]
  /** The buffer's size and the line in the middle of the view, for the boot rail. */
  view(): { first: number, count: number, current: number }
  /** Scroll so line `line` of the buffer is near the top, and stop following the output. */
  scrollTo(line: number): void
  /** Told when the view moves (scrolled, or output arrived). */
  onView: Set<() => void>
  dispose(): void
}

/** The search's highlights: every match amber, the current one brighter, and both marked on the scrollbar. */
const FOUND: NonNullable<ISearchOptions['decorations']> = {
  matchBackground: '#5c4a12', matchBorder: '#8a6d1a', matchOverviewRuler: '#d4a72c',
  activeMatchBackground: '#facc15', activeMatchBorder: '#fde68a', activeMatchColorOverviewRuler: '#facc15',
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
  // At most this many matches are highlighted; past it the count says so (and the log tab searches it all).
  const finder = new SearchAddon({ highlightLimit: 2000 })
  term.loadAddon(finder)
  // Where each boot starts in what the console holds, found as output is written.
  const boots = new BootMarksAddon()
  term.loadAddon(boots)
  // Ctrl+F (Cmd+F on a Mac) in the console opens its search instead of being typed to the board.
  term.attachCustomKeyEventHandler(event => {
    if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); live.openSearch(); return false }
    return true
  })
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
        // A console that was taken off the page and put back (another board, the log tab, back) comes back with a
        // scroll area xterm never re-measured: its viewport then reads every scroll as line 0, and one flick sends
        // the whole view to the oldest line. `settle()` puts the measurement and the place right after every fit.
        settle()
      })
    },
    focus() { term.focus() },
    reconnect() { session.reconnect() },
    clear() { term.clear(); boots.reset(); settle(true); term.focus() },
    bottom() { following = true; settle(true); term.focus() },
    // A console is opened on the newest output, and opened again on it after the page put it back (another board,
    // the log tab): a person entering a board wants its console where it is now, not where they last left the scroll.
    show() { following = true; settle(true) },
    away: { up: false, unseen: 0 }, onAway: () => {},
    search(text, options, direction) {
      if (!text) { finder.clearDecorations(); live.onResults({ index: -1, count: 0 }); return false }
      const how: ISearchOptions = { regex: options.regex, caseSensitive: options.caseSensitive, decorations: FOUND }
      return direction === 'next' ? finder.findNext(text, { ...how, incremental: true }) : finder.findPrevious(text, how)
    },
    clearSearch() { finder.clearDecorations(); term.clearSelection(); live.onResults({ index: -1, count: 0 }) },
    onResults: () => {},
    openSearch() { live.onOpenSearch() },
    onOpenSearch: () => {},
    boots, marks: [],
    view() { const buffer = term.buffer.active; return { first: 0, count: buffer.length, current: buffer.viewportY + Math.floor(term.rows / 2) } },
    scrollTo(line) { following = false; if (!usable()) settle(); term.scrollToLine(Math.max(0, line - 2)) },
    onView: new Set(),
    dispose() { session.dispose(); term.dispose(); el.remove(); lives.delete(key) },
  }
  // Whether the view follows the newest output. xterm has a flag of its own, but it only knows what the scrollbar
  // told it: a viewport whose scroll area is not measured yet reports every scroll as line 0 and calls it a person
  // scrolling up. Ours is kept from what the person does to a viewport that can answer (`usable()`), and the view
  // is put back where it should be whenever that answer cannot be trusted.
  let following = true
  /** Whether the viewport can say where in the buffer it is: a pinned scrollbar (a bar not yet measured, or a
   *  console whose rows all fit) has no position to report, so it can be neither read nor believed. The viewport
   *  element is found once and asked through it: `querySelector` per write was a walk of the console's DOM on every
   *  line the board printed. */
  let viewport: HTMLElement | null = null
  const usable = () => (viewport ??= el.querySelector('.xterm-viewport')) && viewport.scrollHeight > viewport.clientHeight + 1
  /** Put the view where it belongs after the box or the console's place on the page changed: a scroll area that
   *  cannot show the buffer's height is one xterm never measured on this page (a console put back after another
   *  board or the log tab), so it is measured again — one row down and back is the public way to do that, and it is
   *  done at most every few fits so a window being dragged does not reflow the buffer on every frame. A following view
   *  then goes to the newest output, where a person coming back to a console expects to be. */
  let nudged = 0
  const settle = (toBottom = false) => {
    // However the person left it, the bar is made trustworthy again: a scroll that arrives before that would read as
    // line 0 and take a person reading scrollback to the top, which is the complaint this fixes.
    if (term.buffer.active.length > term.rows + 1 && !usable() && Date.now() - nudged > 250) {
      nudged = Date.now()
      const rows = term.rows
      term.resize(term.cols, rows + 1)
      term.resize(term.cols, rows)
      viewport = null
    }
    if (toBottom || following) term.scrollToBottom()
  }
  // Scrolled up means the viewport is above the newest line. New output while away is counted (in lines it moved the
  // bottom by), so the button can say how much is waiting below.
  let base = 0
  const tell = (next: { up: boolean, unseen: number }) => {
    if (next.up === live.away.up && next.unseen === live.away.unseen) return
    live.away = next; live.onAway(next)
  }
  // A correction made from inside a scroll event fires another one: the flag keeps that one from correcting again.
  let fixing = false
  /** Report where the view is: scrolled away from the newest line and, while away, how many lines arrived below. */
  const place = (up: boolean) => {
    const buffer = term.buffer.active
    const grew = Math.max(0, buffer.baseY - base); base = buffer.baseY
    tell({ up, unseen: up ? live.away.unseen + (live.away.up ? grew : 0) : 0 })
  }
  // A scroll: the person moved the view, or xterm did. Where it is can only be believed from a viewport that can
  // show the buffer's height (`usable()`).
  const look = () => {
    live.onView.forEach(fn => fn())
    const buffer = term.buffer.active
    if (usable()) following = buffer.viewportY >= buffer.baseY
    // A scroll the bar could not describe: nobody can have scrolled a pinned bar, so this is xterm reading line 0 out
    // of it. A following view is put back on the newest output; a person reading scrollback is left where they are.
    else if (following && !fixing) {
      fixing = true
      try { term.scrollToBottom() } finally { fixing = false }
    }
    place(following ? false : buffer.viewportY < buffer.baseY)
  }
  // Output arrived. A following view goes to the newest line — a no-op when it is already there, xterm's scroll
  // returning at once for no distance — and nothing here reads the page's layout: the viewport's measured height is
  // asked for when the person scrolls (`look`), not on every write. Readers of the view are told on the next frame
  // (`live.onView` is debounced by whoever draws), not before this batch of output is parsed.
  const arrival = () => {
    if (following) term.scrollToBottom()
    live.onView.forEach(fn => fn())
    if (!following) place(true)
  }
  term.onScroll(look)
  term.onWriteParsed(arrival)
  // -1 as the index: more matches than are highlighted.
  finder.onDidChangeResults(({ resultIndex, resultCount }) => live.onResults({ index: resultIndex, count: resultCount }))
  session = createConsoleSession({
    board, die,
    onOutput: data => term.write(data),
    onStatus: (status, reason) => { live.status = status; live.reason = reason; live.onStatus(status, reason) },
    onError: error => live.onError(consoleErrorText(error)),
  })
  term.onData(session.input)
  void bootMarks(board, die).then(marks => { live.marks = marks; boots.setMarks(marks) }, () => {})
  lives.set(key, live)
  while (lives.size > MAX) [...lives.values()][0]!.dispose()
  return live
}

window.addEventListener('pagehide', () => { for (const live of [...lives.values()]) live.dispose() })

/** Connect a board's console again now (a frontend's 重连 button). Its boot marks are read again with it: a site sync
 * may have changed them while the console was open. */
export function reconnectConsole(board: string, die?: string) {
  forgetBootMarks(board, die)
  lives.get(`${board}\0${die ?? ''}`)?.reconnect()
}

/** Clear a board's console (a frontend's 清屏 button): the screen and its scrollback, without disconnecting. */
export function clearConsole(board: string, die?: string) { lives.get(`${board}\0${die ?? ''}`)?.clear() }

/** Open the search bar of a board's console (a frontend's 搜索 button). */
export function searchConsole(board: string, die?: string) { lives.get(`${board}\0${die ?? ''}`)?.openSearch() }

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
  // Unmoved, it sits bottom centre, clear of the scrollbar and the boot rail beside it.
  const at = spot ?? { x: 0.5, y: 1 }
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

/**
 * The console's search bar: what the console holds is searched as the person types, every match highlighted, Enter
 * for the next and Shift+Enter for the one before, Esc to close. `onHistory` offers the same search over the whole log
 * (what has scrolled out of the console too), for a frontend that has one.
 */
function SearchBar({ live, className, onHistory }: { live: Live, className: string, onHistory?: (text: string, regex: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [regex, setRegex] = useState(false)
  const [caseSensitive, setCase] = useState(false)
  const [results, setResults] = useState<{ index: number, count: number } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    live.onOpenSearch = () => { setOpen(true); requestAnimationFrame(() => { input.current?.focus(); input.current?.select() }) }
    live.onResults = setResults
    return () => { live.onOpenSearch = () => {}; live.onResults = () => {} }
  }, [live])
  const bad = regex && !!text && (() => { try { new RegExp(text); return false } catch { return true } })()
  // As the person types: the match nearest the cursor, the rest highlighted.
  useEffect(() => { if (open && !bad) live.search(text, { regex, caseSensitive }, 'next') }, [open, text, regex, caseSensitive])
  const close = () => { setOpen(false); setResults(null); live.clearSearch(); live.focus() }
  if (!open) return null
  const count = !text || bad ? '' : results === null ? '' : results.count === 0 ? '没有匹配' : results.index < 0 ? `${results.count}+ 处` : `${results.index + 1} / ${results.count}`
  const go = (direction: 'next' | 'previous') => { if (text && !bad) live.search(text, { regex, caseSensitive }, direction) }
  return (
    <div className={className} role="search" style={{ position: 'absolute', zIndex: 5, top: 8, right: 8 }}>
      <input ref={input} value={text} aria-label="在串口里搜索" placeholder="在串口里搜索" className={bad ? 'bad' : ''} spellCheck={false}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); close() }
          else if (event.key === 'Enter') { event.preventDefault(); go(event.shiftKey ? 'previous' : 'next') }
        }} />
      <span className="count" aria-live="polite">{count}</span>
      <button type="button" className={caseSensitive ? 'on' : ''} aria-pressed={caseSensitive} title="区分大小写" onClick={() => setCase(!caseSensitive)}>Aa</button>
      <button type="button" className={regex ? 'on' : ''} aria-pressed={regex} title="正则" onClick={() => setRegex(!regex)}>.*</button>
      <button type="button" aria-label="上一个匹配" title="上一个（Shift+Enter）" disabled={!text || bad} onClick={() => go('previous')}>↑</button>
      <button type="button" aria-label="下一个匹配" title="下一个（Enter）" disabled={!text || bad} onClick={() => go('next')}>↓</button>
      {onHistory && <button type="button" className="wide" title="串口里只留着最近的输出；在整个日志里搜" disabled={!text || bad} onClick={() => { onHistory(text, regex); close() }}>搜整个日志</button>}
      <button type="button" aria-label="关闭搜索" title="关闭（Esc）" onClick={close}>×</button>
    </div>
  )
}

/** The boot rail over the live console: the boot lines its buffer holds, followed as output arrives and scrolls. */
function ConsoleBoots({ live, board, die, className }: { live: Live, board: string, die?: string, className: string }) {
  const [revision, redraw] = useState(0)
  useEffect(() => {
    // Output and scrolling move where the view is. A scroll (every line feed while following) and a new boot line are one
    // redraw per frame, and the rail is a strip of the log: four a second is as often as it can be seen to move.
    let frame = 0, last = 0
    const later = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const now = Date.now()
        if (now - last < 250) return
        last = now
        redraw(n => n + 1)
      })
    }
    const off = live.boots.onChange(later)
    live.onView.add(later)
    return () => { off(); live.onView.delete(later); cancelAnimationFrame(frame) }
  }, [live])
  // Where each boot line is now: its marker moves as the buffer scrolls and drops its oldest lines. The rail groups the
  // list into boots, so it is a new one only when this component redraws, not on every frame of a console writing output.
  const lines = useMemo<BootLine[]>(() => live.boots.lines.map(item => ({ line: item.marker.line, id: item.id, text: item.text })), [live, revision])
  const view = live.view()
  return <BootRail board={board} die={die} marks={live.marks} lines={lines} first={view.first} count={view.count} current={view.current} go={line => live.scrollTo(line)} className={className} />
}

/** `onStatus` gets the console's status and, when it is not live, why (as `consoleStatusText` shows it). */
export function SerialConsole({ board, die, dark, onStatus, className = 'bl-terminal', jumpClassName = 'bl-jump', searchClassName = 'bl-search', bootsClassName = 'bl-boots', onSearchHistory }: {
  board: string, die?: string, dark: boolean, onStatus?: (status: ConsoleStatus, reason: string | null) => void, className?: string, jumpClassName?: string
  searchClassName?: string, bootsClassName?: string
  /** Search the whole log for what the console's search has (a frontend's log view). */
  onSearchHistory?: (text: string, regex: boolean) => void
}) {
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
    live.fit(); live.show(); requestAnimationFrame(() => live.focus())
    onStatus?.(live.status, live.reason)
    return () => { observer.disconnect(); live.el.remove(); live.onStatus = () => {}; setCurrent(null) }
  }, [board, die])
  return <div ref={host} className={className} style={{ position: 'relative', overflow: 'hidden' }}>
    {current && <JumpToBottom live={current} box={host.current} className={jumpClassName} />}
    {current && <SearchBar live={current} className={searchClassName} onHistory={onSearchHistory} />}
    {current && <ConsoleBoots live={current} board={board} die={die} className={bootsClassName} />}
  </div>
}

/** The word for each status; `consoleStatusText(status, reason, STATUS_TEXT)` adds why, when boardd said. */
export const STATUS_TEXT: Record<ConsoleStatus, string> = CONSOLE_WORDS
