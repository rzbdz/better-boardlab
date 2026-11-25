/**
 * A long console log as a page shows it: as tall as the log, with only the lines in view read from boardd, a page of
 * lines at a time. Lines are numbered as boardd numbers them (`base` to `base + total - 1`), so a line's place on the
 * page is its number times the row height, and a match boardd found is scrolled to exactly.
 *
 * Reading ahead: `prefetch` starts the pages about to be shown without waiting for them, so a jump or a flick of the
 * scrollwheel finds its lines read already. What is kept is bounded twice — by pages, and by the bytes they hold — so
 * a log of very long lines cannot grow the page without limit.
 *
 * Every frontend can use it: it knows nothing of the page, only of numbers, pages and matches.
 */
import type { LogResult } from 'boardlab-core/shared/types.ts'

/** Lines read at a time: a window of the log, aligned so the same page is never read twice. */
export const PAGE = 500
/** Pages kept: about this many times `PAGE` lines stay in the browser, the oldest read first forgotten. */
export const KEEP_PAGES = 16
/** The bytes of lines kept, a page's text counted two bytes a character: past this, the least recently read page goes. */
export const MAX_BYTES = 8 * 1024 * 1024
/** What one page may hold: a third of the budget, so the pages a view spans always fit and are never read thrashing. */
export const PAGE_BYTES = Math.floor(MAX_BYTES / 3)
/** Reads in flight at once: a fast scroll asks for many pages, and boardd is not asked for more than this at a time. */
export const MAX_INFLIGHT = 6
/** The longest a line is kept: a line longer than this is a dump, cut short for the page (the file keeps it whole). */
export const LINE_MAX = 32 * 1024
/** The shortest a line is cut to when a page of long lines has to fit its share: a readable piece, not a stub. */
const LINE_FLOOR = 512

export interface LogLine { number: number, text: string, position: string | null }

/** Reads a window of the log: `before` lines before line `at`, the line, and `after` past it. */
export type ReadWindow = (at: string, before: number, after: number) => Promise<LogResult>

/** A line as the page keeps it: cut to `LINE_MAX` characters, with a mark saying so. */
function kept(text: string): string {
  return text.length > LINE_MAX ? `${text.slice(0, LINE_MAX)} …` : text
}

/**
 * The lines of a log read so far, by page, and how big the log is. `need` reads the pages a range of line numbers
 * covers (each once, however often it is asked); `prefetch` starts them without waiting; `line` gives a line read
 * already, or null while it is not.
 */
export class LogPages {
  /** What the list shows: line numbers `base` to `base + total - 1` — the whole log, or a time range of it. */
  base = 0
  total = 0
  /** What the log itself is, as its last window answer said: a window says how big the log is, not what the list shows. */
  private logBase = 0
  private logTotal = 0
  private readonly pages = new Map<number, LogLine[]>()
  private readonly bytesOf = new Map<number, number>()
  private bytes = 0
  private readonly reading = new Map<number, Promise<void>>()
  /** Bumped when what was read no longer holds (the log was cut, or read again): reads begun before are dropped. */
  private generation = 0

  constructor(private readonly read: ReadWindow, private readonly onChange: () => void = () => {}) {}

  /** The first and one past the last line number the list shows. */
  get end(): number { return this.base + this.total }

  /**
   * Show these lines: `total` of them from `base`. Only a page that draws a time range says this — a window answer
   * says how big the log is (`size`), and taking it as the view would put the whole log back the first time a page of
   * the range was read.
   */
  show(base: number, total: number): void {
    if (base === this.base && total === this.total) return
    // Other lines than before: what was read at these numbers may not be what is there now.
    if (base !== this.base || base + total < this.end) this.forget()
    // The page that held the last line may have grown: read it again when it is next needed.
    else this.drop(this.pageOf(this.end - 1))
    this.base = base
    this.total = total
    this.onChange()
  }

  /**
   * Take what a window says of the log's own size; when the oldest lines moved, what was read of them is forgotten.
   * `justRead` is the page that answer came for: it holds the log as it is now, so it is not dropped as the old last page.
   */
  size(result: Pick<LogResult, 'base' | 'total'>, justRead?: number): void {
    const base = result.base ?? 0, total = result.total ?? 0
    if (base === this.logBase && total === this.logTotal) return
    const last = this.pageOf(this.logBase + this.logTotal - 1)
    if (base !== this.logBase || base + total < this.logBase + this.logTotal) this.forget()
    // The page that held the last line may have grown: read it again when it is next needed.
    else if (last !== justRead) this.drop(last)
    this.logBase = base
    this.logTotal = total
    this.onChange()
  }

  /** Forget every line read: the next `need` reads them again. */
  forget(): void { this.pages.clear(); this.bytesOf.clear(); this.bytes = 0; this.reading.clear(); this.generation++ }

  line(number: number): LogLine | null {
    const key = this.pageOf(number)
    const page = this.pages.get(key)
    if (!page) return null
    // Touch the page, so the pages read longest ago are the first forgotten.
    this.pages.delete(key); this.pages.set(key, page)
    return page[number - key * PAGE] ?? null
  }

