/** Browser-independent lifecycle of a serial console stream and its ordered keyboard input. */
import { api } from './api.ts'

export type ConsoleStatus = 'connecting' | 'live' | 'closed' | 'retry'

export interface ConsoleSessionOptions {
  board: string
  die?: string
  onOutput: (text: string) => void
  /** `reason` says why a stream that is not live dropped, when boardd said (or the page could tell). */
  onStatus: (status: ConsoleStatus, reason: string | null) => void
  onError: (error: unknown) => void
}

export interface ConsoleSession {
  readonly status: ConsoleStatus
  /** Why the console is not live, as a person reads it (`串口断开：…`, `串口打不开：…`, `服务重启`), or null when nobody said. */
  readonly reason: string | null
  /** Close a failed stream and connect again now; does nothing to a live or disposed session. */
  reconnect(): void
  /** Queue keyboard data for the next 8 ms batch. */
  input(data: string): void
  /** Send the current input batch without starting a stream. */
  flush(): void
  dispose(): void
}

// serial-mux prefixes backlog lines with their read time. Ignore those prefixes and terminal styling when finding
// the point at which a replacement stream's history continues the output already on screen.
// eslint-disable-next-line no-control-regex
const ANSI_CODES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g
const LOG_STAMP = /^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\] ?/
const MAX_RETRY_MS = 10_000
/** boardd sends a `ping` every 15 s: this long without any event means the stream hangs half-open, so it is dropped. */
export const SILENCE_MS = 40_000
/** What boardd says when it stops, and what the page says when it reconnects to a boardd that restarted meanwhile. */
export const RESTART_REASON = '服务重启'
/**
 * The words for a console's status, the same in every frontend and in the CLI's markers: a port that was live and went
 * is 串口断开, one that never came up is 串口打不开, boardd stopping is 服务重启. The page reconnects, so its markers end
 * in 重连中…; the CLI stops, so its markers are the reason alone.
 */
export const CONSOLE_WORDS: Record<ConsoleStatus, string> = { connecting: '连接中', live: '实时', closed: '串口断开，重连中', retry: '重连中' }
/** Why a stream ended, as a person reads it: whether the port had come up on that stream decides which. */
export const closedReason = (said: string, opened: boolean) => `${opened ? '串口断开' : '串口打不开'}：${said}`
const INPUT_BATCH_MS = 8
const text = (error: unknown) => error instanceof Error ? error.message : String(error)

