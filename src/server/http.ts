/** HTTP API on 127.0.0.1 for the web page and on a Unix socket for the CLI and DSH plugin. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmodSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { userInfo } from 'node:os'
import { extname, join } from 'node:path'
import type { BoardEvent } from '../shared/types.ts'
import { BoardError, stripAnsi, type BoardService } from './service.ts'

const STATUS: Record<BoardError['code'], number> = { 'not-found': 404, invalid: 400, locked: 423, forbidden: 403, conflict: 409, hardware: 502 }
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json' }
const HOLDER_HEADER = 'x-boards-holder'
const USER_HEADER = 'x-boards-user'

export interface ServeOptions { port: number, hosts?: string[], socketPath: string, uiDir: string | null }

type Caller = { holder: string, local: boolean }
type Handler = (input: { body: any, query: URLSearchParams, caller: Caller, request: IncomingMessage, response: ServerResponse }) => unknown

export function createApi(service: BoardService): (request: IncomingMessage, response: ServerResponse, caller: Caller) => Promise<void> {
  const token = (body: any) => typeof body?.token === 'string' ? body.token : null
  const who = (caller: Caller, body: any) => ({ holder: caller.holder, token: token(body) })
  const routes: Record<string, Handler> = {
    'GET /api/state': ({ caller }) => service.state(caller.holder),
    'GET /api/board': ({ query }) => service.detail(required(query.get('name'), 'name')),
    'GET /api/history': () => service.history(),
    'GET /api/scan': ({ query }) => service.scan(required(query.get('id'), 'id')),
    'GET /api/scan/evidence': ({ query }) => service.evidence(required(query.get('id'), 'id')),
    'GET /api/log': async ({ query }) => ({ lines: (await service.log(required(query.get('board'), 'board'), query.get('die') ?? undefined, Number(query.get('lines') ?? 200))).map(stripAnsi) }),
    'GET /api/export.toml': ({ response }) => { response.setHeader('Content-Type', 'text/plain; charset=utf-8'); return service.exportToml() },
    'POST /api/lock': ({ body, caller, request }) => {
      const abort = new AbortController()
      request.socket.once('close', () => abort.abort())
      return service.lock(required(body.board, 'board'), caller.holder, String(body.purpose ?? ''), { queue: body.queue === 'join' || body.queue === 'wait' ? body.queue : 'none', signal: abort.signal })
    },
    'POST /api/unlock': ({ body, caller }) => { service.unlock(required(body.board, 'board'), who(caller, body)); return { ok: true } },
    'POST /api/unqueue': ({ body, caller }) => { service.unqueue(required(body.board, 'board'), caller.holder); return { ok: true } },
    'POST /api/steal': ({ body, caller }) => service.steal(required(body.board, 'board'), caller.holder, String(body.reason ?? '')),
    'POST /api/reset': async ({ body, caller }) => { await service.reset(required(body.board, 'board'), who(caller, body)); return { ok: true } },
    'POST /api/fastboot': async ({ body, caller }) => { await service.fastboot(required(body.board, 'board'), who(caller, body)); return { ok: true } },
    'POST /api/send': ({ body, caller }) => service.send(required(body.board, 'board'), who(caller, body), { die: body.die, text: String(body.text ?? ''), newline: body.newline, wait: body.wait, timeoutMs: body.timeoutMs }),
    'POST /api/stage': async ({ body, caller }) => ({ output: await service.stage(required(body.board, 'board'), who(caller, body), { die: body.die, firmware: required(body.firmware, 'firmware') }) }),
    'POST /api/boot': async ({ body, caller }) => {
      if (!Array.isArray(body.files) || body.files.some((file: unknown) => typeof file !== 'string')) throw new BoardError('invalid', 'files 要是文件路径数组')
      return { output: await service.boot(required(body.board, 'board'), who(caller, body), { die: body.die, files: body.files }) }
    },
    'POST /api/scan': ({ body, caller }) => service.startScan(caller.holder, { slots: body.slots, boards: body.boards, confirmed: body.confirmed === true }),
    'POST /api/scan/cancel': ({ body, caller }) => { service.cancelScan(caller.holder, required(body.id, 'id')); return { ok: true } },
    'POST /api/proposals': async ({ body, caller }) => { await service.resolveProposals(caller.holder, body.ids ?? [], body.decision === 'apply' ? 'apply' : 'reject', body.names && typeof body.names === 'object' ? body.names : {}); return { ok: true } },
    'POST /api/slots/script': ({ body, caller }) => service.saveScriptSlot(caller.holder, { slot: Number(body.slot), label: typeof body.label === 'string' ? body.label : null, resetScript: String(body.resetScript ?? ''), fastbootScript: typeof body.fastbootScript === 'string' ? body.fastbootScript : null }),
    'POST /api/slots/script/remove': ({ body, caller }) => { service.removeScriptSlot(caller.holder, Number(body.slot)); return { ok: true } },
    'POST /api/ha': ({ body, caller }) => service.configureHa(caller.holder, { url: required(body.url, 'url'), token: body.token }),
    'POST /api/ha/test': ({ caller }) => service.testHa(caller.holder),
    'POST /api/labs': ({ body, caller }) => service.configureLab(caller.holder, required(body.id, 'id'), {
      enabled: body.enabled === true, url: optional(body.url), username: optional(body.username), password: optional(body.password), jump: optional(body.jump), devices: optional(body.devices),
    }),
    'POST /api/labs/test': ({ body, caller }) => service.testLab(caller.holder, required(body.id, 'id')),
    'POST /api/boards/add': ({ body, caller }) => { service.addBoard(caller.holder, body); return { ok: true } },
    'POST /api/boards/remove': ({ body, caller }) => { service.removeBoard(caller.holder, required(body.name, 'name')); return { ok: true } },
    'POST /api/board': ({ body, caller }) => { service.updateBoard(caller.holder, required(body.name, 'name'), { notes: body.notes, slot: body.slot }); return { ok: true } },
  }

  return async (request, response, caller) => {
    const url = new URL(request.url ?? '/', 'http://boardd')
    if (request.method === 'GET' && url.pathname === '/api/events') return streamEvents(service, response)
    if (request.method === 'GET' && url.pathname === '/api/console') return streamConsole(service, url.searchParams, request, response)
    const route = routes[`${request.method} ${url.pathname}`]
    response.setHeader('Cache-Control', 'no-store')
    if (!route) return void send(response, 404, { error: '没有这个接口' })
    try {
      const body = request.method === 'POST' ? await readJson(request) : {}
      const result = await route({ body, query: url.searchParams, caller, request, response })
      if (typeof result === 'string') response.end(result)
      else send(response, 200, result ?? { ok: true })
    } catch (error) {
      if (error instanceof BoardError) send(response, STATUS[error.code], { error: error.message, code: error.code })
      else send(response, 500, { error: (error as Error).message })
    }
  }
}

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new BoardError('invalid', `缺少参数 ${name}`)
  return value
}

function optional(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) { response.end(); return }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

async function readJson(request: IncomingMessage): Promise<any> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1024 * 1024) throw new BoardError('invalid', '请求太大')
    chunks.push(chunk)
  }
  if (!size) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new BoardError('invalid', '请求不是合法 JSON') }
}

function sse(response: ServerResponse) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
  const ping = setInterval(() => response.write(': ping\n\n'), 15000)
  response.on('close', () => clearInterval(ping))
  return (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function streamEvents(service: BoardService, response: ServerResponse) {
  const write = sse(response)
  const listener = (event: BoardEvent) => write(event.type, event)
  service.events.on('event', listener)
  response.on('close', () => service.events.off('event', listener))
  write('hello', { ok: true })
}

/** Read-only console stream. Input always goes through /api/send under a lease. */
async function streamConsole(service: BoardService, query: URLSearchParams, request: IncomingMessage, response: ServerResponse) {
  let session
  try { session = await service.openConsole(query.get('board') ?? '', query.get('die') ?? undefined) }
  catch (error) { return send(response, error instanceof BoardError ? STATUS[error.code] : 502, { error: (error as Error).message }) }
  const write = sse(response)
  write('history', session.history.slice(-500).map(stripAnsi))
  const decoder = new TextDecoder()
  session.onOutput(data => write('output', stripAnsi(decoder.decode(data, { stream: true }))))
  session.onClose(reason => { write('closed', reason); response.end() })
  request.on('close', () => session.close())
}

