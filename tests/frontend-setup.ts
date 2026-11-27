/**
 * Setup for frontend tests in jsdom: what a browser has and jsdom lacks (matchMedia, ResizeObserver), and boardd
 * replaced by the mock state (tests/mock-boardd.ts) behind fetch and EventSource. Every request is recorded in
 * `calls`, so tests check what the page asked boardd to do.
 */
import { vi } from 'vitest'
import { mockState } from './mock-boardd.ts'
import { marketPagesAnswer } from './public-market.ts'

/** A board whose debug session the fake host has started (and not stopped). */
const debugRunning = new Map<string, boolean>()

export const calls: Array<{ method: string, path: string, body: unknown }> = []
export let state = mockState()
export function resetMock() { state = mockState(); calls.length = 0; debugRunning.clear(); document.cookie = 'boardlab-frontend=; max-age=0' }

const history = {
  actions: [{ id: 1, at: state.now, actor: 'user:bob', board: 'boardctrl-k1-cm1', kind: 'reset', detail: null, ok: false, message: 'no sign of download mode' }],
  leases: [{ id: 'l1', board: 'boardctrl-k1-deb1', holder: 'user:alice', purpose: '临时调试', startedAt: state.now, status: 'held', endedAt: null, endReason: null }],
  scans: [],
}

