/**
 * Setup for frontend tests in jsdom: what a browser has and jsdom lacks (matchMedia, ResizeObserver), and boardd
 * replaced by the mock state (tests/mock-boardd.ts) behind fetch and EventSource. Every request is recorded in
 * `calls`, so tests check what the page asked boardd to do.
 */
import { vi } from 'vitest'
import { mockState } from './mock-boardd.ts'

export const calls: Array<{ method: string, path: string, body: unknown }> = []
export let state = mockState()
export function resetMock() { state = mockState(); calls.length = 0; document.cookie = 'boardlab-frontend=; max-age=0' }

const history = {
  actions: [{ id: 1, at: state.now, actor: 'user:bob', board: 'bsp-k3-cm1', kind: 'reset', detail: null, ok: false, message: 'no sign of download mode' }],
  leases: [{ id: 'l1', board: 'bsp-k3-deb1', holder: 'user:alice', purpose: '临时调试', startedAt: state.now, status: 'held', endedAt: null, endReason: null }],
  scans: [],
}

function reply(body: unknown) { return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }) }

globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input), 'http://localhost/')
  const method = init?.method ?? 'GET'
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  calls.push({ method, path: url.pathname.replace(/^\//, '') + url.search, body })
  const path = url.pathname
  if (path === '/api/state') return reply(state)
  if (path === '/api/history') return reply(history)
  if (path === '/api/board') return reply({ board: state.boards.find(b => b.name === url.searchParams.get('name')), actions: [], leases: [] })
  if (path === '/api/frontends') return reply({ default: 'antd', current: 'antd', frontends: [{ name: 'antd', title: 'Ant Design' }, { name: 'troy-mitchell-default', title: 'TroyMitchellDefault' }] })
  if (path === '/api/logs') return reply({ lines: ['[2026-11-10 08:59:58] U-Boot SPL 2022.10', '[2026-11-10 09:00:00] ERROR: mmc0 timeout'], matched: 2, truncated: false, source: 'backend' })
  if (path === '/api/lock' && method === 'POST') {
    const board = state.boards.find(b => b.name === body.board)!
    board.lease = { id: 'new', board: board.name, holder: state.you, purpose: body.purpose, startedAt: state.now, status: 'held', endedAt: null, endReason: null }
    return reply({ lease: board.lease, token: 't', gateToken: null, queued: null })
  }
  return reply({ ok: true })
}) as typeof fetch

class FakeEventSource {
  static readonly CLOSED = 2
  readyState = 1
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() { this.readyState = 2 }
}
globalThis.EventSource = FakeEventSource as unknown as typeof EventSource

window.matchMedia = window.matchMedia ?? ((query: string) => ({
  matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
}) as MediaQueryList)
window.scrollTo = (() => {}) as typeof window.scrollTo
globalThis.ResizeObserver = globalThis.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} }
// Switching frontends reloads the page; in tests there is nothing to reload.
Object.defineProperty(window, 'location', { value: { ...window.location, reload: () => {}, href: 'http://localhost/', hash: '' }, writable: true })
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
