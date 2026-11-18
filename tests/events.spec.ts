// @vitest-environment jsdom
/**
 * The page's event stream: it keeps itself open through a proxy or a boardd restart, and every listener on the page
 * shares the one source. A browser would give up for good on the answers a proxy sends while boardd is down.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeEventSource {
  static readonly instances: FakeEventSource[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readyState = FakeEventSource.OPEN
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  close = vi.fn(() => { this.readyState = FakeEventSource.CLOSED })
  private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>()
  constructor(readonly url: string) { FakeEventSource.instances.push(this) }
  addEventListener(name: string, listener: (event: MessageEvent) => void) {
    const list = this.listeners.get(name) ?? []
    list.push(listener)
    this.listeners.set(name, list)
  }
  /** As a browser delivers it: a named event only to listeners for that name, nothing to a name nobody listens for. */
  emit(name: string, data: unknown) {
    for (const listener of this.listeners.get(name) ?? []) listener({ data: JSON.stringify(data) } as MessageEvent)
  }
  hasListener(name: string) { return (this.listeners.get(name)?.length ?? 0) > 0 }
  names() { return [...this.listeners.keys()] }

  opened() { this.onopen?.(new Event('open')) }
  failed() { this.onerror?.(new Event('error')) }
}

const streams = () => FakeEventSource.instances
const tick = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms) }

let events: typeof import('../src/ui/events.ts')['events']
/** Every listener a test opens: stopped after it, so a module instance left listening cannot wake in the next test. */
const opened: Array<() => void> = []
const follow = (handlers: Parameters<ReturnType<typeof import('../src/ui/events.ts')['events']>['listen']>[0]) => {
  const stop = events().listen(handlers)
  opened.push(stop)
  return stop
}