function serveStatic(uiDir: string, pathname: string, response: ServerResponse) {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1)
  const path = join(uiDir, file)
  if (file.includes('..') || !existsSync(path)) return send(response, 404, { error: 'not found' })
  response.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  response.end(readFileSync(path))
}

/** The page always listens on loopback; extra hosts (such as a Tailscale address) are opt-in. */
export async function serve(service: BoardService, options: ServeOptions): Promise<{ http: Server[], unix: Server, close(): Promise<void> }> {
  const api = createApi(service)
  const human = `user:${userInfo().username}`
  const hosts = [...new Set(['127.0.0.1', ...(options.hosts ?? [])])]
  const allowed = new Set([...hosts, 'localhost'].map(host => `${host}:${options.port}`))

  const handle = (request: IncomingMessage, response: ServerResponse) => {
    // Refuse rebinding hosts and cross-site writes.
    if (!allowed.has(request.headers.host ?? '')) return send(response, 403, { error: '不接受这个地址的访问' })
    const origin = request.headers.origin
    if (request.method !== 'GET' && origin && !allowed.has(origin.replace(/^https?:\/\//, ''))) return send(response, 403, { error: '拒绝跨站请求' })
    const pathname = new URL(request.url ?? '/', 'http://boardd').pathname
    // People on the page name themselves so several of them can queue for one board; the default is the local user.
    const name = String(request.headers[USER_HEADER] ?? '')
    const holder = /^[A-Za-z0-9_.@-]{1,40}$/.test(name) ? `user:${name}` : human
    if (pathname.startsWith('/api/')) return void api(request, response, { holder, local: false })
    if (!options.uiDir) return send(response, 404, { error: '网页没有构建' })
    serveStatic(options.uiDir, pathname, response)
  }
  const unix = createServer((request, response) => {
    const holder = String(request.headers[HOLDER_HEADER] ?? human)
    void api(request, response, { holder, local: true })
  })

  const http: Server[] = []
  for (const host of hosts) {
    const server = createServer(handle)
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, host, resolve) })
    http.push(server)
  }
  if (existsSync(options.socketPath)) unlinkSync(options.socketPath)
  await new Promise<void>(resolve => unix.listen(options.socketPath, resolve))
  chmodSync(options.socketPath, 0o600)
  const closeServer = (server: Server) => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()) })
  return { http, unix, close: async () => { await Promise.all([...http, unix].map(closeServer)) } }
}
