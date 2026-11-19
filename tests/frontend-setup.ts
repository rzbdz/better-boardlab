/**
 * Setup for frontend tests in jsdom: what a browser has and jsdom lacks (matchMedia, ResizeObserver), and boardd
 * replaced by the mock state (tests/mock-boardd.ts) behind fetch and EventSource. Every request is recorded in
 * `calls`, so tests check what the page asked boardd to do.
 */
import { vi } from 'vitest'
import { mockState } from './mock-boardd.ts'

/** A board whose debug session the fake host has started (and not stopped). */
const debugRunning = new Map<string, boolean>()

export const calls: Array<{ method: string, path: string, body: unknown }> = []
export let state = mockState()
export function resetMock() { state = mockState(); calls.length = 0; debugRunning.clear(); document.cookie = 'boardlab-frontend=; max-age=0' }

const history = {
  actions: [{ id: 1, at: state.now, actor: 'user:bob', board: 'bsp-k3-cm1', kind: 'reset', detail: null, ok: false, message: 'no sign of download mode' }],
  leases: [{ id: 'l1', board: 'bsp-k3-deb1', holder: 'user:alice', purpose: '临时调试', startedAt: state.now, status: 'held', endedAt: null, endReason: null }],
  scans: [],
}

// The bsp site: one build server with one SDK, one SDK on a source tree, a SoC whose probe image is not there.
const doc = (kind: string, id: string, fields: Record<string, string>, layer = 'site') => ({ kind, id, file: `sdk/${kind}/${id}.yaml`, layer, text: `id: ${id}\n`, fields })
const site = {
  source: 'managed', url: '', branch: 'main', ready: true, revision: 'abc1234', commit: { subject: 'Add SDK vendor-a', at: '2026-11-10T09:00:00Z' }, ahead: 0,
  docs: [
    doc('servers', 'build-a', { host: '192.0.2.10', user: 'dev' }),
    doc('instances', 'vendor-a', { family: 'make-bsp', server: 'build-a', path: '/home/dev/a', soc: 'k1', load: 'ready', download: 'todo' }),
    doc('instances', 'upstream', { family: 'make-bsp', workspace: 'tree', load: 'ready', download: 'todo' }),
    doc('workspaces', 'tree', { server: 'build-a', path: '/home/dev/tree' }),
    doc('families', 'make-bsp', { runner: 'make' }, 'spacemit'),
  ],
  socs: [{ soc: 'k1', layer: 'spacemit' }], problems: [], hosts: {}, syncing: false,
  images: { at: '2026-11-10T09:00:00Z', ok: true, message: '镜像 0 个在', fetched: [], present: [], failed: [], missing: [], optional: ['k1/fsbl（FSBL.bin）'] },
}

function reply(body: unknown) { return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }) }

// A lab's free ports and the methods its backend reports: the page renders both as they come.
const labHosts = [
  { host: 'host-a', consoles: [{ id: 'ttyUSB7', label: 'serial-mux a7' }], usb: [{ id: '1-1.2', label: '1-1.2 boot' }] },
  { host: 'host-b', consoles: [{ id: 'ttyUSB8', label: 'serial-mux b8' }, { id: 'ttyUSB9', label: 'serial-mux b9' }], usb: [{ id: '1-1.3', label: '1-1.3 boot' }, { id: '1-1.4', label: '1-1.4 boot' }] },
]
const sole = (items: Array<{ id: string }>) => items.length === 1 ? items[0]!.id : null

globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input), 'http://localhost/')
  const method = init?.method ?? 'GET'
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
  calls.push({ method, path: url.pathname.replace(/^\//, '') + url.search, body })
  const path = url.pathname
  if (path === '/api/state') return reply(state)
  // Only an SDK that has a recipe can stop early: another backend answers with nothing to stop at.
  if (path === '/api/boot/breaks') return reply(url.searchParams.get('sdk') === 'k1x-2.0' ? { load: ['uboot'], download: [] } : { load: [], download: [] })
  if (path === '/api/history') return reply(history)
  if (path === '/api/board') return reply({ board: state.boards.find(b => b.name === url.searchParams.get('name')), actions: [], leases: [] })
  if (path === '/api/frontends') return reply({ default: 'modern', current: 'modern', frontends: [{ name: 'modern', title: 'Modern' }, { name: 'troy-mitchell-default', title: 'TroyMitchellDefault' }] })
  if (path === '/api/bsp/site') return reply(site)
  // A board's debug path, as its backend reports it; starting the session makes it live until it is stopped, so a
  // page that re-reads the path after either sees what the host would say.
  if (path === '/api/debug' && method === 'POST') {
    const action = body?.action ?? 'path'
    const live = debugRunning.get(body?.board as string) ?? false
    const swd = { provider: 'my-swd', title: 'SWD over GPIO', about: '两颗 GPIO 位操作出来的链路。', kinds: ['halt', 'run', 'step', 'regs', 'trace'] }
    if (action === 'path') return reply({ debug: body.board === 'bsp-k1-musecard'
      ? { ...swd, running: live, endpoint: live ? '127.0.0.1:3334' : null } : null })
    if (action === 'start') { debugRunning.set(body.board as string, true); return reply({ debug: { ...swd, running: true, endpoint: '127.0.0.1:3334' } }) }
    if (action === 'stop') { debugRunning.set(body.board as string, false); return reply({ debug: { message: '调试会话已停止' } }) }
    return reply({ debug: { message: `${action} 已完成`, data: [{ label: 'pc', value: '0x08000421' }] } })
  }
  if (path.startsWith('/api/docs/')) return reply({ name: path.slice('/api/docs/'.length), title: '帮助', text: `# 帮助：${path.slice('/api/docs/'.length)}\n\n说明文字，[看这里](https://example.com/a) 和 [别点](javascript:alert(1))。\n\n\`\`\`yaml\nid: x\n\`\`\`` })
  if (path.startsWith('/api/files/')) return reply({ sha256: path.slice('/api/files/'.length), present: false })
  if (path === '/api/labs/slots') return reply({ hosts: labHosts, at: state.now, refreshing: false, error: null })
  if (path === '/api/labs/discover/methods') {
    const host = url.searchParams.get('host') ?? '', slot = url.searchParams.get('slot') ?? ''
    const entry = labHosts.find(item => item.host === host)
    const probe = { id: 'probe', title: '自动刷机',
      about: slot ? '复位这个槽位的复位线，看串口反应与出现的下载口。只动这一个槽位。' : '实验室逐个拉还没用过的复位线，看串口和下载口。接在这些线上的板子会被复位。',
      fields: host ? [{ id: 'prefer', label: '先试这些复位线', kind: 'text', required: false, placeholder: '例如 12,13' }]
        : [{ id: 'host', label: '主机', kind: 'choice', required: true, initial: host ?? labHosts[0]!.host, options: labHosts.map(item => ({ value: item.host, label: item.host })) },
          { id: 'prefer', label: '先试这些复位线', kind: 'text', required: false, placeholder: '例如 12,13' }] }
    const bind = entry && { id: 'bind', title: '人工刷机', about: '板子没有复位线：你按住 BOOT 再按 RESET 让它进下载模式。请保证此时只有一块还没登记的板子处于下载模式。',
      fields: [
        { id: 'usb', label: '下载口', kind: 'choice', required: true, initial: sole(entry.usb), options: entry.usb.map(item => ({ value: item.id, label: item.label })) },
        { id: 'console', label: '串口', kind: 'choice', required: true, initial: sole(entry.consoles), options: entry.consoles.map(item => ({ value: item.id, label: item.label })) },
        { id: 'soc', label: 'SoC', kind: 'choice', required: true, initial: 'k3', options: [{ value: 'k3', label: 'K3' }] },
        { id: 'sdk', label: 'SDK（可选）', kind: 'choice', required: false, options: [{ value: 'vendor-a', label: 'vendor-a（K1）' }] },
        { id: 'board', label: '型号（可选）', kind: 'text', required: false },
        { id: 'name', label: '板名（可选）', kind: 'text', required: false },
      ] }
    // A method neither frontend has seen: its own title, explanation and one text field.
    const lookup = { id: 'lookup', title: '按编号找', about: '输入板子背面的编号，实验室按编号登记。', fields: [{ id: 'code', label: '编号', kind: 'text', required: true, placeholder: '例如 A-12' }] }
    return reply([probe, ...(bind ? [bind] : []), lookup])
  }
  if (path === '/api/flash/package' && method === 'POST') return reply({ output: 'job flash-1 succeeded' })
  if (path === '/api/logs') return reply({ lines: ['[2026-11-10 08:59:58] U-Boot SPL 2022.10', '[2026-11-10 09:00:00] ERROR: mmc0 timeout'], matched: 2, truncated: false, source: 'backend' })
  // A person acknowledging boardd's database restore: the state stops reporting it.
  if (path === '/api/database/acknowledge' && method === 'POST') { const acknowledged = state.restored ?? null; state.restored = null; return reply({ acknowledged }) }
  if (path === '/api/lock' && method === 'POST') {
    const board = state.boards.find(b => b.name === body.board)!
    board.lease = { id: 'new', board: board.name, holder: state.you, purpose: body.purpose, startedAt: state.now, status: 'held', endedAt: null, endReason: null }
    return reply({ lease: board.lease, token: 't', gateToken: null, queued: null })
  }
  return reply({ ok: true })
}) as typeof fetch

export class FakeEventSource {
  static readonly CLOSED = 2
  static readonly instances: FakeEventSource[] = []
  readyState = 1
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>()
  constructor(readonly url: string) { FakeEventSource.instances.push(this) }
  addEventListener(name: string, listener: (event: MessageEvent) => void) {
    const list = this.listeners.get(name) ?? []
    list.push(listener)
    this.listeners.set(name, list)
  }
  removeEventListener() {}
  close() { this.readyState = 2 }
  /** What boardd answers when it is up; `drop()` is the connection going away (a proxy's 502 while it restarts). */
  opened() { this.onopen?.(new Event('open')) }
  drop() { this.onerror?.(new Event('error')) }
  /** A frame, as a browser delivers it: a named event only to listeners for that name (`message` is such a name),
      and nothing at all to a name nobody listens for. */
  emit(name: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent
    for (const listener of this.listeners.get(name) ?? []) listener(event)
  }
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