beforeEach(async () => {
  vi.useFakeTimers()
  FakeEventSource.instances.length = 0
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.resetModules()                                  // the shared stream is per module load
  ;({ events } = await import('../src/ui/events.ts'))
})
afterEach(() => {
  while (opened.length) opened.pop()!()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("the page's event stream", () => {
  it('opens a source once for the whole page, and closes it when the last listener leaves', async () => {
    const one = vi.fn(), two = vi.fn()
    const stopOne = follow({ names: ['changed'], event: one })
    const stopTwo = follow({ event: two })
    expect(streams()).toHaveLength(1)
    expect(streams()[0]!.url).toBe('api/events')
    streams()[0]!.emit('changed', { what: 'boards' })
    expect(one).toHaveBeenCalledWith('changed', { what: 'boards' })
    expect(two).toHaveBeenCalledTimes(1)
    stopOne()
    expect(streams()[0]!.close).not.toHaveBeenCalled()           // someone still listens
    stopTwo()
    expect(streams()[0]!.close).toHaveBeenCalled()
    // A page that comes back to the stream gets a fresh one, with its own retries.
    follow({ event: one })
    expect(streams()).toHaveLength(2)
  })

  it('replaces a source that failed — the case a browser gives up on — and says when it is lost and back', async () => {
    const seen: string[] = []
    follow({ names: ['changed'], event: () => {}, lost: () => seen.push('lost'), back: () => seen.push('back') })
    streams()[0]!.opened()
    expect(seen).toEqual(['back'])
    // A proxy answering 502 while boardd restarts: the browser closes the source for good; this opens another.
    streams()[0]!.failed()
    expect(seen).toEqual(['back', 'lost'])
    expect(streams()[0]!.close).toHaveBeenCalled()
    await tick(500)
    expect(streams()).toHaveLength(2)
    streams()[1]!.opened()
    expect(seen).toEqual(['back', 'lost', 'back'])
  })

  it('retries with a growing pause, and reconnects at once when the page comes back into view', async () => {
    follow({ names: ['ping'], event: () => {} })
    streams()[0]!.opened()
    streams()[0]!.failed()
    await tick(499)
    expect(streams()).toHaveLength(1)                            // not before the first pause
    await tick(1)
    expect(streams()).toHaveLength(2)
    streams()[1]!.failed()                                       // no answer at all: the pause doubles
    await tick(999)
    expect(streams()).toHaveLength(2)
    await tick(1)
    expect(streams()).toHaveLength(3)
    // Out of sight the page does nothing; coming back is a reconnect now, not after the next pause — and a source the
    // browser still thinks is open may be a half-open connection (a sleep, a network change), so it is replaced.
    streams()[2]!.opened()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(streams()).toHaveLength(4)
    expect(streams()[2]!.close).toHaveBeenCalled()
  })

  it('notices a stream that went quiet without an error (a proxy holding a dead connection)', async () => {
    const lost = vi.fn()
    follow({ event: () => {}, lost })
    streams()[0]!.opened()
    await tick(44_000)
    expect(streams()).toHaveLength(1)
    await tick(2_000)                                            // boardd pings every 15 s
    expect(lost).toHaveBeenCalled()
    await tick(500)
    expect(streams()).toHaveLength(2)
    // A frame resets the quiet timer; boardd sends a `ping` event every 15 s, which a page can see (a `: comment` it could not).
    streams()[1]!.opened()
    await tick(30_000)
    streams()[1]!.emit('ping', Date.now())
    await tick(40_000)
    expect(streams()).toHaveLength(2)
    // The keepalive is a sign of life, not news a listener re-reads for.
    const heard: string[] = []
    follow({ event: name => heard.push(name) })
    streams()[1]!.emit('ping', Date.now())
    expect(heard).not.toContain('ping')
  })

  it('gives up on a connection a proxy accepted but never answered, and tries again', async () => {
    const lost = vi.fn()
    follow({ event: () => {}, lost })
    // No `open`, no `error`: the request is held. A stream is only useful once it answers.
    await tick(14_000)
    expect(streams()).toHaveLength(1)
    await tick(2_000)
    expect(lost).not.toHaveBeenCalled()                          // it never was live: nothing was lost
    expect(streams()[0]!.close).toHaveBeenCalled()
    await tick(500)
    expect(streams()).toHaveLength(2)
    streams()[1]!.opened()
    await tick(20_000)
    streams()[1]!.emit('ping', Date.now())
    expect(streams()).toHaveLength(2)
  })

  it('keeps the stream coming back when a listener throws', async () => {
    const seen: string[] = []
    follow({ names: ['changed'], event: () => { throw new Error('listener bug') }, lost: () => { seen.push('lost'); throw new Error('lost bug') }, back: () => seen.push('back') })
    streams()[0]!.opened()
    streams()[0]!.emit('changed', {})
    streams()[0]!.failed()
    expect(seen).toEqual(['back', 'lost'])
    await tick(500)
    expect(streams()).toHaveLength(2)                            // a bug in one listener does not end the retries
  })

  it('listens for a name a caller brings, on the source open now and on the ones after it', async () => {
    const heard: string[] = []
    // A module's own event, named by that module's part of the page: the shared stream knows no module's words.
    follow({ names: ['scan'], event: name => heard.push(name) })
    const stream = streams()[0]!
    expect(stream.hasListener('scan')).toBe(true)                 // added to the source that is already open
    stream.emit('scan', { id: 'x' })
    expect(heard).toEqual(['scan'])
    stream.failed()
    await tick(500)
    expect(streams()[1]!.names()).toContain('scan')               // and to the replacement
    expect(streams()[1]!.names()).toContain('ping')               // the keepalive is listened for without being asked
  })

  it('hands every named event to each listener, with its data decoded', async () => {
    const heard: Array<[string, unknown]> = []
    follow({ names: ['lease-granted', 'lab-ports'], event: (name, data) => heard.push([name, data]) })
    const stream = streams()[0]!
    stream.emit('lease-granted', { board: 'b', holder: 'user:x' })
    stream.emit('lab-ports', { lab: 'l', added: ['/dev/ttyUSB3'] })
    expect(heard).toEqual([['lease-granted', { board: 'b', holder: 'user:x' }], ['lab-ports', { lab: 'l', added: ['/dev/ttyUSB3'] }]])
  })
})
