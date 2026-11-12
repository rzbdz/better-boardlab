/**
 * Browser access to boardd's API, for every frontend and for modules' UI parts. The page acts as the local user, so it
 * never handles lease tokens. Paths are relative, so a page also works behind a reverse proxy under `/boardlab/`.
 */
import type { Action, BoardChannels, BoardDetail, HaSettings, LabPorts, LabSettings, Lease, LockResult, Scan, SendResult, Slot, State } from 'boardlab-core/shared/types.ts'
import { sha256File } from './sha256.ts'

/** The state as the page uses it: the parts modules keep are filled in when their module is not loaded. */
/** Actions and locks, and whatever modules add (`scans`). */
export type History = { actions: Action[], leases: Lease[] } & Record<string, unknown>

export type PageState = Omit<State, 'slots' | 'scan' | 'ha'> & { slots: Slot[], scan: Scan | null, ha: HaSettings | null }
const page = (state: State): PageState => ({ ...state, slots: state.slots ?? [], scan: state.scan ?? null, ha: state.ha ?? null })

/** The frontends this boardd serves, and choosing one for this browser (the page then reloads). */
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

/** How far sending a file has got: hashing it here, then uploading it (`total` bytes either way). */
export type SendProgress = (step: 'hash' | 'upload', done: number, total: number) => void

/**
 * Send a file to boardd under its sha256, unless boardd has it already, for `flashPackage`: returns `sha256:<hex>`. The
 * upload goes by XMLHttpRequest, the one way a page hears how much of a request body has been sent.
 */
export async function sendFile(file: File, onProgress?: SendProgress): Promise<string> {
  const sha256 = await sha256File(file, done => onProgress?.('hash', done, file.size))
  const have = await call<{ present: boolean }>('GET', `api/files/${sha256}`)
  if (!have.present) {
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('PUT', `api/files/${sha256}?name=${encodeURIComponent(file.name)}`)
      const user = identity.get()
      if (user) xhr.setRequestHeader('X-Boards-User', user)
      xhr.setRequestHeader('Content-Type', 'application/octet-stream')
      if (xhr.upload) xhr.upload.onprogress = event => onProgress?.('upload', event.loaded, file.size)
      xhr.onload = () => {
        if (xhr.status < 400) return resolve()
        let message = xhr.responseText
        try { message = JSON.parse(message).error ?? message } catch {}
        reject(new ApiError(xhr.status, `传 ${file.name} 失败：${message}`))
      }
      xhr.onerror = () => reject(new Error(`传 ${file.name} 时连接断了`))
      xhr.send(file)
    })
  }
  onProgress?.('upload', file.size, file.size)
  return `sha256:${sha256}`
}

export const api = {
  state: () => call<State>('GET', 'api/state').then(page),
  board: (name: string) => call<BoardDetail>('GET', `api/board?name=${encodeURIComponent(name)}`),
  history: () => call<History>('GET', 'api/history'),
  lock: (board: string, purpose: string) => call<LockResult>('POST', 'api/lock', { board, purpose }),
  queue: (board: string, purpose: string) => call<LockResult>('POST', 'api/lock', { board, purpose, queue: 'join' }),
  unqueue: (board: string) => call('POST', 'api/unqueue', { board }),
  unlock: (board: string) => call('POST', 'api/unlock', { board }),
  steal: (board: string, reason: string) => call<LockResult>('POST', 'api/steal', { board, reason }),
  reset: (board: string) => call('POST', 'api/reset', { board }),
  channels: (board: string) => call<BoardChannels>('GET', `api/relay?board=${encodeURIComponent(board)}`),
  setChannel: (board: string, channel: string, action: string, ms: number | null) => call<{ message: string }>('POST', 'api/relay', { board, channel, action, ms: ms ?? undefined }),
  confirm: (board: string) => call<{ message: string }>('POST', 'api/confirm', { board }),
  /** Answer an agent waiting for a board a person holds: let it have the board, or keep it. */
  answerYield: (board: string, action: 'yield' | 'deny') => call<{ message: string }>('POST', 'api/yields', { board, action }),
  cancelBoard: (board: string) => call<{ message: string }>('POST', 'api/board/cancel', { board }),
  bootSdk: (board: string, sdk: string, method: 'load' | 'download', brk?: string) => call<{ output: string }>('POST', 'api/boot/sdk', { board, sdk, method, ...(brk ? { brk } : {}) }),
  /** Where an SDK's recipe can stop early (empty when it has none). */
  bootBreaks: (board: string, sdk: string) => call<{ load: string[], download: string[] }>('GET', `api/boot/breaks?board=${encodeURIComponent(board)}&sdk=${encodeURIComponent(sdk)}`),
  sendFile,
  /** Flash a package: a `url` the board's backend downloads itself, or a file sent first (`sendFile`'s `sha256`). */
  flashPackage: (board: string, input: { url?: string, sha256?: string, flasher?: string }) => call<{ output: string }>('POST', 'api/flash/package', { board, ...input }),
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
  discoverLab: (id: string, options: { human?: boolean, host?: string, slots?: string[] } = {}) => call<{ message: string }>('POST', 'api/labs/discover', { id, confirmed: true, ...options }),
  labPorts: (id: string, fresh = false) => call<LabPorts>('GET', `api/labs/slots?id=${encodeURIComponent(id)}${fresh ? '&fresh=1' : ''}`),
  bindLab: (id: string, input: { host: string, console: string, usb: string, name?: string }) => call<{ board: string }>('POST', 'api/labs/bind', { id, ...input }),
  removeBoard: (name: string) => call('POST', 'api/boards/remove', { name }),
}
