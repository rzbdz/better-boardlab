/**
 * Boots in a console's log, for every frontend: the lines that open a boot stage (as boardd lists them for a board),
 * grouped into boots, which ones a person chose to see (remembered per console), and an xterm addon that finds them
 * in the live console as its output is written.
 *
 * A boot is a run of stages in order: a stage no later than the one before starts a new boot (a reset), so a board
 * that prints U-Boot SPL, OpenSBI, U-Boot and Linux, then is reset and prints U-Boot SPL again, has two boots.
 */
import type { IDisposable, IMarker, ITerminalAddon, Terminal } from '@xterm/xterm'
import type { BootLine, BootMark } from 'boardlab-core/shared/types.ts'
import { call } from './api.ts'

export type { BootLine, BootMark }

/** A boot: where it starts, its stages in order, and the number it has counted from the oldest (1 is the first). */
export interface Boot { number: number, line: number, stages: BootLine[] }

/** How long a board's boot marks are kept on the page: a site sync changes them, and the page is not reloaded for it. */
const MARKS_TTL_MS = 60_000

const marksOf = new Map<string, { at: number, value: Promise<BootMark[]> }>()
/** The boot marks of a board's console: asked at most once a minute, and again when its console is opened again. */
export function bootMarks(board: string, die?: string): Promise<BootMark[]> {
  const key = `${board}\0${die ?? ''}`, now = Date.now()
  const had = marksOf.get(key)
  if (had && now - had.at < MARKS_TTL_MS) return had.value
  // An older boardd has no boot marks: none, rather than an answer that is not a list.
  const value = call<unknown>('GET', `api/boot-marks?board=${encodeURIComponent(board)}${die ? `&die=${encodeURIComponent(die)}` : ''}`)
    .then(got => Array.isArray(got) ? got as BootMark[] : [])
  value.catch(() => marksOf.delete(key))
  marksOf.set(key, { at: now, value })
  return value
}

/** A console is opened again: its marks are asked for again (the rules may have changed since the page read them). */
export function forgetBootMarks(board: string, die?: string) { marksOf.delete(`${board}\0${die ?? ''}`) }

/** Group boot lines (in line order) into boots: a stage no later than the one before it starts a new boot. */
export function groupBoots(lines: readonly BootLine[], marks: readonly BootMark[]): Boot[] {
  const stage = new Map(marks.map(mark => [mark.id, mark.stage]))
  const boots: Boot[] = []
  let last = Infinity
  for (const found of lines) {
    const at = stage.get(found.id) ?? 0
    if (!boots.length || at <= last) boots.push({ number: boots.length + 1, line: found.line, stages: [] })
    boots.at(-1)!.stages.push(found)
    last = at
  }
  return boots
}

/** The boot line to go to: the last one before line `from` (`previous`) or the first after it, or null. Binary search. */
export function bootNear(lines: readonly BootLine[], from: number, direction: 'next' | 'previous'): BootLine | null {
  let lo = 0, hi = lines.length
  if (direction === 'next') {
    while (lo < hi) { const mid = (lo + hi) >> 1; if (lines[mid]!.line <= from) lo = mid + 1; else hi = mid }
    return lines[lo] ?? null
  }
  while (lo < hi) { const mid = (lo + hi) >> 1; if (lines[mid]!.line < from) lo = mid + 1; else hi = mid }
  return lo > 0 ? lines[lo - 1]! : null
}

const SHOWN_KEY = 'boardlab.boots.shown'
/**
 * Which kinds of boot line a person shows for a console (`board.die`): the ids left out, kept in this browser, so a
 * console shows only kernel boots again the next time if that was what was chosen. Empty: all.
 */
