/**
 * Browser access to boardd's API, for every frontend and for modules' UI parts. The page acts as the local user, so it
 * never handles lease tokens. Paths are relative, so a page also works behind a reverse proxy under `/boardlab/`.
 */
import type { Action, BoardChannels, BoardDetail, DiscoveryContext, DiscoveryMethod, LabPorts, LabSettings, Lease, LockResult, SendResult, State } from 'boardlab-core/shared/types.ts'
import type { Scan, Slot } from '../shared/local.ts'
import type { HaSettings } from '../shared/home-assistant.ts'

/** The normalized page state, including the module-owned fields boardd adds when their modules are loaded. */
export type PageState = State & { slots: Slot[], scan: Scan | null, ha: HaSettings | null }
type RawPageState = State & Partial<Pick<PageState, 'slots' | 'scan' | 'ha'>>
const page = (state: RawPageState): PageState => ({ ...state, slots: state.slots ?? [], scan: state.scan ?? null, ha: state.ha ?? null } as PageState)
/** Actions and locks, and whatever modules add (`scans`). */
export type History = { actions: Action[], leases: Lease[] } & Record<string, unknown>

/** The frontends this boardd offers, and selecting the one it serves to every browser (the page then reloads). */
export interface FrontendList { default: string | null, current: string | null, frontends: Array<{ name: string, title: string }> }
export const frontends = {
  list: () => call<FrontendList>('GET', 'api/frontends'),
  choose: async (name: string) => { await call('POST', `api/frontends?name=${encodeURIComponent(name)}`); location.reload() },
}

export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message) } }

const USER_KEY = 'boards.user'
/** The name this browser acts under; empty means boardd's local user. */
export const identity = {
  get: () => localStorage.getItem(USER_KEY) ?? '',
  set: (name: string) => name ? localStorage.setItem(USER_KEY, name) : localStorage.removeItem(USER_KEY),
}

// A view that fetched data of its own (a module's settings, say) must draw it when it arrives: after every call the
// page is told, and draws again from what the module kept.
const fetched = new Set<() => void>()
export function onFetched(listener: () => void): () => void { fetched.add(listener); return () => { fetched.delete(listener) } }
const tellFetched = () => queueMicrotask(() => { for (const listener of fetched) listener() })

export async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const user = identity.get()
  const response = await fetch(path, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(user ? { 'X-Boards-User': user } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) {
    let message = text
    try { message = JSON.parse(text).error ?? text } catch {}
    throw new ApiError(response.status, message)
  }
  const value = (response.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) as T : text as T
  tellFetched()
  return value
}

/**
 * POST to an endpoint that answers with events (a long job): its `out` lines go to `sink` as they come, its `exit`
 * ({ok, message}) is the result, failing with the message when not ok.
 */
export async function stream(path: string, body: unknown, sink: { line(text: string): void }, signal?: AbortSignal): Promise<{ ok: boolean, message: string }> {
  const user = identity.get()
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(user ? { 'X-Boards-User': user } : {}) }, body: JSON.stringify(body), signal })
  if (!response.ok || !response.body) { let message = await response.text(); try { message = JSON.parse(message).error ?? message } catch {} throw new ApiError(response.status, message) }
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', result: { ok: boolean, message: string } | null = null
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let at: number
    while ((at = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, at); buffer = buffer.slice(at + 2)
      const event = /^event: (.*)$/m.exec(block)?.[1]
      const data = block.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
      if (!data) continue
      const parsed = JSON.parse(data)
      if (event === 'out') sink.line(String(parsed.text ?? ''))
      else if (event === 'exit') result = parsed
    }
  }
  if (!result) throw new Error('连接断了，没收到结果')
  if (!result.ok) throw new Error(result.message)
  return result
}

// The models people have typed in change only when one is saved; one read serves the page until it is refreshed.
let modelsCache: string[] | null = null, modelsRead: Promise<string[]> | null = null, modelsEpoch = 0
function readModels(): Promise<string[]> {
  if (modelsCache) return Promise.resolve(modelsCache)
  if (modelsRead) return modelsRead
  const epoch = modelsEpoch
  modelsRead = call<{ models?: string[] }>('GET', 'api/models').then(out => {
    const list = out?.models ?? []
    if (epoch === modelsEpoch) { modelsCache = list; modelsRead = null }
    return list
  }).catch(error => { if (epoch === modelsEpoch) modelsRead = null; throw error })
  return modelsRead
}

