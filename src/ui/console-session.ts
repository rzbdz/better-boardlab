/** Browser-independent lifecycle of a serial console stream and its ordered keyboard input. */
import { api } from './api.ts'

export type ConsoleStatus = 'connecting' | 'live' | 'closed' | 'retry'

export interface ConsoleSessionOptions {
  board: string
  die?: string
  onOutput: (text: string) => void
  onStatus: (status: ConsoleStatus) => void
  onError: (error: unknown) => void
}

export interface ConsoleSession {
  readonly status: ConsoleStatus
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
const INPUT_BATCH_MS = 8
const text = (error: unknown) => error instanceof Error ? error.message : String(error)

export function createConsoleSession(options: ConsoleSessionOptions): ConsoleSession {
  const { board, die, onOutput, onStatus, onError } = options
  const url = `api/console?raw=1&board=${encodeURIComponent(board)}${die ? `&die=${encodeURIComponent(die)}` : ''}`
  let source: EventSource | null = null
  let status: ConsoleStatus = 'connecting'
  let shown = false, tail = '', disposed = false, attempts = 0
  let retry: ReturnType<typeof setTimeout> | undefined
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
  const setStatus = (next: ConsoleStatus) => {
    if (disposed) return
    status = next
    onStatus(next)
  }
  const closeSource = () => {
    const old = source
    source = null
    old?.close()
  }
  const schedule = () => {
    clearTimeout(retry)
    retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, MAX_RETRY_MS))
  }
  const dropped = (next: 'closed' | 'retry', marker?: string) => {
    closeSource()
    if (disposed) return
    if (marker) onOutput(marker)
    setStatus(next)
    schedule()
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
      onOutput(`\r\n\x1b[2m[串口重新连接${missed.length ? `，补上断开期间的 ${missed.length} 行` : ''}]\x1b[0m\r\n` + (missed.length ? missed.join('\r\n') + '\r\n' : ''))
    }
    tail = lines.slice(-5).map(line => line.replace(LOG_STAMP, '')).join('\n')
    attempts = 0
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
    stream.addEventListener('history', event => { if (active()) history(event) })
    stream.addEventListener('output', event => {
      if (!active()) return
      const value = read(event)
      if (typeof value !== 'string') { if (value !== undefined) report(new Error('Invalid console output')); return }
      onOutput(value)
      tail = (tail + value).slice(-4096).split('\n').map(line => line.replace(LOG_STAMP, '')).join('\n')
    })
    stream.addEventListener('closed', event => {
      if (!active()) return
      const reason = read(event)
      if (event.data && reason === undefined) return
      dropped('closed', `\r\n\x1b[2m[串口断开${event.data && typeof reason === 'string' ? `：${reason}` : ''}，重连中…]\x1b[0m\r\n`)
    })
    stream.onerror = () => { if (active()) dropped('retry') }
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

/** Consistent text for both browser notification styles, including non-Error failures. */
export function consoleErrorText(error: unknown): string { return text(error) }
