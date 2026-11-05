/** Browser access to boardd's loopback API. The page acts as the local user, so it never handles lease tokens. */
import type { BoardDetail, HaDiscovery, HaSettings, LabSettings, LockResult, Scan, SendResult, Slot, State, Action, Lease } from '../shared/types.ts'

export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message) } }

const USER_KEY = 'boards.user'
/** The name this browser acts under; empty means boardd's local user. */
export const identity = {
  get: () => localStorage.getItem(USER_KEY) ?? '',
  set: (name: string) => name ? localStorage.setItem(USER_KEY, name) : localStorage.removeItem(USER_KEY),
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
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
  return (response.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : text as T
}

export const api = {
  state: () => call<State>('GET', '/api/state'),
  board: (name: string) => call<BoardDetail>('GET', `/api/board?name=${encodeURIComponent(name)}`),
  history: () => call<{ actions: Action[], leases: Lease[], scans: Scan[] }>('GET', '/api/history'),
  evidence: (id: string) => call<Array<{ slot: number | null, kind: string, label: string, body: string, at: string }>>('GET', `/api/scan/evidence?id=${encodeURIComponent(id)}`),
  lock: (board: string, purpose: string) => call<LockResult>('POST', '/api/lock', { board, purpose }),
  queue: (board: string, purpose: string) => call<LockResult>('POST', '/api/lock', { board, purpose, queue: 'join' }),
  unqueue: (board: string) => call('POST', '/api/unqueue', { board }),
  unlock: (board: string) => call('POST', '/api/unlock', { board }),
  steal: (board: string, reason: string) => call<LockResult>('POST', '/api/steal', { board, reason }),
  reset: (board: string) => call('POST', '/api/reset', { board }),
  fastboot: (board: string) => call('POST', '/api/fastboot', { board }),
  // Fire and forget: the console stream already shows the output, so the request does not wait for any.
  send: (board: string, die: string | undefined, text: string) => call<SendResult>('POST', '/api/send', { board, die, text, newline: true, timeoutMs: 0 }),
  scan: (slots: number[]) => call<Scan>('POST', '/api/scan', { slots, confirmed: true }),
  cancelScan: (id: string) => call('POST', '/api/scan/cancel', { id }),
  proposals: (ids: string[], decision: 'apply' | 'reject', names?: Record<string, string>) => call('POST', '/api/proposals', { ids, decision, names }),
  saveScriptSlot: (input: { slot: number, label: string, resetScript: string, fastbootScript: string }) => call<Slot>('POST', '/api/slots/script', input),
  removeScriptSlot: (slot: number) => call('POST', '/api/slots/script/remove', { slot }),
  configureHa: (url: string, token?: string) => call<HaSettings>('POST', '/api/ha', { url, token: token || undefined }),
  testHa: () => call<HaSettings>('POST', '/api/ha/test'),
  // The password goes only when typed; leaving it empty keeps the stored one.
  configureLab: (input: { id: string, enabled: boolean, url: string, username: string, password?: string, jump: string, devices: string }) => call<LabSettings>('POST', '/api/labs', { ...input, password: input.password || undefined }),
  testLab: (id: string) => call<LabSettings>('POST', '/api/labs/test', { id }),
}