export function hiddenMarks(board: string, die?: string): string[] {
  try { const all = JSON.parse(localStorage.getItem(SHOWN_KEY) ?? '{}'); const hidden = all[`${board}.${die ?? ''}`]; return Array.isArray(hidden) ? hidden.filter(id => typeof id === 'string') : [] } catch { return [] }
}
export function setHiddenMarks(board: string, die: string | undefined, hidden: string[]): void {
  try {
    const all = JSON.parse(localStorage.getItem(SHOWN_KEY) ?? '{}')
    const key = `${board}.${die ?? ''}`
    if (hidden.length) all[key] = hidden; else delete all[key]
    localStorage.setItem(SHOWN_KEY, JSON.stringify(all))
  } catch {}
}

/** How many cells of a row the cheap test reads: every mark the core and a SoC ship starts well within its first words. */
const PREFIX_CELLS = 24

/**
 * The literal characters a pattern must see, in order, before anything it does not pin down: `U-Boot (?:SPL|TPL)
 * \\d{4}` gives `U-Boot S`, which a row that could match holds in its first cells. A pattern that starts with something
 * other than a literal (a group, `.`, a class, an anchor) gives '' and is tested every time.
 */
export function literalPrefix(pattern: string): string {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === '\\') { const next = pattern[i + 1]; if (!next || !/[A-Za-z0-9 ]/.test(next)) return out; out += next; i++; continue }
    if (/[A-Za-z0-9 _:./-]/.test(ch)) { out += ch; continue }
    break
  }
  return out
}

/** A boot line in the live console: which mark, its text, and the xterm marker that follows its line as output scrolls. */
export interface LiveBootLine { id: string, text: string, marker: IMarker }

/**
 * An xterm addon that finds boot lines in what the console writes: each line, once complete, is matched against the
 * marks (one combined expression), and a match keeps a marker on its line, so where it is stays right as the buffer
 * scrolls and trims. `onChange` is told when the list changes (a line found, or one trimmed away).
 */
export class BootMarksAddon implements ITerminalAddon {
  private term: Terminal | null = null
  private any: ((text: string) => boolean) | null = null
  /** Each mark, with the first run of characters its pattern must see where it is not anchored ('' : from anywhere). */
  private each: Array<{ id: string, rx: RegExp, prefix: string }> = []
  /** Whether any mark can match in the middle of a row: the cheap test for a row's first cells cannot rule those out. */
  private unanchored = false
  /**
   * Where the scan stopped: a marker on the row the cursor was on. It moves with the lines the scrollback drops its
   * oldest of, so where the scan reached is still known after any number of them, and reading only what is new costs
   * nothing per trimmed line. A boot menu erasing the screen clears the markers on the rows it shows, this one among
   * them: then the scan starts at the top of the screen, the first row an application may have rewritten.
   */
  private next: IMarker | null = null
  private readonly found: LiveBootLine[] = []
  private readonly listeners = new Set<() => void>()
  private readonly disposables: IDisposable[] = []

  activate(term: Terminal): void {
    this.term = term
    this.disposables.push(term.onWriteParsed(() => this.scan()))
  }

  dispose(): void {
    for (const item of this.disposables.splice(0)) item.dispose()
    for (const found of this.found.splice(0)) found.marker.dispose()
    this.next?.dispose()
    this.next = null
    this.term = null
  }

  /** Look for these marks, in the lines already written too. */
  setMarks(marks: readonly BootMark[]): void {
    const blind = marks.filter(mark => mark.flags === 'i'), plain = marks.filter(mark => mark.flags !== 'i')
    const join = (group: readonly BootMark[], flags: string) => group.length ? new RegExp(group.map(mark => `(?:${mark.pattern})`).join('|'), flags) : null
    const both = [join(plain, ''), join(blind, 'i')].filter((rx): rx is RegExp => !!rx)
    this.any = both.length ? text => both.some(rx => rx.test(text)) : null
    this.each = marks.map(mark => ({ id: mark.id, rx: new RegExp(mark.pattern, mark.flags ?? ''), prefix: literalPrefix(mark.pattern) }))
    this.unanchored = marks.some(mark => !mark.pattern.startsWith('^'))
    this.reset()
  }

