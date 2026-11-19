/** The shared browser console lifecycle, with every stream, timer and input request under test control. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/ui/api.ts'
import { CONSOLE_WORDS, consoleErrorText, consoleStatusText, createConsoleSession, type ConsoleStatus } from '../src/ui/console-session.ts'

const STATUS_TEXT: Record<ConsoleStatus, string> = CONSOLE_WORDS

vi.mock('../src/ui/api.ts', () => ({ api: { input: vi.fn() } }))

class FakeEventSource {
  static readonly instances: FakeEventSource[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readonly readyState = FakeEventSource.OPEN
  onerror: ((event: Event) => void) | null = null
  close = vi.fn()
  private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>()

  constructor(readonly url: string) { FakeEventSource.instances.push(this) }
  addEventListener(name: string, listener: (event: MessageEvent) => void) {
    const listeners = this.listeners.get(name) ?? []
    listeners.push(listener)
    this.listeners.set(name, listeners)
  }
  emit(name: 'history' | 'output' | 'closed' | 'ping' | 'hello' | 'restart', data: unknown, encoded = false) {
    const event = { data: encoded || name === 'output' || typeof data !== 'string' ? JSON.stringify(data) : data } as MessageEvent
    for (const listener of this.listeners.get(name) ?? []) listener(event)
  }
  error() { this.onerror?.(new Event('error')) }
}

const streams = FakeEventSource.instances
const input = vi.mocked(api.input)
let output: string[]
let statuses: ConsoleStatus[]
let reasons: Array<string | null>
let errors: unknown[]

function open() {
  return createConsoleSession({
    board: 'a board', die: 'die/0',
    onOutput: text => output.push(text),
    onStatus: (status, reason) => { statuses.push(status); reasons.push(reason) },
    onError: error => errors.push(error),
  })
}
const tick = async () => { await vi.advanceTimersByTimeAsync(0) }

beforeEach(() => {
  vi.useFakeTimers()
  streams.length = 0
  output = []
  statuses = []
  reasons = []
  errors = []
  // The full backoff, unless a test asks for the jitter.
  vi.spyOn(Math, 'random').mockReturnValue(1)
  input.mockReset()
  input.mockResolvedValue(undefined)
  vi.stubGlobal('EventSource', FakeEventSource)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('console session streams', () => {
  it('uses the board and die URL, keeps one stream, and retries with a bounded backoff', async () => {
    const session = open()
    expect(streams).toHaveLength(1)
    expect(streams[0]!.url).toBe('api/console?raw=1&board=a%20board&die=die%2F0')
    expect(statuses).toEqual(['connecting'])

    const delays = [1000, 2000, 4000, 8000, 10_000, 10_000]
    for (const delay of delays) {
      const dropped = streams.at(-1)!
      dropped.error()
      const count = streams.length
      expect(dropped.close).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(streams).toHaveLength(count)
      await vi.advanceTimersByTimeAsync(1)
      expect(streams).toHaveLength(count + 1)
    }
    expect(statuses).toEqual(Array.from({ length: 13 }, (_, index) => index % 2 ? 'retry' : 'connecting'))
    streams.at(-1)!.error()
    expect(session.status).toBe('retry')
    session.dispose()
  })

  it('resets the retry delay after a successful history', async () => {
    const session = open()
    streams[0]!.error()
    await vi.advanceTimersByTimeAsync(1000)
    streams[1]!.emit('history', ['live'])
    streams[1]!.error()
    await vi.advanceTimersByTimeAsync(999)
    expect(streams).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(streams).toHaveLength(3)
    session.dispose()
  })

  it('reconnects immediately when asked, cancels the old retry, and ignores every stale event', async () => {
    const session = open()
    const old = streams[0]!
    old.emit('history', ['ready'])
    expect(session.status).toBe('live')
    session.reconnect()
    expect(streams).toHaveLength(1)

    old.error()
    expect(streams).toHaveLength(1)
    session.reconnect()
    expect(streams).toHaveLength(2)
    expect(old.close).toHaveBeenCalledOnce()
    const current = streams[1]!
    output.length = 0
    old.emit('history', ['stale'])
    old.emit('output', 'stale')
    old.emit('closed', 'stale close')
    old.error()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(output).toEqual([])
    expect(streams).toHaveLength(2)
    expect(session.status).toBe('retry')

    current.emit('history', ['ready', 'new'])
    expect(session.status).toBe('live')
    expect(output.join('')).toContain('补上断开期间的 1 行')
    expect(output.join('')).toContain('new\r\n')
    session.dispose()
  })

  it('keeps the explicit closed status and reason while it schedules a reconnect', async () => {
    const session = open()
    streams[0]!.emit('history', ['boot'])
    output.length = 0
    streams[0]!.emit('closed', 'port gone', true)
    expect(session.status).toBe('closed')
    expect(output.join('')).toContain('串口断开：port gone，重连中…')
    await vi.advanceTimersByTimeAsync(1000)
    expect(streams).toHaveLength(2)
    expect(session.status).toBe('retry')
    session.dispose()
  })

  it('waits a random part of each backoff, so the consoles of every page do not all come back at once', async () => {
    vi.mocked(Math.random).mockReturnValue(0)
    const session = open()
    for (const delay of [500, 1000, 2000, 4000, 5000]) {
      streams.at(-1)!.error()
      const count = streams.length
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(streams).toHaveLength(count)
      await vi.advanceTimersByTimeAsync(1)
      expect(streams).toHaveLength(count + 1)
    }
    session.dispose()
  })

  it('takes 40 s without a ping or any other event as a dropped stream, and reconnects', async () => {
    const session = open()
    streams[0]!.emit('history', ['boot'])
    // boardd's pings keep a quiet console alive.
    for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(15_000); streams[0]!.emit('ping', Date.now()) }
    expect(streams).toHaveLength(1)
    expect(session.status).toBe('live')
    await vi.advanceTimersByTimeAsync(39_999)
    expect(streams[0]!.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(streams[0]!.close).toHaveBeenCalledOnce()
    expect(session.status).toBe('retry')
    expect(session.reason).toBe('连接没有回应')
    await vi.advanceTimersByTimeAsync(1000)
    expect(streams).toHaveLength(2)
    // A stream that never says anything at all is dropped the same way.
    await vi.advanceTimersByTimeAsync(40_000)
    expect(streams[1]!.close).toHaveBeenCalledOnce()
    session.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps why the port closed in the status until the console is live again, without repeating it on screen', async () => {
    const session = open()
    streams[0]!.emit('history', ['boot'])
    streams[0]!.emit('closed', 'adapter unplugged', true)
    expect([session.status, session.reason]).toEqual(['closed', '串口断开：adapter unplugged'])
    expect(consoleStatusText(session.status, session.reason, STATUS_TEXT)).toBe('串口断开：adapter unplugged，重连中')
    await vi.advanceTimersByTimeAsync(1000)
    // Reconnecting still says why.
    expect([session.status, session.reason]).toEqual(['retry', '串口断开：adapter unplugged'])
    output.length = 0
    // The port does not come back: the same reason, now for a port that did not open, and not again on the screen.
    streams[1]!.emit('closed', 'adapter unplugged', true)
    expect(output).toEqual([])
    expect(session.reason).toBe('串口打不开：adapter unplugged')
    await vi.advanceTimersByTimeAsync(2000)
    streams[2]!.error()
    expect(session.reason).toBe('串口打不开：adapter unplugged')
    await vi.advanceTimersByTimeAsync(4000)
    streams[3]!.emit('history', ['boot'])
    expect([session.status, session.reason]).toEqual(['live', null])
    expect(consoleStatusText('live', null, STATUS_TEXT)).toBe('实时')
    expect(consoleStatusText('retry', null, STATUS_TEXT)).toBe('重连中')
    session.dispose()
  })

  it('calls a console that never came up 串口打不开, and marks the screen again only when the reason changes', async () => {
    const session = open()
    // boardd holds off a failing console and answers every retry with the backend's own words, the same each time.
    for (let i = 0; i < 4; i++) {
      streams.at(-1)!.emit('closed', 'no such device', true)
      expect([session.status, session.reason]).toEqual(['closed', '串口打不开：no such device'])
      await vi.advanceTimersByTimeAsync(10_000)
    }
    expect(output).toEqual(['\r\n\x1b[2m[串口打不开：no such device，重连中…]\x1b[0m\r\n'])
    expect(output.join('')).not.toContain('串口断开')
    streams.at(-1)!.emit('closed', 'permission denied', true)
    expect(output.at(-1)).toBe('\r\n\x1b[2m[串口打不开：permission denied，重连中…]\x1b[0m\r\n')
    expect(output).toHaveLength(2)
    expect(consoleStatusText(session.status, session.reason, STATUS_TEXT)).toBe('串口打不开：permission denied，重连中')
    // Once live, the next failure is news again, even for a reason said before.
    await vi.advanceTimersByTimeAsync(10_000)
    streams.at(-1)!.emit('history', ['boot'])
    streams.at(-1)!.emit('closed', 'permission denied', true)
    expect(output.at(-1)).toBe('\r\n\x1b[2m[串口断开：permission denied，重连中…]\x1b[0m\r\n')
    session.dispose()
  })

  it('says boardd restarted, when it says it is stopping or the next stream comes from another boardd', async () => {
    const session = open()
    streams[0]!.emit('hello', { boot: 'one' })
    streams[0]!.emit('history', ['boot'])
    output.length = 0
    streams[0]!.emit('restart', { reason: '服务重启' })
    expect([session.status, session.reason]).toEqual(['retry', '服务重启'])
    expect(output.join('')).toContain('[服务重启，重连中…]')
    expect(consoleStatusText(session.status, session.reason, STATUS_TEXT)).toBe('服务重启，重连中')
    await vi.advanceTimersByTimeAsync(1000)
    streams[1]!.emit('hello', { boot: 'one' })
    streams[1]!.emit('history', ['boot'])
    // A worker that crashed says nothing: the stream just errors, and the next one is from another boardd.
    streams[1]!.error()
    expect(session.reason).toBeNull()
    await vi.advanceTimersByTimeAsync(1000)
    output.length = 0
    streams[2]!.emit('hello', { boot: 'two' })
    expect([session.status, session.reason]).toEqual(['retry', '服务重启'])
    streams[2]!.emit('history', ['boot', 'after'])
    expect(output.join('')).toContain('[服务重启，串口重新连接，补上断开期间的 1 行]')
    expect(session.status).toBe('live')
    session.dispose()
  })

  it('reports malformed stream data rather than silently dropping the event', () => {
    const session = open()
    streams[0]!.emit('history', '{not json', true)
    streams[0]!.emit('history', ['valid', 42])
    streams[0]!.emit('output', 42)
    expect(errors).toHaveLength(3)
    expect(session.status).toBe('connecting')
    expect(output).toEqual([])
    session.dispose()
  })
})

describe('console session backlog recovery', () => {
  it('matches the last line through ANSI styling and a log timestamp, writing only the suffix', async () => {
    const session = open()
    streams[0]!.emit('history', ['[2026-11-05 14:39:11] old', '[2026-11-05 14:39:12] \x1b[32mboot ok\x1b[0m'])
    output.length = 0
    streams[0]!.error()
    await vi.advanceTimersByTimeAsync(1000)
    streams[1]!.emit('history', ['[2026-11-05 14:39:10] earlier', '[2026-11-05 14:40:12] boot ok', '[2026-11-05 14:40:13] missed one', '[2026-11-05 14:40:14] missed two'])
    expect(output).toHaveLength(1)
    expect(output[0]).toContain('补上断开期间的 2 行')
    expect(output[0]).toContain('[2026-11-05 14:40:13] missed one\r\n[2026-11-05 14:40:14] missed two\r\n')
    expect(output[0]).not.toContain('earlier\r\n')
    expect(output[0]!.match(/boot ok/g)).toBeNull()
    session.dispose()
  })

  it('conservatively shows only a reconnect marker if the previous tail has no match', async () => {
    const session = open()
    streams[0]!.emit('history', ['line no longer retained'])
    output.length = 0
    streams[0]!.error()
    await vi.advanceTimersByTimeAsync(1000)
    streams[1]!.emit('history', ['different one', 'different two'])
    expect(output).toEqual(['\r\n\x1b[2m[串口重新连接]\x1b[0m\r\n'])
    session.dispose()
  })

  it('uses output after the last history to find the continuation point', async () => {
    const session = open()
    streams[0]!.emit('history', ['boot', 'prompt'])
    streams[0]!.emit('output', '\r\nlast command\r\n')
    output.length = 0
    streams[0]!.error()
    await vi.advanceTimersByTimeAsync(1000)
    streams[1]!.emit('history', ['prompt', 'last command', 'after disconnect'])
    expect(output.join('')).toContain('补上断开期间的 1 行')
    expect(output.join('')).toContain('after disconnect\r\n')
    expect(output.join('')).not.toContain('last command\r\nafter')
    session.dispose()
  })
})

describe('console session input', () => {
  it('batches for 8 ms and sends every batch in order, even when an earlier request is slow', async () => {
    let finishFirst!: () => void
    input.mockImplementationOnce(() => new Promise<void>(resolve => { finishFirst = resolve }))
    const session = open()
    session.input('a')
    await vi.advanceTimersByTimeAsync(7)
    session.input('b')
    await vi.advanceTimersByTimeAsync(7)
    expect(input).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(input).toHaveBeenCalledTimes(1)
    expect(input).toHaveBeenLastCalledWith('a board', 'die/0', 'ab')

    session.input('c')
    await vi.advanceTimersByTimeAsync(8)
    expect(input).toHaveBeenCalledTimes(1)
    finishFirst()
    await tick()
    expect(input).toHaveBeenCalledTimes(2)
    expect(input).toHaveBeenLastCalledWith('a board', 'die/0', 'c')
    session.dispose()
  })

  it('reports input failures, preserves later input order, and flushes on dispose', async () => {
    input.mockRejectedValueOnce(new Error('input rejected'))
    const session = open()
    session.input('first')
    await vi.advanceTimersByTimeAsync(8)
    await tick()
    expect(errors).toEqual([new Error('input rejected')])
    session.input('second')
    session.dispose()
    expect(input).toHaveBeenCalledTimes(1)
    await tick()
    expect(input).toHaveBeenCalledTimes(2)
    expect(input).toHaveBeenLastCalledWith('a board', 'die/0', 'second')
    await tick()
    expect(consoleErrorText('plain failure')).toBe('plain failure')
  })

  it('flushes only pending input and does not reconnect a live session', () => {
    const session = open()
    streams[0]!.emit('history', ['live'])
    session.flush()
    expect(input).not.toHaveBeenCalled()
    session.reconnect()
    expect(streams).toHaveLength(1)
    expect(streams[0]!.close).not.toHaveBeenCalled()
    session.dispose()
  })
})

describe('console session disposal', () => {
  it('closes the source, cancels reconnect and input timers, flushes once, and is idempotent', async () => {
    const session = open()
    const source = streams[0]!
    source.error()
    session.input('last keys')
    session.dispose()
    session.dispose()
    session.input('ignored')
    session.flush()
    session.reconnect()
    await vi.advanceTimersByTimeAsync(30_000)
    await tick()
    expect(source.close).toHaveBeenCalledOnce()
    expect(streams).toHaveLength(1)
    expect(input).toHaveBeenCalledTimes(1)
    expect(input).toHaveBeenCalledWith('a board', 'die/0', 'last keys')
    expect(vi.getTimerCount()).toBe(0)
    source.emit('history', ['after dispose'])
    source.error()
    expect(output).toEqual([])
    expect(statuses).toEqual(['connecting', 'retry'])
    expect(errors).toEqual([])
  })
})
