/**
 * A board's serial log, the whole of it: a list as long as the log, of which only the lines in view are read from
 * boardd, a page at a time. A search asks boardd where every match is; the count shows at once, and the next and
 * previous match are scrolled to exactly by their line numbers. At the bottom it follows new lines as they come.
 *
 * A time range narrows what the list is: boardd says where the range's lines are (one small answer, the lines
 * unread), the page draws a log of just those rows, and every window after that is the same by-number read. Jumping —
 * to a boot, a match, or by hand — reads the page it lands on first, so the jump arrives on lines rather than blanks.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { logs, rangeOf, RANGES, type LogResult, type LogSearch } from '../../../src/ui/logs.ts'
import { inView, isHit, LogPages, nextHit, PAGE } from '../../../src/ui/logview.ts'
import { BootRail } from '../../../src/ui/bootrail.tsx'
import { bootMarks, type BootLine, type BootMark } from '../../../src/ui/boots.ts'
import { copyText, Icon, useUI } from '../kit.tsx'

const STAMP = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\] ?/
/** A range picked in an input, as a serial log stamps a line: `2026-11-10 08:50:00`, without the `.000` a browser may add. */
const asStamp = (value: string): string | undefined => value ? value.replace('T', ' ').replace(/\.\d+$/, '') : undefined
const plain = (text: string) => text.replace(/\u0000/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b./g, '')
/** One line's height: every line is one row (long lines scroll sideways), so line n is at n rows. */
const ROW = 19
/** Browsers stop scrolling an element past a few million pixels: a longer log is scaled into this height. */
const MAX_HEIGHT = 8_000_000
/** How often the end of the log is asked about while the page follows it. */
const FOLLOW_MS = 2000
/** How many matches a page takes from boardd: enough to step through, few enough that the answer stays small. */
const MAX_HITS = 100_000
/** Boot lines kept: the rail draws a bounded strip anyway, and a log of many years would only fill memory. */
const MAX_BOOTS = 20_000

