/**
 * boardd's event stream, kept open by this page rather than left to the browser's own retry.
 *
 * A browser retries an `EventSource` only while it has had no answer it cannot use: a proxy that answers 502 while
 * boardd restarts, or a 401 from a session that just expired, closes the source for good, and the page then stays stale
 * until someone reloads it. This opens a new source after any drop — and says when it is lost and when it is back — so
 * a page behind a reverse proxy under `/boardlab/`, or one left open while boardd is replaced, comes back by itself.
 *
 * It throws nothing away and knows no backend's words, but an `EventSource` delivers a named event only to a listener
 * registered for that exact name: a name nobody listens for is dropped by the browser before this code sees it. So the
 * names to listen for come from the caller — core's own events for the page, and a module's for what it adds — and each
 * is added at the start of every source.
 *
 * The path is relative to the page, as every call in api.ts is, so it works under whatever prefix the page is served at.
 */
export type EventHandler = (name: string, data: unknown) => void

export interface Events {
  /**
   * Follow the stream; returns the way to stop following. Every listener hears every named event it asked for (and
   * `message`); `lost`/`back` say when the stream itself comes and goes. The source is open while anyone listens, and
   * a name a later listener adds is listened for from then on.
   */
  listen(handlers: { event: EventHandler, names?: readonly string[], lost?: () => void, back?: () => void }): () => void
}

const MAX_RETRY_MS = 15_000
const CONNECT_MS = 15_000       // a connection a proxy accepts but never answers is as dead as one that failed
const QUIET_MS = 45_000         // boardd pings every 15 s; this long without a frame means the proxy is gone

type Handlers = Parameters<Events['listen']>[0]
let shared: Events | null = null

/**
 * The names core itself emits (`CoreEvent` in boardlab-core's shared types), which every page listens for. A module's
 * own names are the module's to pass (`names`), not this layer's to know.
 */
export const CORE_EVENTS = ['changed', 'lease-stolen', 'lease-granted', 'lab-ports', 'attention'] as const

/** The page's one event stream. The path is the page's, so only the first call's path is the stream's. */
export function events(path = 'api/events'): Events {
  return shared ??= open(path)
}

function open(path: string): Events {
  const listeners = new Set<Handlers>()
  const named = new Set<string>()       // every name some listener asked for, for the sources opened from now on
  let source: EventSource | null = null
  let live = false, attempts = 0
  let retry: number | undefined, quiet: number | undefined, waiting: number | undefined

  const alive = () => {
    window.clearTimeout(quiet); window.clearTimeout(waiting)
    quiet = window.setTimeout(drop, QUIET_MS)
  }
  /** Report to the listeners, each on its own: one that throws must not stop the stream from coming back. */
  const tell = (name: 'lost' | 'back') => {
    for (const listener of listeners) { try { listener[name]?.() } catch (error) { console.error(error) } }
  }
  /** Close what is open, keeping the record of whether the page had a live stream (drop() reports it). */
  const closeSource = () => {
    window.clearTimeout(retry); window.clearTimeout(quiet); window.clearTimeout(waiting)
    source?.close(); source = null
  }
  function drop() {
    closeSource()
    if (!listeners.size) { live = false; return }
    if (live) { live = false; tell('lost') }
    // Armed after the listeners have been told, so nothing they do can lose the retry.
    retry = window.setTimeout(connect, Math.min(500 * 2 ** attempts++, MAX_RETRY_MS))
  }
  const accept = (name: string) => (event: Event) => {
    if (!source) return
    alive()
    // The keepalive is a sign of life, not news: it must not make listeners re-read anything. It is listened for here
    // because no caller asks for it.
    if (name === 'ping') return
    const data = event as MessageEvent
    let value: unknown = data.data
    try { value = JSON.parse(String(data.data)) } catch { /* a plain string is a value too */ }
    for (const listener of listeners) { try { listener.event(name, value) } catch (error) { console.error(error) } }
  }
  function connect() {
    if (!listeners.size) return
    window.clearTimeout(retry)
    source?.close()
    let stream: EventSource
    try { stream = new EventSource(path) } catch (error) { console.error(error); schedule(); return }
    source = stream
    // The connection itself is a deadline: a proxy may accept the request and never answer, and then no `error` comes.
    window.clearTimeout(waiting); waiting = window.setTimeout(() => { if (stream === source && !live) drop() }, CONNECT_MS)
    stream.onopen = () => {
      if (stream !== source) return
      attempts = 0
      alive()
      if (!live) { live = true; tell('back') }
    }
    stream.onerror = () => { if (stream === source) drop() }
    stream.onmessage = accept('message')
    for (const name of named) stream.addEventListener(name, accept(name))
    stream.addEventListener('ping', accept('ping'))
  }
  const schedule = () => { retry = window.setTimeout(connect, Math.min(500 * 2 ** attempts++, MAX_RETRY_MS)) }
  /** Listen for a name on the source open now, so a listener that joined while it was open is not left out. */
  const hear = (name: string) => {
    if (named.has(name)) return
    named.add(name)
    source?.addEventListener(name, accept(name))
  }

  // A page in a background tab has nothing to keep alive; coming back to it (or the network coming back) is when a
  // dead stream is noticed at once rather than at the next retry. A source that is still "open" may be a half-open
  // connection the proxy never closed, so waking replaces it rather than trusting it.
  const wake = () => {
    if (!listeners.size) return
    if (source) closeSource()      // whatever it is, it survived a sleep or a network change: start over
    attempts = 0
    connect()
  }
  const onVisible = () => { if (document.visibilityState === 'visible') wake() }
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('online', wake)

  return {
    listen(handlers) {
      for (const name of handlers.names ?? []) hear(name)
      listeners.add(handlers)
      if (!source) connect()
      return () => {
        listeners.delete(handlers)
        if (listeners.size) return
        document.removeEventListener('visibilitychange', onVisible)
        window.removeEventListener('online', wake)
        closeSource()
        live = false
        shared = null            // a page that comes back to this stream starts a fresh one, with its own retries
      }
    },
  }
}
