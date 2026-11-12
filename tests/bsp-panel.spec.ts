/**
 * A board host's own page through boardd: requests pass to the lab's bspd with its token added, streams stay live,
 * and only people get in.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { RawReply } from 'boardlab-core/core/api.ts'
import { openDatabase } from 'boardlab-core/core/db.ts'
import { BoardLab } from 'boardlab-core/core/lab.ts'
import { bsp } from '../src/modules/bsp/index.ts'
import { panelTarget } from '../src/modules/bsp/panel.ts'
import { dir, useTempDir } from './fakes.ts'

useTempDir()

let server: Server | null = null
afterEach(() => { server?.close(); server = null })

/** bspd as far as its page goes: the page, a tool call that echoes, and an event stream that sends twice. */
async function fakeBspd() {
  const seen: Array<{ method: string, url: string, auth?: string, prefix?: string, body: string }> = []
  server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      seen.push({ method: request.method!, url: request.url!, auth: request.headers.authorization, prefix: request.headers['x-forwarded-prefix'] as string | undefined, body })
      if (request.url === '/') { response.writeHead(200, { 'content-type': 'text/html' }); return void response.end('<link href="static/style.css">GPIO') }
      if (request.url === '/api/v1/health') return void response.end('{"ok":true}')
      if (request.url?.startsWith('/api/v1/tools/')) { response.writeHead(200, { 'content-type': 'application/json' }); return void response.end(JSON.stringify({ ok: true, got: JSON.parse(body || '{}') })) }
      if (request.url === '/api/v1/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: one\n\n')
        setTimeout(() => { response.write('data: two\n\n'); response.end() }, 50)
        return
      }
      response.writeHead(404); response.end()
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return { port: (server!.address() as { port: number }).port, seen }
}

async function labWith(url: string) {
  const lab = new BoardLab({ db: openDatabase(join(dir, 'b.sqlite')), modules: [bsp({ stateDir: join(dir, 'state'), sdk: { run: async () => 0 } as never })] })
  await lab.backends.add('user:alice', 'host1', 'bsp')
  await lab.backends.configure('user:alice', 'host1', { enabled: true, url, username: '', password: 'host-secret', devices: '' })
  const call = (method: 'GET' | 'POST', path: string, holder = 'user:alice', body: Record<string, unknown> = {}) => {
    const url_ = new URL(path, 'http://boardd')
    const found = lab.api.match(method, url_.pathname)
    if (!found) throw new Error(`no ${method} ${path}`)
    return found.endpoint.handle({ query: url_.searchParams, params: found.params, body, headers: { accept: 'text/html', cookie: 'boardlab=1' }, caller: { holder, local: true }, signal: new AbortController().signal, upload: null }) as Promise<RawReply>
  }
  return { lab, call }
}

const text = async (reply: RawReply) => { let out = ''; for await (const chunk of reply.body ?? []) out += chunk.toString(); return out }

describe('a board host\'s page through boardd', () => {
  it('reads the bspd address of a lab, and refuses anything else', () => {
    expect(panelTarget('bspd+ssh://root@host-a:8765')).toEqual({ kind: 'ssh', target: 'root@host-a', sshPort: null, port: 8765 })
    expect(panelTarget('bspd+http://127.0.0.1:9000')).toEqual({ kind: 'http', host: '127.0.0.1', port: 9000 })
    expect(() => panelTarget('bspd+ssh://root@host-a;id:8765')).toThrow(/不合法|没有 bspd 地址/)
    expect(() => panelTarget(null)).toThrow(/没有 bspd 地址/)
  })


  it('passes the page, tool calls and event streams on, with the lab\'s token added and the browser\'s own left out', async () => {
    const bspd = await fakeBspd()
    const { call } = await labWith(`bspd+http://127.0.0.1:${bspd.port}`)
    const page = await call('GET', '/api/bsp/hosts/host1/panel/')
    expect(page.status).toBe(200)
    expect(await text(page)).toContain('static/style.css')
    const tool = await call('POST', '/api/bsp/hosts/host1/panel/api/v1/tools/gpio_list', 'user:alice', { all: true })
    expect(JSON.parse(await text(tool))).toEqual({ ok: true, got: { all: true } })
    const events = await call('GET', '/api/bsp/hosts/host1/panel/api/v1/events')
    const chunks: string[] = []
    for await (const chunk of events.body ?? []) chunks.push(chunk.toString())
    expect(chunks.join('')).toBe('data: one\n\ndata: two\n\n')
    expect(chunks.length).toBeGreaterThan(1)                                       // streamed, not buffered
    const forwarded = bspd.seen.filter(item => item.url !== '/api/v1/health')
    expect(forwarded.every(item => item.auth === 'Bearer host-secret' && item.prefix === '/api/bsp/hosts/host1/panel')).toBe(true)
  })

  it('is for people only, and only for bsp labs', async () => {
    const bspd = await fakeBspd()
    const { call } = await labWith(`bspd+http://127.0.0.1:${bspd.port}`)
    await expect(call('GET', '/api/bsp/hosts/host1/panel/', 'claude:task-1')).rejects.toThrow(/只给人用/)
    await expect(call('GET', '/api/bsp/hosts/nope/panel/')).rejects.toThrow(/没有 bsp 实验室 nope/)
    expect(bspd.seen).toEqual([])
  })
})

describe('host models', () => {
  it('lists the host models bsp has a header map for, by id and name', async () => {
    const { hostBoards } = await import('../src/modules/bsp/index.ts')
    const boards = hostBoards(join(import.meta.dirname, '../externals/bsp'))
    expect(boards.length).toBeGreaterThanOrEqual(2)
    expect(boards.find(item => item.id === 'spacemit-k1x-deb1')?.name).toBe('SpacemiT K1-x deb1')
    expect(hostBoards(null)).toEqual([])
  })
})