  /** The boot lines in the console now, oldest first. */
  get lines(): readonly LiveBootLine[] {
    // A marker whose line was trimmed from the scrollback is gone.
    if (this.found.some(found => found.marker.isDisposed || found.marker.line < 0)) {
      const kept = this.found.filter(found => !found.marker.isDisposed && found.marker.line >= 0)
      this.found.splice(0, this.found.length, ...kept)
    }
    return this.found
  }

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn) }

  /** Forget what was found (the console was cleared). */
  reset(): void { this.forget(); this.scan(); this.tell() }

  /** Drop the boot lines found so far, as a scan about to read the whole buffer again does. */
  private forget(): void {
    for (const found of this.found.splice(0)) found.marker.dispose()
    this.next?.dispose()
    this.next = null
  }

  private tell() { for (const fn of this.listeners) fn() }

  /**
   * Match the lines written since the last scan, up to the cursor's row (which may not be finished yet).
   *
   * Where to go on from is a marker on the row it stopped at: a marker moves with the lines the scrollback drops its
   * oldest of, so reading only what is new costs nothing per trimmed line, however long the console writes. When a boot
   * menu clears the screen (GRUB's countdown, EDK II's menu) the rows it shows are erased and their markers with them,
   * and the scan starts at the top of the screen — where the menu rewrote from — rather than at the top of a buffer
   * that may hold a few hundred thousand lines, which is where this used to spend the page's time.
   */
  private scan(): void {
    const term = this.term
    if (!term || !this.any) return
    const buffer = term.buffer.active
    if (buffer.type !== 'normal') return
    const end = buffer.baseY + buffer.cursorY
    const top = buffer.baseY
    const marker = this.next
    // From the row the last scan stopped on (it was the cursor's, and may have been unfinished then) to the cursor's
    // row, which is left for the next scan. From the top of the buffer when nothing was scanned yet; from the top of
    // the screen when the marker went with a cleared row (where the application rewrote from) or when its line was
    // trimmed out of the scrollback (then nothing above the screen is left to read either).
    const from = marker ? (!marker.isDisposed ? Math.max(top, Math.min(marker.line, end)) : top) : 0
    let changed = false
    for (let y = from; y < end; y++) {
      const row = buffer.getLine(y)
      // A wrapped row continues the line above it: matched with it.
      if (!row || row.isWrapped) continue
      // A rescan of a long buffer reads only what could match: a mark's pattern starts with these characters (or, for
      // one that can match anywhere, the row is read whole). A wrapped line is read whole for the test.
      const lead = row.isWrapped ? '' : row.translateToString(true, 0, PREFIX_CELLS)
      if (!this.maybe(lead, row)) continue
      let text = row.translateToString(true)
      for (let next = y + 1; next < end; next++) { const more = buffer.getLine(next); if (!more?.isWrapped) break; text += more.translateToString(true) }
      if (!this.any(text)) continue
      const which = this.each.find(mark => mark.rx.test(text))
      if (!which) continue
      // A row already read is never counted again: a resize reflows the buffer under the marker, and where the scan
      // goes on from may then be a row or so behind where it really was.
      if (this.found.some(found => !found.marker.isDisposed && found.marker.line === y)) continue
      const line = term.registerMarker(y - end)
      if (!line) continue
      this.found.push({ id: which.id, text: text.slice(0, 200), marker: line })
      changed = true
    }
    // Where the next scan goes on: the row under the cursor, which moves with the lines the scrollback drops.
    this.next?.dispose()
    this.next = term.registerMarker(0) ?? null
    if (changed) this.tell()
  }

  /** Whether a row's first cells could hold any mark: a mark whose pattern starts with literal characters is looked for
   *  by them in the first cells, and one that can match anywhere is always a candidate. */
  private maybe(lead: string, row: { isWrapped: boolean }): boolean {
    if (!lead || row.isWrapped) return true
    if (this.unanchored) return true
    return this.each.some(mark => !mark.prefix || lead.includes(mark.prefix))
  }
}