export const api = {
  state: () => call<RawPageState>('GET', 'api/state').then(page),
  board: (name: string) => call<BoardDetail>('GET', `api/board?name=${encodeURIComponent(name)}`),
  /** Models people typed in themselves, most recent first: read once per page, `refresh` to read again. */
  models: (refresh = false) => { if (refresh) { modelsEpoch++; modelsCache = null; modelsRead = null } return readModels() },
  /** Rename a board everywhere (backend names, lock, queue, history); returns the name it has afterwards. */
  renameBoard: (name: string, to: string) => call<{ board: string, message: string }>('POST', 'api/board/rename', { board: name, name: to }),
  /** Set a board's model, or clear it with null; a set one is remembered for the model list. */
  setModel: async (name: string, product: string | null) => {
    const out = await call<{ ok: true }>('POST', 'api/board', { name, product })
    modelsEpoch++; modelsCache = null; modelsRead = null
    return out
  },
  history: () => call<History>('GET', 'api/history'),
  lock: (board: string, purpose: string) => call<LockResult>('POST', 'api/lock', { board, purpose }),
  queue: (board: string, purpose: string) => call<LockResult>('POST', 'api/lock', { board, purpose, queue: 'join' }),
  unqueue: (board: string) => call('POST', 'api/unqueue', { board }),
  unlock: (board: string) => call('POST', 'api/unlock', { board }),
  steal: (board: string, reason: string) => call<LockResult>('POST', 'api/steal', { board, reason }),
  reset: (board: string) => call('POST', 'api/reset', { board }),
  channels: (board: string) => call<BoardChannels>('GET', `api/relay?board=${encodeURIComponent(board)}`),
  setChannel: (board: string, channel: string, action: string, ms: number | null) => call<{ message: string }>('POST', 'api/relay', { board, channel, action, ms: ms ?? undefined }),
  confirm: (board: string, request?: string | null) => call<{ message: string }>('POST', 'api/confirm', { board, request: request ?? undefined }),
  /** Answer an agent waiting for a board a person holds: let it have the board, or keep it. */
  answerYield: (board: string, action: 'yield' | 'deny') => call<{ message: string }>('POST', 'api/yields', { board, action }),
  cancelBoard: (board: string) => call<{ message: string }>('POST', 'api/board/cancel', { board }),
  bootSdk: (board: string, sdk: string, method: 'load' | 'download', brk?: string) => call<{ output: string }>('POST', 'api/boot/sdk', { board, sdk, method, ...(brk ? { brk } : {}) }),
  /** Where an SDK's recipe can stop early (empty when it has none). */
  bootBreaks: (board: string, sdk: string) => call<{ load: string[], download: string[] }>('GET', `api/boot/breaks?board=${encodeURIComponent(board)}&sdk=${encodeURIComponent(sdk)}`),
  /** Flash a package: a `url` the board's backend downloads itself. */
  flashPackage: (board: string, input: { url: string, flasher?: string }) => call<{ output: string }>('POST', 'api/flash/package', { board, ...input }),
  fastboot: (board: string) => call('POST', 'api/fastboot', { board }),
  /** Keystrokes for the online console, sent as they are. */
  // People on the page type without the lock (agents use the CLI and need it).
  input: (board: string, die: string | undefined, data: string) => call('POST', 'api/console/input', { board, die, data, human: true }),
  // Fire and forget: the console stream already shows the output, so the request does not wait for any.
  send: (board: string, die: string | undefined, text: string) => call<SendResult>('POST', 'api/send', { board, die, text, newline: true, timeoutMs: 0 }),
  proposals: (ids: string[], decision: 'apply' | 'reject', names?: Record<string, string>) => call('POST', 'api/proposals', { ids, decision, names }),
  // The password goes only when typed; leaving it empty keeps the stored one.
  configureLab: (input: { id: string, enabled: boolean, url: string, username: string, password?: string, jump: string, devices: string }) => call<LabSettings>('POST', 'api/labs', { ...input, password: input.password || undefined }),
  testLab: (id: string) => call<LabSettings>('POST', 'api/labs/test', { id }),
  refresh: (board: string, options: { name?: string, rename?: boolean }) => call<{ board: string, message: string }>('POST', 'api/boards/refresh', { board, ...options }),
  rebuildLab: (id: string, host: string, keepInUse = false) => call<{ message: string }>('POST', 'api/labs/rebuild', { id, host, confirmed: true, keepInUse }),
  discoverMethods: (id: string, context: DiscoveryContext = {}) => {
    const query = new URLSearchParams({ id })
    if (context.host) query.set('host', context.host)
    if (context.slot) query.set('slot', context.slot)
    return call<DiscoveryMethod[]>('GET', `api/labs/discover/methods?${query}`)
  },
  discoverLab: (id: string, request: { method: string, values?: Record<string, string>, host?: string, slot?: string }) =>
    call<{ message: string, proposals: number, registered?: string[] }>('POST', 'api/labs/discover', { id, confirmed: true, ...request }),
  cancelDiscovery: (id: string) => call<{ message: string }>('POST', 'api/labs/discover/cancel', { id }),
  /** Register a board a scan cannot see, from a backend's `compose` method (a person says what each role is). */
  composeBoard: (id: string, request: { method: string, values?: Record<string, string>, host?: string, slot?: string }) =>
    call<{ name: string, message: string }>('POST', 'api/labs/compose', { id, ...request }),
  labPorts: (id: string, fresh = false) => call<LabPorts>('GET', `api/labs/slots?id=${encodeURIComponent(id)}${fresh ? '&fresh=1' : ''}`),
  removeBoard: (name: string) => call('POST', 'api/boards/remove', { name }),
}
