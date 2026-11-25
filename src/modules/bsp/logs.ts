/**
 * A board host's console log as boardlab reads it: the `bsp dut logs` arguments a log query becomes, and its answer
 * (in the host's words) as a log range. The host keeps each console's log by day and indexes it, so it reads a window
 * around a line, the numbers of every match and the boot lines where the log is.
 */
import type { LabConfig, LogQuery } from 'boardlab-core/core/backend.ts'
import type { BootMark, LogRange } from 'boardlab-core/shared/types.ts'
import { readLog } from 'boardlab-core/core/consoles.ts'

/** A board host's answer to `bsp dut logs`: its lines, numbered and placed (an older host gives only the lines). */
export interface HostLog {
  lines: string[], matched?: number, truncated?: boolean, positions?: Array<string | null>, numbers?: number[], total?: number
  hits?: number[], hits_truncated?: boolean, marks?: Array<{ line: number, id: string, text: string }>, marks_truncated?: boolean
  at?: string | null, more_before?: boolean, more_after?: boolean, snapped?: boolean
}

/** The `bsp dut logs <device>` arguments for a query: a window around `at`, or a search with what it also asks for. */
export function logArgs(device: string, query: LogQuery): string[] {
  if (query.at != null) return ['dut', 'logs', device, '--at', query.at, '--before', String(query.before ?? 0), '--after', String(query.after ?? 0)]
  return ['dut', 'logs', device,
    ...(query.since ? ['--since', query.since] : []), ...(query.until ? ['--until', query.until] : []),
    ...(query.grep ? ['--grep', query.grep] : []), ...(query.regex ? ['--regex'] : []),
    '--limit', String(query.limit ?? 20000), ...(query.first ? ['--first'] : []),
    ...(query.hits ? ['--hits', ...(query.maxHits ? ['--max-hits', String(query.maxHits)] : [])] : []),
    ...(query.marks ? ['--marks', JSON.stringify(query.marks.map(({ id, pattern, flags }) => ({ id, pattern, flags: flags ?? '' }))), ...(query.maxMarks ? ['--max-marks', String(query.maxMarks)] : [])] : []),
    ...(query.fromLine !== undefined ? ['--from-line', String(query.fromLine)] : []),
  ]
}

/** What the host answered, as a log range: its line numbers start at 0 (its oldest kept line), its positions its own. */
export function logRange(found: HostLog, window: boolean): LogRange {
  return {
    lines: found.lines, matched: found.matched ?? found.lines.length, truncated: found.truncated ?? false,
    ...(found.positions ? { positions: found.positions.map(position => position ?? '') } : {}), ...(found.numbers ? { numbers: found.numbers } : {}),
    ...(found.total !== undefined ? { total: found.total, base: 0 } : {}),
    ...(found.hits ? { hits: found.hits, hitsTruncated: !!found.hits_truncated } : {}),
    ...(found.marks ? { marks: found.marks, marksTruncated: !!found.marks_truncated } : {}),
    ...(window ? { at: found.at ?? null, moreBefore: !!found.more_before, moreAfter: !!found.more_after, snapped: !!found.snapped } : {}),
  }
}

/** A board's boot marks are kept this long: they change only with the site's SoC facts. */
const MARKS_TTL_MS = 10 * 60_000

/** What each board's marks were, and when they were read. One cache for the module: a site sync drops all of it. */
const knownMarks = new Map<string, { at: number, value: Promise<BootMark[]> }>()

/** The site changed (its SoC facts may have): every board's marks are read again when next asked. */
export function forgetBootMarks() { knownMarks.clear() }

/**
 * A board's boot marks (`bsp dut boot-marks`: its SoC's boot ROM lines and any the site adds), asked once a while per
 * board. An older host has none, and the core's still apply.
 */
export function bootMarksOf(ask: (config: LabConfig, device: string) => Promise<{ marks?: BootMark[] }>) {
  const known = knownMarks
  return (config: LabConfig, device: string): Promise<BootMark[]> => {
    const key = `${config.url}\0${device}`, now = Date.now(), had = known.get(key)
    if (had && now - had.at < MARKS_TTL_MS) return had.value
    const value = ask(config, device).then(got => Array.isArray(got.marks) ? got.marks : [], () => [])
    known.set(key, { at: now, value })
    return value
  }
}

/** How many of its last lines a host too old to index its logs is asked for, to read them here instead. */
export const OLD_HOST_LINES = 20_000

/** Whether a query asks for what only a host that indexes its logs answers. */
export function newerQuery(query: LogQuery): boolean {
  return query.at != null || !!query.hits || !!query.marks || query.fromLine !== undefined
}

/** A host's refusal of flags it does not know: one installed before it indexed its logs. */
export function olderHost(error: unknown): boolean {
  return /unrecognized arguments|invalid choice|no such option/i.test((error as Error)?.message ?? '')
}

/**
 * A query answered from the last lines of a host too old to index its logs, numbered from the first of them: the same
 * answer the console's buffer gives, so the page reads such a host as it reads a board without a log of its own.
 */
export function oldHostLog(found: HostLog, query: LogQuery): LogRange {
  return readLog(found.lines, 0, 'old', query)
}