function pattern(grep: string, regex: boolean): RegExp | null | 'bad' {
  if (!grep) return null
  try { return new RegExp(regex ? grep : grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') } catch { return 'bad' }
}
function Marked({ text, rx }: { text: string, rx: RegExp | null }) {
  if (!rx) return <>{text}</>
  const parts: Array<string | JSX.Element> = []
  let last = 0
  for (const match of text.matchAll(new RegExp(rx.source, 'gi'))) { if (!match[0]) break; parts.push(text.slice(last, match.index), <mark key={match.index}>{match[0]}</mark>); last = match.index! + match[0].length }
  parts.push(text.slice(last))
  return <>{parts}</>
}

export interface LogQuery { grep: string, regex: boolean }

export function LogPanel({ board, die, query }: { board: string, die?: string, query?: LogQuery | null }) {
  const ui = useUI()
  const [range, setRange] = useState('all')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [grep, setGrep] = useState(query?.grep ?? '')
  const [regex, setRegex] = useState(query?.regex ?? false)
  const [found, setFound] = useState<LogResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [current, setCurrent] = useState(-1)
  const [source, setSource] = useState<LogResult['source'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [follow, setFollow] = useState(true)
  const [view, setView] = useState({ top: 0, height: 400 })
  const [marks, setMarks] = useState<BootMark[]>([])
  const [boots, setBoots] = useState<BootLine[]>([])
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const box = useRef<HTMLDivElement>(null)
  const pages = useMemo(() => new LogPages((at, before, after) => logs.window({ board, die, at, before, after }), redraw), [board, die])
  const span = useMemo(() => range === 'custom' ? { since: asStamp(since), until: asStamp(until) } : rangeOf(range === 'all' ? null : Number(range)), [range, since, until])
  const ranged = !!(span.since || span.until)
  const text = grep.trim(), rx = pattern(text, regex)
  const search: LogSearch = { board, die, ...span, grep: text || undefined, regex }

  // A search handed over from the console: take it as this panel's own.
  useEffect(() => { if (query) { setGrep(query.grep); setRegex(query.regex) } }, [query])

  // The log's size, and the lines at its end; then, while following, again every few seconds. With a time range the
  // list is the range's rows: it starts where boardd said it does, and grows with the log when the range is open.
  // Only this and a range's bounds set what the list shows: a window answer says how big the *log* is, and taking it
  // as the view would put the whole log back the first time a page was read.
  const rangeBase = useRef<number | null>(null)
  const rangeEmpty = useRef(false)
  const spanRef = useRef(span)
  spanRef.current = span
  // A read that answers after the panel moved to another board writes nothing: its lines are another board's.
  const keyRef = useRef('')
  keyRef.current = `${board}\0${die ?? ''}`

  /** Ask boardd where the time range's lines are, and draw exactly those rows. */
  const readRange = useCallback(async () => {
    const key = keyRef.current
    try {
      const got = await logs.bounds({ board, die, ...spanRef.current })
      if (key !== keyRef.current) return
      const total = got.total ?? 0
      // An empty range has no first line; it stays empty until lines fall inside it.
      rangeBase.current = total ? got.base ?? 0 : null
      rangeEmpty.current = total === 0
      pages.show(rangeBase.current ?? 0, total)
      setError(null)
    } catch (failure) { if (key === keyRef.current) setError((failure as Error).message) }
  }, [pages, board, die])

  const readEnd = useCallback(async () => {
    const key = keyRef.current
    try {
      const end = await logs.window({ board, die, at: 'end', before: 1 })
      if (key !== keyRef.current) return
      const logEnd = (end.base ?? 0) + (end.total ?? 0)
      const start = rangeBase.current
      if (start === null) pages.show(end.base ?? 0, end.total ?? 0)
      // A range that closes where a person said does not grow; an open one grows with the log.
      else if (!spanRef.current.until) { const from = Math.max(start, end.base ?? 0); pages.show(from, Math.max(0, logEnd - from)) }
      setSource(end.source)
      setError(null)
    } catch (failure) { if (key === keyRef.current) setError((failure as Error).message) }
  }, [pages, board, die])

  // A time range: where its lines are, asked once and drawn as those rows.
  useEffect(() => {
    let live = true
    rangeBase.current = null
    rangeEmpty.current = false
    if (!ranged) { void readEnd(); return () => { live = false } }
    void readRange()
    return () => { live = false }
  }, [board, die, span.since, span.until, pages, readEnd, readRange, ranged])

  // Every boot line in the log, read once; then only what is new, as the end is read again. A read that fails as a
  // whole (an answer too large for boardd to carry, say) is not tried again every few seconds: the rail keeps what it
  // has, and the log itself is unaffected.
  const bootsRead = useRef<{ key: string, next: number }>({ key: '', next: 0 })
  const bootsFailed = useRef(false)
  const readBoots = useCallback(async () => {
    const key = `${board}\0${die ?? ''}`
    if (bootsFailed.current) return
    const known = bootsRead.current.key === key ? bootsRead.current : { key, next: 0 }
    try {
      const result = await logs.boots({ board, die, maxMarks: MAX_BOOTS, ...(known.next ? { fromLine: known.next } : {}) })
      if (keyRef.current !== key) return
      const base = result.base ?? 0, end = base + (result.total ?? 0)
      // The oldest lines went (or this is the first read): all of them, else the new ones after those known.
      setBoots(now => {
        const all = known.next && known.next >= base ? [...now.filter(line => line.line >= base), ...(result.marks ?? [])] : result.marks ?? []
        return all.length > MAX_BOOTS ? all.slice(all.length - MAX_BOOTS) : all
      })
      bootsRead.current = { key, next: end }
    } catch { if (keyRef.current === key) bootsFailed.current = true }
  }, [board, die])
  useEffect(() => {
    let live = true
    setBoots([]); bootsRead.current = { key: '', next: 0 }; bootsFailed.current = false
    void bootMarks(board, die).then(found => { if (live) setMarks(found) }, () => {})
    void readBoots()
    return () => { live = false }
  }, [board, die, readBoots])
  useEffect(() => { void readEnd() }, [readEnd])
  useEffect(() => {
    if (!follow) return
    // An open range that was empty is asked again as the log grows: the first line inside it should appear by itself.
    const timer = setInterval(() => { void readEnd(); void readBoots(); if (rangeEmpty.current && ranged) void readRange() }, FOLLOW_MS)
    return () => clearInterval(timer)
  }, [follow, readEnd, readBoots, readRange, ranged])

  // Scaled when the log is taller than a browser scrolls: a row's place is still its number, times `scale`.
  const rows = pages.total, height = Math.min(rows * ROW, MAX_HEIGHT), scale = rows * ROW > MAX_HEIGHT ? MAX_HEIGHT / (rows * ROW) : 1
  const rowAt = (top: number) => top / (ROW * scale)
  const shown = inView(rowAt(view.top) * ROW, view.height, ROW, pages.base, rows)
  useEffect(() => { pages.need(shown.from, shown.to).catch(failure => setError((failure as Error).message)) }, [pages, shown.from, shown.to])

  // Following: the newest line stays in view as the log grows. The bottom is where the rows say it is, not where the
  // browser measured it last.
  useLayoutEffect(() => {
    const el = box.current
    if (!follow || !el) return
    const bottom = Math.max(0, height - (el.clientHeight || view.height))
    el.scrollTop = bottom
    setView(now => now.top === bottom ? now : { top: bottom, height: el.clientHeight || now.height })
  }, [follow, height])
  /** Read the rows just past where the view is going, so the next flick of the wheel already has them. */
  const lastTop = useRef(0)
  const onScroll = () => {
    const el = box.current
    if (!el) return
    const top = el.scrollTop, height_ = el.clientHeight || view.height
    const before = lastTop.current
    lastTop.current = top
    setView({ top, height: height_ })
    setFollow(top + height_ >= height - ROW)
    if (top === before) return
    const first = pages.base + Math.floor(rowAt(top)), last = pages.base + Math.ceil(rowAt(top + height_))
    if (top > before) pages.prefetch(last, last + PAGE)
    else pages.prefetch(first - PAGE, first)
  }
  useLayoutEffect(() => { const el = box.current; if (el) setView({ top: el.scrollTop, height: el.clientHeight || 400 }) }, [])

  // A list that got shorter — a time range picked while scrolled deep in the whole log, or a log that was cut — leaves
  // the scroll past its end, where no row is drawn and the list looks empty: pull it back into the list, at its end.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const bottom = Math.max(0, height - (el.clientHeight || view.height))
    if (el.scrollTop <= bottom) return
    el.scrollTop = bottom
    setView({ top: bottom, height: el.clientHeight || view.height })
    setFollow(true)
  }, [height])

  // Where every match is: boardd counts them and gives their numbers; the lines are read only as they come into view.
  // A newer search stops the one still running, so typing does not leave a queue of scans behind it.
  useEffect(() => {
    if (!rx || rx === 'bad') { setFound(null); setCurrent(-1); return }
    let live = true
    const stop = new AbortController()
    setSearching(true)
    const timer = setTimeout(() => {
      logs.hits({ ...search, maxHits: MAX_HITS }, stop.signal).then(result => { if (!live) return; pages.size(result); setFound(result); setCurrent(-1) }, failure => { if (live && (failure as Error).name !== 'AbortError') { setFound(null); ui.fail('搜不了日志', failure) } })
        .finally(() => { if (live) setSearching(false) })
    }, 250)
    return () => { live = false; clearTimeout(timer); stop.abort() }
  }, [board, die, text, regex, span.since, span.until])

  const hits = found?.hits ?? []
  /**
   * Scroll so line `number` is in the middle of the view (or near its top: a boot is read from where it starts). The
   * rows there are read first when they are not read yet, so the jump arrives on lines: a jump into blanks is what a
   * person reads as the log being slow.
   */
  const goTo = (number: number, where: 'middle' | 'top' = 'middle') => {
    const el = box.current
    if (!el) return
    setFollow(false)
    const row = Math.max(0, number - pages.base)
    const offset = where === 'top' ? ROW * 2 : (el.clientHeight || view.height) / 2 - ROW / 2
    const top = Math.max(0, row * ROW * scale - offset)
    const move = () => {
      if (box.current !== el) return
      el.scrollTop = top
      setView({ top, height: el.clientHeight || view.height })
    }
    if (pages.line(number)) { move(); return }
    pages.prefetch(row - PAGE / 2, row + PAGE / 2)
    pages.need(row - PAGE / 2, row + PAGE / 2).then(move, move)
  }
  const step = (direction: 'next' | 'previous') => {
    if (!hits.length) return
    const from = current >= 0 ? hits[current]! : pages.base + Math.floor(rowAt(view.top + view.height / 2))
    const index = nextHit(hits, from, direction)
    setCurrent(index)
    goTo(hits[index]!)
  }

  // The boots the list shows: with a time range, only those whose lines it holds (the rail places a line by its number).
  const bootLines = useMemo(() => ranged ? boots.filter(line => line.line >= pages.base && line.line < pages.end) : boots, [ranged, boots, pages.base, pages.total])

  const lines: JSX.Element[] = []
  for (let number = shown.from; number < shown.to; number++) {
    const line = pages.line(number)
    const stamp = line ? STAMP.exec(line.text) : null
    const body = line ? plain(stamp ? line.text.slice(stamp[0].length) : line.text) : ''
    const hit = !!found && isHit(hits, number)
    lines.push(<div key={number} className={`ll${hit ? ' hit' : ''}${hit && hits[current] === number ? ' on' : ''}${line ? '' : ' wait'}`} style={{ top: (number - pages.base) * ROW * scale }} data-line={number}>
      <span className="no">{number + 1}</span><span className="ts">{stamp ? stamp[1]!.slice(5) : ''}</span>{line ? <Marked text={body || ' '} rx={hit && rx !== 'bad' ? rx : null} /> : ' '}
    </div>)
  }
  const download: LogSearch = { board, die, ...span, grep: text || undefined, regex }
  return <>
    <div className="lq">
      <label className="in"><Icon name="search" /><input className={rx === 'bad' ? 'bad' : ''} value={grep} onChange={e => setGrep(e.target.value)} placeholder={regex ? '正则，比如 mmc[0-9]: (error|timeout)' : '搜整个日志：error、mmc、U-Boot…'}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? 'previous' : 'next') } }} /></label>
      {found && <span className="lcount">{hits.length ? `${current >= 0 ? current + 1 : '–'} / ${found.matched}` : '没有匹配'}{found.hitsTruncated ? '+' : ''}</span>}
      {searching && <span className="spin" />}
      <button className="chip" title="上一个（Shift+Enter）" aria-label="上一个匹配" disabled={!hits.length} onClick={() => step('previous')}><Icon name="chev" className="up" /></button>
      <button className="chip" title="下一个（Enter）" aria-label="下一个匹配" disabled={!hits.length} onClick={() => step('next')}><Icon name="chev" className="down" /></button>
      <button className={`chip${regex ? ' on' : ''}`} title="正则" onClick={() => setRegex(!regex)}>.*</button>
      <select value={range} onChange={e => setRange(e.target.value)} aria-label="搜索的时间范围">{RANGES.map(r => <option key={r.label} value={r.minutes === null ? 'all' : String(r.minutes)}>{r.label}</option>)}<option value="custom">自定义…</option></select>
      {range === 'custom' && <><input type="datetime-local" step={1} value={since} onChange={e => setSince(e.target.value)} aria-label="开始" /><span>到</span><input type="datetime-local" step={1} value={until} onChange={e => setUntil(e.target.value)} aria-label="结束" /></>}
    </div>
    <div className="logwrap">
      <div ref={box} className={`logs virt${found ? ' searching' : ''}`} data-testid="log-lines" onScroll={onScroll}>
        <div className="vspace" style={{ height }}>{lines}</div>
        {!rows && <div className="term-empty" style={{ height: '100%' }}>{error ?? (ranged ? '这段时间里没有日志' : '日志里还没有行')}</div>}
      </div>
      <BootRail board={board} die={die} marks={marks} lines={bootLines} first={pages.base} count={rows} current={pages.base + Math.floor(rowAt(view.top + view.height / 2))}
        go={line => goTo(line, 'top')} className="lboots" />
    </div>
    <div className="lfoot">
      <span>{rows ? `${ranged ? '这段时间 ' : '共 '}${rows.toLocaleString()} 行` : ''}{found ? ` · ${found.matched.toLocaleString()} 行匹配` : ''}{source === 'buffer' ? ' · 来自串口缓冲（最近的输出）' : ''}{error && rows ? ` · ${error}` : ''}</span>
      <span className="gap" />
      {!follow && <button className="pill" onClick={() => { setFollow(true); setCurrent(-1) }}><Icon name="dl" />到最新</button>}
      <button className="pill" onClick={() => void copyText(ui, logs.wget(download), '复制了 wget 命令')}><Icon name="copy" />复制 wget</button>
      <button className="pill dark" onClick={() => logs.download(download)}><Icon name="dl" />下载 .log</button>
    </div>
  </>
}