// The boardctrl site: one build server with one SDK, one SDK on a source tree, a SoC whose probe image is not there.
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
const uploads = new Map<string, { size: number, received: number, name: string }>()
/** A test sets this to keep an upload's pieces from landing (by its file name) until it lets them go. */
let uploadCount = 0
export const uploadGate: { name: string | null, open: Promise<void> | null } = { name: null, open: null }
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
  if (path === '/api/boardctrl/site') return reply(site)
  // A board's debug path, as its backend reports it; starting the session makes it live until it is stopped, so a
  // page that re-reads the path after either sees what the host would say.
  if (path === '/api/debug' && method === 'POST') {
    const action = body?.action ?? 'path'
    const live = debugRunning.get(body?.board as string) ?? false
    const swd = { provider: 'my-swd', title: 'SWD over GPIO', about: '两颗 GPIO 位操作出来的链路。', kinds: ['halt', 'run', 'step', 'regs', 'trace'] }
    if (action === 'path') return reply({ debug: body.board === 'boardctrl-k1-musecard'
      ? { ...swd, running: live, endpoint: live ? '127.0.0.1:3334' : null } : null })
    if (action === 'start') { debugRunning.set(body.board as string, true); return reply({ debug: { ...swd, running: true, endpoint: '127.0.0.1:3334' } }) }
    if (action === 'stop') { debugRunning.set(body.board as string, false); return reply({ debug: { message: '调试会话已停止' } }) }
    return reply({ debug: { message: `${action} 已完成`, data: [{ label: 'pc', value: '0x08000421' }] } })
  }
  if (path.startsWith('/api/docs/')) return reply({ name: path.slice('/api/docs/'.length), title: '帮助', text: `# 帮助：${path.slice('/api/docs/'.length)}\n\n说明文字，[看这里](https://example.com/a) 和 [别点](javascript:alert(1))。\n\n\`\`\`yaml\nid: x\n\`\`\`` })
  if (path === '/api/files/usage') return reply({ used: 3 * 2 ** 30, files: 4, pending: 0, max: 20 * 2 ** 30, free: 100 * 2 ** 30, keepDays: 3 })
  // A file sent in pieces: boardd keeps what arrived, and the seal says the sha256 it hashed to.
  if (path === '/api/files/uploads' && method === 'POST') { const id = `u${++uploadCount}`; uploads.set(id, { size: body.size, received: 0, name: body.name }); return reply({ id, piece: 8 * 1024 * 1024 }) }
  const upload = /^\/api\/files\/uploads\/([^/]+)(\/seal|\/abandon)?$/.exec(path)
  if (upload) {
    const at = uploads.get(upload[1]!)!
    if (upload[2] === '/seal') return reply({ sha256: at.name === 'local.zip' ? 'ab'.repeat(32) : 'cd'.repeat(32), size: at.size, name: at.name, done: true, stored: true, received: at.size })
    if (upload[2] === '/abandon') { uploads.delete(upload[1]!); return reply({ ok: true }) }
    if (method === 'PUT') {
      if (uploadGate.name === at.name && uploadGate.open) {
        // Held until the test lets go, or broken off when the page stops the upload.
        const signal = init?.signal
        await Promise.race([uploadGate.open, new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))])
      }
      const size = (init?.body as Blob).size; at.received += size; return reply({ received: at.received, size: at.size }) }
    return reply({ id: upload[1], name: at.name, size: at.size, received: at.received })
  }
  if (path.startsWith('/api/files/')) return reply({ sha256: path.slice('/api/files/'.length), present: false })
  if (/^\/api\/boardctrl\/hosts\/[^/]+\/cache$/.test(path)) return reply([
    { host: 'host-a', cache: { path: '/var/cache/a', used: 46 * 2 ** 30, entries: 12, held: 1, max_bytes: 50 * 2 ** 30, ttl_s: 7 * 86400, min_free_bytes: 5 * 2 ** 30, free: 80 * 2 ** 30 }, error: null },
    { host: 'host-b', cache: null, error: null },
  ])
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
  // One image market with a made-up tree: its kind, folders and SoCs are only names to the page.
  if (path === '/api/markets') return reply([{ id: 'shelf', kind: 'shelf', kindTitle: '书架', about: '', title: 'Test images', source: 'site', error: null }])
  if (path === '/api/markets/shelf/list') {
    const at = url.searchParams.get('path') ?? ''
    const entries = at === '' ? [{ path: 'soc-a', name: 'soc-a', kind: 'folder', soc: 'k3' }]
      : at === 'soc-a' ? [{ path: 'soc-a/new.zip', name: 'new.zip', kind: 'image', soc: 'k3', size: 3 << 20, modified: '2026-11-20T08:00:00Z' }, { path: 'soc-a/disk.iso', name: 'disk.iso', kind: 'image', soc: 'k3', size: 1 << 20, modified: '2026-11-19T08:00:00Z' }]
      : []
    // For a board, boardd says which images it cannot take (here: anything but a .zip).
    if (url.searchParams.get('board')) for (const entry of entries as Array<Record<string, unknown>>) if (entry.kind === 'image') entry.refused = String(entry.name).endsWith('.zip') ? null : `${url.searchParams.get('board')} 的后端刷不了这种包`
    return reply({ market: 'shelf', path: at, entries, readAt: state.now })
  }
  // A search over the whole tree: only what leads to a matching image, as boardd answers it.
  if (path === '/api/markets/shelf/search') {
    const words = (url.searchParams.get('q') ?? '').trim().toLowerCase()
    const tree: Array<[string, string, string]> = [['soc-a', 'folder', 'soc-a'], ['soc-a/new.zip', 'image', 'new.zip'], ['soc-a/old', 'folder', 'soc-a/old'], ['soc-a/old/deep.zip', 'image', 'deep.zip'], ['soc-b', 'folder', 'soc-b'], ['soc-b/disk.iso', 'image', 'disk.iso']]
    const entries = words === 'nothing' ? [] : tree.filter(([at, kind, name]) => kind === 'image' ? name.includes(words) : tree.some(([below, k2]) => k2 === 'image' && below.startsWith(`${at}/`) && below.split('/').at(-1)!.includes(words)))
      .map(([at, kind, name]) => ({ path: at, name, kind, soc: 'k3', ...(kind === 'image' ? { size: 2 << 20, modified: '2026-11-20T08:00:00Z' } : {}) }))
    if (url.searchParams.get('board')) for (const entry of entries) if (entry.kind === 'image') (entry as Record<string, unknown>).refused = entry.name.endsWith('zip') ? null : 'boardctrl-k1-deb1 的后端刷不了这种包'
    // A market searched by an index that stopped short says so; the shelf answers whole.
    return reply({ market: 'shelf', text: words, entries, folders: 3, by: 'index', partial: false, readAt: state.now })
  }
  if (path === '/api/markets/shelf/targets') return reply([
    { board: 'boardctrl-k1-deb1', soc: 'k3', mine: true, free: false, why: null },
    { board: 'boardctrl-k1-pico', soc: 'k1', mine: false, free: true, why: null },
    { board: 'boardctrl-k1-cm1', soc: 'k3', mine: false, free: false, why: 'user:bob 在用' },
  ])
  // What a package would write: streamed like the backend fetching it, then its plan.
  if (path === '/api/flash/plan' && method === 'POST') {
    const plan = { package: 'new.zip', partial: true, notes: [], media: [{ id: 'disk', label: 'disk · 8 MiB', size: 8 << 20, partitions: [
      { name: 'boot', offset: 0, size: 2 << 20, image: 'boot.img', payload: 1 << 20, selectable: true },
      { name: 'rootfs', offset: 2 << 20, size: null, image: 'rootfs.img', payload: 3 << 20, selectable: true },
    ] }] }
    const text = `event: out\ndata: ${JSON.stringify({ text: 'fetching new.zip 100%' })}\n\nevent: exit\ndata: ${JSON.stringify({ ok: true, plan })}\n\n`
    return new Response(text, { headers: { 'content-type': 'text/event-stream' } })
  }
  if (path === '/api/boot-marks') return reply([
    { id: 'spl', title: 'U-Boot SPL', pattern: 'U-Boot SPL', stage: 1, tone: 'spl' }, { id: 'linux', title: 'Linux', pattern: 'Linux version', stage: 4, tone: 'kernel' },
  ])
  if (path === '/api/logs') {
    // A log of 5000 lines a second apart, read as boardd reads one: a window around a line, where every match is, or
    // where a time range's lines are.
    const total = 5000
    const stampOf = (n: number) => `2026-11-10 ${String(8 + Math.floor(n / 3600)).padStart(2, '0')}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
    const text = (n: number) => n === 1 ? `[${stampOf(n)}] ERROR: mmc0 timeout` : n === 4200 ? `[${stampOf(n)}] mmc0: retry` : `[${stampOf(n)}] U-Boot SPL line ${n}`
    const at = url.searchParams.get('at'), grep = url.searchParams.get('grep')?.toLowerCase()
    if (at) {
      const n = at === 'end' ? total - 1 : at === 'start' ? 0 : Number(at.slice('line:'.length))
      const from = Math.max(0, n - Number(url.searchParams.get('before') ?? 0)), to = Math.min(total, n + Number(url.searchParams.get('after') ?? 0) + 1)
      const numbers = Array.from({ length: to - from }, (_, i) => from + i)
      return reply({ lines: numbers.map(text), numbers, positions: numbers.map(i => `d:${i}`), matched: numbers.length, truncated: false, total, base: 0, moreBefore: from > 0, moreAfter: to < total, source: 'backend' })
    }
    // Three boots: two stages of the first, the kernel of the second and third.
    if (url.searchParams.get('marks') === '1') {
      const all = [{ line: 100, id: 'spl', text: 'U-Boot SPL 2022.10' }, { line: 140, id: 'linux', text: 'Linux version 6.6.36 (b@h)' }, { line: 2000, id: 'linux', text: 'Linux version 6.6.36 (b@h)' }, { line: 4000, id: 'spl', text: 'U-Boot SPL 2022.10' }, { line: 4050, id: 'linux', text: 'Linux version 6.6.36 (b@h)' }]
      const from = Number(url.searchParams.get('fromLine') ?? 0)
      return reply({ lines: [], matched: 0, truncated: false, total, base: 0, marks: all.filter(mark => mark.line >= from), marksTruncated: false, source: 'backend' })
    }
    if (url.searchParams.get('hits') === '1') {
      const hits = Array.from({ length: total }, (_, i) => i).filter(i => !grep || text(i).toLowerCase().includes(grep))
      return reply({ lines: [], matched: hits.length, truncated: false, hits, hitsTruncated: false, total, base: 0, source: 'backend' })
    }
    // Where a time range's lines are: the first one inside it and how many it holds, read no lines.
    if (url.searchParams.get('bounds') === '1') {
      const since = url.searchParams.get('since') ?? '', until = url.searchParams.get('until') ?? ''
      const inside = Array.from({ length: total }, (_, i) => i).filter(i => (!since || stampOf(i) >= since) && (!until || stampOf(i) <= until))
      return reply({ lines: [], matched: inside.length, truncated: false, total: inside.length, ...(inside.length ? { base: inside[0] } : {}), source: 'backend' })
    }
    return reply({ lines: [text(0), text(1)], matched: 2, truncated: false, source: 'backend' })
  }
  // A person saying an agent's ask is done: the state stops carrying it as open (the real module answers the asker).
  if (path === '/api/human/resolve' && method === 'POST') { (state as unknown as { human?: unknown }).human = { open: 0, items: [] }; return reply({ message: `#${(body as { id: number }).id} 做好了` }) }
  // A person acknowledging boardd's database restore: the state stops reporting it.
  if (path === '/api/database/acknowledge' && method === 'POST') { const acknowledged = state.restored ?? null; state.restored = null; return reply({ acknowledged }) }
  // The notification bus: what boardd recorded, and the channels it pushes to. One failure and one aging match, so a
  // page that draws it shows the bus's own alerts beside the page's own notices.
  if (path === '/api/alerts') return reply({
    alerts: [
      { id: 2, at: state.now, topic: 'aging', board: 'boardctrl-k1-musecard', title: 'aging-1：panic', body: 'Kernel panic - not syncing', tags: ['aging-1', 'boardctrl-k1-musecard'], actor: 'console:aging-1', delivered: [{ channel: 'lab', ok: true, detail: 'HTTP 200' }] },
      { id: 1, at: state.now, topic: 'failed', board: 'boardctrl-k1-cm1', title: 'boardctrl-k1-cm1：复位失败', body: 'GPIO 超时', tags: ['boardctrl-k1-cm1'], actor: 'user:dana', delivered: [] },
    ],
    channels: [{ id: 'lab', kind: 'chat', title: '实验室告警群', enabled: true, url: 'https://chat.example.org/hook/…a1b2…', rules: [{ topics: ['failed'], tags: [] }], last: { at: state.now, ok: true, detail: 'HTTP 200' } }],
  })
  // The module markets, and the watchers: the page's tabs read these. The market plugin's own page lists the markets
  // this machine has, and `api/module-markets` is what the page imports a market module's views from (see public-market).
  if (path === '/api/market') return reply({ markets: [], problems: [], selected: [], canReload: true })
  if (path === '/api/module-markets') return reply(marketPagesAnswer)
  if (path === '/api/console-watch') return reply({ watchers: [], problems: [] })
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
