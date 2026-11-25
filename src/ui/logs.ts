/**
 * Serial logs for every frontend: searching a board's log over a time range, downloading it in the browser, and the
 * `wget` command that fetches the same file from a terminal. URLs are absolute (from the page's own address), so the
 * command works wherever the page does, behind a reverse proxy under `/boardlab/` too.
 */
import type { LogResult } from 'boardlab-core/shared/types.ts'
import { call } from './api.ts'

export interface LogSearch {
  board: string
  die?: string
  /** `YYYY-MM-DD HH:MM:SS`, either may be empty. */
  since?: string
  until?: string
  grep?: string
  regex?: boolean
  limit?: number
}

export type { LogResult } from 'boardlab-core/shared/types.ts'

/** Where to read: a window around `at` (a position, `line:<n>`, `start` or `end`), lines before and after it. */
export interface LogWindow { board: string, die?: string, at: string, before?: number, after?: number }

function params(search: LogSearch, download: boolean): URLSearchParams {
  const p = new URLSearchParams({ board: search.board })
  if (search.die) p.set('die', search.die)
  if (search.since) p.set('since', search.since)
  if (search.until) p.set('until', search.until)
  if (search.grep) p.set('grep', search.grep)
  if (search.regex) p.set('regex', '1')
  if (search.limit) p.set('limit', String(search.limit))
  if (download) p.set('download', '1')
  return p
}

export const logs = {
  search: (search: LogSearch) => call<LogResult>('GET', `api/logs?${params(search, false)}`),
  /** Only where every match is (line numbers), and how many lines the log keeps. A newer search stops an older one. */
  hits: (search: LogSearch & { maxHits?: number }, signal?: AbortSignal) => {
    const p = params(search, false)
    p.set('hits', '1')
    if (search.maxHits) p.set('maxHits', String(search.maxHits))
    return call<LogResult>('GET', `api/logs?${p}`, undefined, signal)
  },
  /** Every boot line in the log (from line `fromLine` on, when given), and how many lines the log keeps. */
  boots: (at: { board: string, die?: string, fromLine?: number, maxMarks?: number }) => {
    const p = new URLSearchParams({ board: at.board, marks: '1' })
    if (at.die) p.set('die', at.die)
    if (at.fromLine !== undefined) p.set('fromLine', String(at.fromLine))
    if (at.maxMarks) p.set('maxMarks', String(at.maxMarks))
    return call<LogResult>('GET', `api/logs?${p}`)
  },
  /** The lines around a place in the log, each with its number. */
  window: (at: LogWindow) => {
    const p = new URLSearchParams({ board: at.board, at: at.at, before: String(at.before ?? 0), after: String(at.after ?? 0) })
    if (at.die) p.set('die', at.die)
    return call<LogResult>('GET', `api/logs?${p}`)
  },
  /**
   * Where a time range's lines are, without reading them: `base` is its first line number and `total` how many it
   * holds. A page draws a log of just that range from this, then reads its windows by number.
   */
  bounds: (at: { board: string, die?: string, since?: string, until?: string }) => {
    const p = new URLSearchParams({ board: at.board, bounds: '1' })
    if (at.die) p.set('die', at.die)
    if (at.since) p.set('since', at.since)
    if (at.until) p.set('until', at.until)
    return call<LogResult>('GET', `api/logs?${p}`)
  },
  /** The file's address, absolute from the page's own (`base`: the page's URL, for tests). */
  url: (search: LogSearch, base = location.href) => new URL(`api/logs?${params(search, true)}`, base).toString(),
  /** A shell command fetching the file, named the way the server names it. */
  wget: (search: LogSearch, base = location.href) => `wget --content-disposition '${logs.url(search, base).replace(/'/g, "'\\''")}'`,
  /** Download in the browser. */
  download(search: LogSearch) {
    const link = document.createElement('a')
    link.href = logs.url(search)
    link.download = ''
    document.body.appendChild(link)
    link.click()
    link.remove()
  },
}

/** `YYYY-MM-DD HH:MM:SS` of a Date, in local time, as serial-mux stamps its lines. */
export function stamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
}

/** Quick ranges ending now, as a person picks them. */
export const RANGES: Array<{ label: string, minutes: number | null }> = [
  { label: '最近 15 分钟', minutes: 15 }, { label: '最近 1 小时', minutes: 60 }, { label: '今天', minutes: -1 },
  { label: '最近 24 小时', minutes: 24 * 60 }, { label: '最近 7 天', minutes: 7 * 24 * 60 }, { label: '全部', minutes: null },
]

/**
 * A quick range opens at its start and does not close: a log being followed keeps growing, so "最近 1 小时" means the
 * hour before now, not the hour that had passed when the page was drawn. A custom range closes where a person said.
 */
export function rangeOf(minutes: number | null, now = new Date()): { since?: string, until?: string } {
  if (minutes === null) return {}
  if (minutes === -1) { const start = new Date(now); start.setHours(0, 0, 0, 0); return { since: stamp(start) } }
  return { since: stamp(new Date(now.getTime() - minutes * 60_000)) }
}
