/**
 * A mock boardd for frontend tests and design work: it serves a built frontend directory and answers the API with a
 * fake lab (boards in every state, a lab that can discover and rebuild, the local module's slots and a scan, Home
 * Assistant, proposals, history), events and a console that talks back. No hardware, no boardd.
 *
 *   node --experimental-strip-types tests/mock-boardd.ts [port] [dist/ui]      (or import { startMock })
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { Board, State } from 'boardlab-core/shared/types.ts'

const now = '2026-11-10T09:30:00.000Z'
const lease = (board: string, holder: string, purpose: string) => ({ id: `l-${board}`, board, holder, purpose, startedAt: now, status: 'held' as const, endedAt: null, endReason: null })
const chip = (board: string, online = true) => ({ board, die: 'die0', serialPath: null, baud: 115200, alias: board, downloadUsbPath: '2-1.4', usbId: null, lastSeenAt: now, online, gateError: null })
const inLab = (device: string, extra: Partial<NonNullable<Board['lab']>> = {}): Board['lab'] => ({
  id: 'bsp', device, online: false, ip: null, heldBy: null, leaseError: null, attention: null, canConfirm: true, empty: false, slotGone: false,
  canRefresh: true, mediaBoot: { method: 'reset', available: true, why: null }, sdks: ['k1x-2.0', 'upstream-k1'], progress: null, ...extra,
})
const board = (name: string, extra: Partial<Board>): Board => ({
  name, slot: null, serial: null, product: null, baseMac: null, soc: null, notes: null, source: 'lab', mode: 'normal', chips: [chip(name)],
  lease: null, waiters: [], lastSeenAt: now, backend: 'bsp', slotRef: null, lab: null, ...extra,
} as Board)

export function mockState(you = 'user:alice'): State {
  return {
    you, now,
    modules: [{ id: 'local', title: '本机' }, { id: 'home-assistant', title: 'Home Assistant' }, { id: 'script-slots', title: '脚本槽位' }, { id: 'bsp', title: 'bsp 板卡主机' }],
    boards: [
      board('bsp-k1-musecard', { product: 'k1-x_MUSE-Card', soc: 'k1', slotRef: 'bsp/host-a/s1', lab: inLab('k1-musecard') }),
      board('bsp-k3-deb1', { product: 'k3_deb1', soc: 'k3', slotRef: 'bsp/host-b/s3', lease: lease('bsp-k3-deb1', you, '临时调试'), lab: inLab('k3-deb1', { mediaBoot: { method: 'rom-handoff', available: true, why: null } }) }),
      board('bsp-k3-cm1', { product: 'k3_com260', soc: 'k3', slotRef: 'bsp/host-b/s4', lease: lease('bsp-k3-cm1', 'user:bob', '跑启动回归'), waiters: [{ id: 'w1', board: 'bsp-k3-cm1', holder: 'user:carol', purpose: '临时开发任务', queuedAt: now }], lab: inLab('k3-cm1') }),
      board('bsp-k1-pico', { product: 'k1-x_pico', soc: 'k1', slotRef: 'bsp/host-a/s2', lab: inLab('k1-pico', { attention: '请按一下 k1-pico 的 RESET 键，然后点「我已完成」' }) }),
      board('bsp-k3-gone', { product: 'k3_deb1', soc: 'k3', slotRef: 'bsp/host-b/s1', chips: [chip('bsp-k3-gone', false)], lab: inLab('k3-gone', { slotGone: true }) }),
      board('bsp-host-b-s6', { slotRef: 'bsp/host-b/s6', lab: inLab('host-b-s6', { empty: true, canRefresh: false, mediaBoot: null, sdks: [] }) }),
      board('desk-k1', { product: 'k1-x_deb1', soc: 'k1', slot: 1, backend: 'local', source: 'scan', lab: null }),
    ],
    labs: [{
      id: 'bsp', kind: 'bsp 板卡主机', about: 'boardd 用 bsp 命令行操作 bsp 管理的板子。', fields: { url: { label: 'bsp 主机 registry', placeholder: 'http://registry:8765', required: false } },
      canDiscover: true, canRebuild: true, canRediscover: true, canRemove: true, canBind: true, canRelay: true, hosts: ['host-a', 'host-b'],
      discovery: { running: false, line: '登记了 1 块：host-a/k1-musecard', at: now }, enabled: true, url: 'http://registry.example:8765', username: null,
      hasPassword: false, jump: null, defaultJump: null, devices: null, verifiedAt: now, verifyOk: true, verifyMessage: '2 台 bsp 主机（host-a、host-b），5 块板子',
    }],
    firmware: [{ soc: 'k3', purpose: 'fsbl', path: 'firmware/k3/FSBL.bin', sha256: 'a'.repeat(64), note: null }],
    proposals: [{ id: 'p1', scanId: 's1', kind: 'new-board', board: null, slot: 2, summary: '槽位 2 上的新板子：k1-x_deb1，串口 USB 1.3，下载口 1-1.2', change: { name: 'k1-deb1-2' }, status: 'pending' }],
    slots: [
      { slot: 1, kind: 'ha', label: null, resetEntity: 'switch.board_1_reset', fastbootEntity: 'button.board_1_fastboot_mode', resetScript: null, fastbootScript: null, device: null, confirmedAt: now, canReset: true, canFastboot: true },
      { slot: 5, kind: 'script', label: '米家插座 · 工位 3', resetEntity: null, fastbootEntity: null, resetScript: '#!/bin/bash\necho off-on', fastbootScript: null, device: null, confirmedAt: now, canReset: true, canFastboot: false },
    ],
    scan: { id: 's1', holder: you, scope: [1, 2], status: 'done', startedAt: now, finishedAt: now, message: null,
      steps: [{ seq: 1, at: now, slot: 1, summary: '按 fastboot：串口 USB 1.2 有反应' }, { seq: 2, at: now, slot: 2, summary: '新下载口 1-1.2，读到 k1-x_deb1' }],
      result: [{ slot: 1, board: 'desk-k1', chips: [{ die: 'die0', serialPath: '/dev/serial/by-path/pci-0000-usb-0:1.2:1.0-port0', downloadUsbPath: '1-1.1', usbId: '361c:1001', product: 'k1-x_deb1', pending: false }], flags: [] },
        { slot: 2, board: null, chips: [{ die: 'die0', serialPath: '/dev/serial/by-path/pci-0000-usb-0:1.3:1.0-port0', downloadUsbPath: '1-1.2', usbId: '361c:1001', product: 'k1-x_deb1', pending: true }], flags: [] }] },
    ha: { enabled: true, url: 'http://homeassistant.local:8123', hasToken: true, verifiedAt: now, verifyOk: true, verifyMessage: '控制器 1 个槽位' },
  } as unknown as State
}

const history = {
  actions: [
    { id: 3, at: now, actor: 'user:alice', board: 'bsp-k3-deb1', kind: 'lock', detail: '临时调试', ok: true, message: null },
    { id: 2, at: now, actor: 'user:bob', board: 'bsp-k3-cm1', kind: 'reset', detail: null, ok: false, message: 'no sign of download mode within 30s' },
    { id: 1, at: now, actor: 'boardd', board: null, kind: 'lab-sync', detail: '列出 5 块', ok: true, message: null },
  ],
  leases: [{ id: 'l1', board: 'bsp-k3-deb1', holder: 'user:alice', purpose: '临时调试', startedAt: now, status: 'held', endedAt: null, endReason: null }],
  scans: [],
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json' }

/** Start the mock on `port` (0: any), serving the frontend `name` in `uiDir` (or the one frontends.json picks). */
export async function startMock(uiDir: string, port = 0): Promise<{ url: string, calls: string[], state: State, close(): Promise<void> }> {
  const state = mockState()
  const calls: string[] = []
  const json = (res: ServerResponse, body: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  const body = async (req: IncomingMessage) => { let data = ''; for await (const chunk of req) data += chunk; return data ? JSON.parse(data) : {} }
  const frontends = existsSync(join(uiDir, 'frontends.json')) ? JSON.parse(readFileSync(join(uiDir, 'frontends.json'), 'utf8')) : null
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock')
    const path = url.pathname
    if (path.startsWith('/api/')) calls.push(`${req.method} ${path}${url.search}`)
    if (path === '/api/state') return json(res, state)
    if (path === '/api/history') return json(res, history)
    if (path === '/api/board') { const b = state.boards.find(item => item.name === url.searchParams.get('name')); return json(res, { board: b, actions: history.actions.filter(a => a.board === b?.name), leases: [] }) }
    if (path === '/api/frontends') {
      const cookie = /boardlab-frontend=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
      if (req.method === 'POST') { res.setHeader('Set-Cookie', `boardlab-frontend=${url.searchParams.get('name')}; Path=/`); return json(res, { current: url.searchParams.get('name') }) }
      return json(res, { ...(frontends ?? { default: null, frontends: [] }), current: cookie ?? frontends?.default ?? null })
    }
    if (path === '/api/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ok\n\n'); return }
    if (path === '/api/console') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`event: history\ndata: ${JSON.stringify(['U-Boot SPL 2022.10 (Nov 10 2026)', 'DDR: 8 GiB', 'Hit any key to stop autoboot:  0', 'root@k1:~# '])}\n\n`)
      return
    }
    if (req.method === 'POST') {
      const input = await body(req)
      if (path === '/api/lock') { const b = state.boards.find(item => item.name === input.board)!; b.lease = lease(b.name, state.you, input.purpose) as Board['lease']; return json(res, { lease: b.lease, token: 't', gateToken: null, queued: null }) }
      if (path === '/api/unlock') { const b = state.boards.find(item => item.name === input.board)!; b.lease = null; return json(res, { ok: true }) }
      return json(res, { ok: true, message: 'ok' })
    }
    // The frontend: the one the cookie names, else the default.
    const cookie = /boardlab-frontend=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
    const dir = frontends ? join(uiDir, cookie && frontends.frontends.some((f: { name: string }) => f.name === cookie) ? cookie : frontends.default) : uiDir
    const file = join(dir, path === '/' ? 'index.html' : path.slice(1))
    if (!existsSync(file) || file.includes('..')) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}/`, calls, state, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) }
}

if (process.argv[1]?.endsWith('mock-boardd.ts')) {
  const mock = await startMock(process.argv[3] ?? 'dist/ui', Number(process.argv[2] ?? 38199))
  console.log(`mock boardd: ${mock.url}`)
}