export function createConsoleSession(options: ConsoleSessionOptions): ConsoleSession {
  const { board, die, onOutput, onStatus, onError } = options
  const url = `api/console?raw=1&board=${encodeURIComponent(board)}${die ? `&die=${encodeURIComponent(die)}` : ''}`
  let source: EventSource | null = null
  let status: ConsoleStatus = 'connecting'
  let shown = false, tail = '', disposed = false, attempts = 0
  let reason: string | null = null
  // What boardd said in the last marker on the screen: a console that keeps failing for the same reason says so once,
  // even when the words around it change (串口断开 for the stream it was live on, 串口打不开 for the retries after).
  let marked: string | null = null
  // The boardd process the last stream came from (its `hello`): another one on reconnect means boardd restarted.
  let boot: string | null = null, restarted = false
  let retry: ReturnType<typeof setTimeout> | undefined
  let silence: ReturnType<typeof setTimeout> | undefined
  let pending = '', inputTimer: ReturnType<typeof setTimeout> | undefined
  let chain = Promise.resolve()

  const report = (error: unknown) => {
    if (disposed) return
    try { onError(error) } catch { /* A notification must not break the console stream. */ }
  }
  const read = (event: Event): unknown => {
    try { return JSON.parse((event as MessageEvent).data) }
    catch (error) { report(error); return undefined }
  }
  const setStatus = (next: ConsoleStatus, why: string | null = next === 'live' ? null : reason) => {
    if (disposed) return
    status = next
    reason = why
    onStatus(next, why)
  }
  const closeSource = () => {
    clearTimeout(silence)
    silence = undefined
    const old = source
    source = null
    old?.close()
  }
  // Every console of every page that lost one boardd would come back at the same moment: each waits a random part
  // of its backoff (between half and all of it), and starts again from one second once a stream is live.
  const schedule = () => {
    clearTimeout(retry)
    const full = Math.min(1000 * 2 ** attempts++, MAX_RETRY_MS)
    retry = setTimeout(connect, Math.round(full / 2 + Math.random() * full / 2))
  }
  /**
   * The stream ended: try again a while later. With `said` (what boardd said, or '' when nothing), the screen is told
   * why, unless its last marker said the same.
   */
  const dropped = (next: 'closed' | 'retry', why: string | null, said?: string) => {
    closeSource()
    if (disposed) return
    if (said !== undefined && said !== marked) { onOutput(`\r\n\x1b[2m[${why ?? '串口断开'}，重连中…]\x1b[0m\r\n`); marked = said }
    setStatus(next, why)
    schedule()
  }
  /** A sign of life from the stream: the next one must come within SILENCE_MS. */
  const heard = (stream: EventSource) => {
    clearTimeout(silence)
    silence = setTimeout(() => { if (source === stream && !disposed) dropped('retry', '连接没有回应') }, SILENCE_MS)
  }
  const lastLine = () => tail.replace(ANSI_CODES, '').split(/\r?\n/).map(line => line.replace(LOG_STAMP, '').trim()).filter(Boolean).at(-1) ?? null

  function history(event: Event) {
    const value = read(event)
    if (!Array.isArray(value) || !value.every(line => typeof line === 'string')) {
      report(new Error('Invalid console history'))
      return
    }
    const lines = value
    if (!shown) {
      onOutput(lines.join('\r\n') + '\r\n')
      shown = true
    } else {
      const last = lastLine()
      const at = last === null ? -1 : lines.findLastIndex(line => line.replace(ANSI_CODES, '').replace(LOG_STAMP, '').trim() === last)
      // If the old tail is absent from this backlog, repeating all of it is worse than asking for a manual refresh.
      const missed = at >= 0 ? lines.slice(at + 1) : []
      onOutput(`\r\n\x1b[2m[${restarted ? `${RESTART_REASON}，` : ''}串口重新连接${missed.length ? `，补上断开期间的 ${missed.length} 行` : ''}]\x1b[0m\r\n` + (missed.length ? missed.join('\r\n') + '\r\n' : ''))
    }
    tail = lines.slice(-5).map(line => line.replace(LOG_STAMP, '')).join('\n')
    attempts = 0
    restarted = false
    marked = null
    setStatus('live')
  }

  function connect() {
    if (disposed) return
    clearTimeout(retry)
    retry = undefined
    closeSource()
    setStatus(shown ? 'retry' : 'connecting')
    const stream = new EventSource(url)
    source = stream
    // Closing an EventSource does not guarantee that an already queued callback will not run. Identity checks keep
    // events from an old connection from changing output, retry timers, or status on its replacement.
    const active = () => source === stream && !disposed
    // Whether this stream's port came up (its history arrived): a `closed` before it means the port did not open.
    let opened = false
    // An EventSource that hangs half-open never errors: silence is what tells.
    heard(stream)
    stream.addEventListener('ping', () => { if (active()) heard(stream) })
    stream.addEventListener('hello', event => {
      if (!active()) return
      heard(stream)
      const value = read(event) as { boot?: unknown } | undefined
      if (typeof value?.boot !== 'string') return
      if (boot && boot !== value.boot) { restarted = true; setStatus('retry', RESTART_REASON) }
      boot = value.boot
    })
    stream.addEventListener('history', event => { if (active()) { heard(stream); opened = true; history(event) } })
    stream.addEventListener('output', event => {
      if (!active()) return
      heard(stream)
      const value = read(event)
      if (typeof value !== 'string') { if (value !== undefined) report(new Error('Invalid console output')); return }
      onOutput(value)
      tail = (tail + value).slice(-4096).split('\n').map(line => line.replace(LOG_STAMP, '')).join('\n')
    })
    stream.addEventListener('closed', event => {
      if (!active()) return
      const said = read(event)
      if (event.data && said === undefined) return
      const text = event.data && typeof said === 'string' ? said : ''
      // A console that keeps failing says so once on the screen, and stays in the status, not again at every retry.
      dropped('closed', text ? closedReason(text, opened) : null, text)
    })
    // boardd stopping (a restart, an update): not the port.
    stream.addEventListener('restart', event => {
      if (!active()) return
      const said = read(event) as { reason?: unknown } | undefined
      const why = typeof said?.reason === 'string' && said.reason ? said.reason : RESTART_REASON
      dropped('retry', why, `\0${why}`)
    })
    stream.onerror = () => { if (active()) dropped('retry', status === 'live' ? null : reason) }
  }

  const flush = () => {
    clearTimeout(inputTimer)
    inputTimer = undefined
    const data = pending
    pending = ''
    if (!data) return
    chain = chain.then(async () => { await api.input(board, die, data) }).catch(report)
  }
  const session: ConsoleSession = {
    get status() { return status },
    get reason() { return reason },
    reconnect() { if (!disposed && status !== 'live') connect() },
    input(data) {
      if (disposed) return
      pending += data
      clearTimeout(inputTimer)
      inputTimer = setTimeout(flush, INPUT_BATCH_MS)
    },
    flush,
    dispose() {
      if (disposed) return
      flush()
      disposed = true
      clearTimeout(retry)
      retry = undefined
      closeSource()
    },
  }
  connect()
  return session
}

/** The status a frontend shows: its own word for it, with the reason boardd gave when there is one. */
export function consoleStatusText(status: ConsoleStatus, reason: string | null, words: Record<ConsoleStatus, string>): string {
  return status === 'live' || !reason ? words[status] : `${reason}，重连中`
}

/** Consistent text for both browser notification styles, including non-Error failures. */
export function consoleErrorText(error: unknown): string { return text(error) }