  /** Read the pages covering line numbers `from` to `to` (not included) that are not read yet. */
  async need(from: number, to: number): Promise<void> {
    const lo = Math.max(from, this.base), hi = Math.min(to, this.end)
    if (hi <= lo) return
    // A page read may push another out of the budget: the range asked for is read again, once, so the view is never
    // left with blanks because a neighbour arrived after it.
    for (let pass = 0; pass < 2; pass++) {
      const reads: Array<Promise<void>> = []
      for (let page = this.pageOf(lo); page <= this.pageOf(hi - 1); page++) {
        if (this.pages.has(page)) continue
        reads.push(this.reading.get(page) ?? this.readPage(page))
      }
      if (!reads.length) return
      await Promise.all(reads)
    }
  }

  /**
   * Start reading the pages covering `from` to `to`, without waiting: what is about to be shown, so a jump or a fast
   * scroll finds its lines read. A page read already, being read, or beyond `MAX_INFLIGHT` is left alone; an error
   * leaves the page to be read again when it is needed.
   */
  prefetch(from: number, to: number): void {
    const lo = Math.max(from, this.base), hi = Math.min(to, this.end)
    if (hi <= lo) return
    for (let page = this.pageOf(lo); page <= this.pageOf(hi - 1); page++) {
      if (this.pages.has(page) || this.reading.has(page)) continue
      if (this.reading.size >= MAX_INFLIGHT) return
      this.readPage(page).catch(() => {})
    }
  }

  private pageOf(number: number): number { return Math.floor(number / PAGE) }

  /** Drop a page read, and the bytes it held. */
  private drop(page: number): void {
    if (!this.pages.delete(page)) return
    this.bytes -= this.bytesOf.get(page) ?? 0
    this.bytesOf.delete(page)
  }

  /** Keep what is kept within its bounds, the page just read always in it: the least recently read goes first. */
  private trim(justRead: number): void {
    while (this.pages.size > KEEP_PAGES || (this.bytes > MAX_BYTES && this.pages.size > 1)) {
      const oldest = this.pages.keys().next().value
      if (oldest === undefined || oldest === justRead) break
      this.drop(oldest)
    }
  }

  private readPage(page: number): Promise<void> {
    const generation = this.generation
    const start = page * PAGE
    const reading = this.read(`line:${start}`, 0, PAGE - 1).then(result => {
      if (generation !== this.generation) return
      this.reading.delete(page)
      const lines: LogLine[] = result.lines.map((text, index) => ({ number: result.numbers?.[index] ?? start + index, text: kept(text), position: result.positions?.[index] ?? null }))
      // A page of very long lines is cut down to its share of the budget, evenly, so the pages a view spans always fit
      // and no page can push its neighbour out. Ordinary lines are under the share and are kept whole.
      let bytes = lines.reduce((sum, line) => sum + 2 * line.text.length, 0)
      if (bytes > PAGE_BYTES && lines.length) {
        const share = Math.max(LINE_FLOOR, Math.floor(PAGE_BYTES / (2 * lines.length)))
        for (const line of lines) if (line.text.length > share) line.text = `${line.text.slice(0, share)} …`
        bytes = lines.reduce((sum, line) => sum + 2 * line.text.length, 0)
      }
      // A page boardd answered from elsewhere (the line asked for was gone): its lines go where their numbers say.
      const slots: Array<LogLine | null> = new Array(PAGE).fill(null)
      for (const line of lines) if (this.pageOf(line.number) === page) slots[line.number - start] = line
      this.drop(page)
      this.pages.set(page, slots as LogLine[])
      this.bytesOf.set(page, bytes)
      this.bytes += bytes
      this.trim(page)
      this.size(result, page)
      this.onChange()
    }, error => { if (generation === this.generation) this.reading.delete(page); throw error })
    this.reading.set(page, reading)
    return reading
  }
}

/** The line numbers in view, for a scroll position, plus `spare` lines on either side so a short scroll is ready. */
export function inView(scrollTop: number, height: number, row: number, base: number, total: number, spare = PAGE / 2): { from: number, to: number } {
  const first = base + Math.floor(Math.max(0, scrollTop) / row), last = base + Math.ceil((Math.max(0, scrollTop) + height) / row)
  return { from: Math.max(base, first - spare), to: Math.min(base + total, last + spare) }
}

/**
 * Which match to go to: the first after line `from` (`next`) or the last before it, going round at the ends; -1 when
 * there are none. `hits` are line numbers in order, so this is a binary search however many there are.
 */
export function nextHit(hits: readonly number[], from: number, direction: 'next' | 'previous'): number {
  if (!hits.length) return -1
  let lo = 0, hi = hits.length
  if (direction === 'next') {
    while (lo < hi) { const mid = (lo + hi) >> 1; if (hits[mid]! <= from) lo = mid + 1; else hi = mid }
    return lo < hits.length ? lo : 0
  }
  while (lo < hi) { const mid = (lo + hi) >> 1; if (hits[mid]! < from) lo = mid + 1; else hi = mid }
  return lo > 0 ? lo - 1 : hits.length - 1
}

/** Whether line `number` is a match: a binary search of the match numbers. */
export function isHit(hits: readonly number[], number: number): boolean {
  let lo = 0, hi = hits.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (hits[mid]! < number) lo = mid + 1; else hi = mid }
  return lo < hits.length && hits[lo] === number
}
