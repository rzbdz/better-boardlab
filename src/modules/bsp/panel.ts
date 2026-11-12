/**
 * A board host's own page (bspd's GPIO panel, events, tool list) through boardd. bspd listens only on its host's
 * loopback, so boardd reaches it the way it drives it: a `bspd+http://` lab directly, a `bspd+ssh://` lab through one
 * ssh tunnel per lab, opened on first use with boardd's key and kept while it is used. boardd adds the lab's token to
 * every request, so the browser never holds it, and only people may open it.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { createServer } from 'node:net'
import { RawReply, type Endpoint } from 'boardlab-core/core/api.ts'
import { BoardError } from 'boardlab-core/core/errors.ts'
import type { BoardLab } from 'boardlab-core/core/lab.ts'
import { isHuman } from 'boardlab-core/core/text.ts'

/** Headers that belong to one hop, never passed on. */
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'cookie', 'authorization', 'x-bsp-token', 'content-length', 'origin', 'referer'])
const IDLE_MS = 10 * 60_000

interface Tunnel { port: number, child: ChildProcess | null, ready: Promise<void>, used: number }

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)) })
})

/** `bspd+ssh://user@host:port` or `bspd+http://127.0.0.1:port`, as provision writes them. */
export function panelTarget(url: string | null): { kind: 'http', host: string, port: number } | { kind: 'ssh', target: string, sshPort: number | null, port: number } {
  const match = /^bspd\+(http|ssh):\/\/(?:([^@/]+)@)?([^:/]+)(?::(\d+))?\/?$/.exec(url ?? '')
  if (!match) throw new BoardError('invalid', `这个实验室没有 bspd 地址（${url ?? '空'}）：先装好主机`)
  const [, scheme, user, host, port] = match
  if (!/^[A-Za-z0-9._-]+$/.test(host!) || (user && !/^[A-Za-z0-9._-]+$/.test(user))) throw new BoardError('invalid', `bspd 地址不合法：${url}`)
  return scheme === 'http' ? { kind: 'http', host: host!, port: Number(port ?? 8765) }
    : { kind: 'ssh', target: `${user ? `${user}@` : ''}${host}`, sshPort: null, port: Number(port ?? 8765) }
}

export function panelEndpoints(lab: BoardLab, options: { sshKey?: string | null, ssh?: string }): Endpoint[] {
  const tunnels = new Map<string, Tunnel>()
  const close = (id: string) => { const tunnel = tunnels.get(id); tunnel?.child?.kill(); tunnels.delete(id) }
  const sweep = setInterval(() => { for (const [id, tunnel] of tunnels) if (Date.now() - tunnel.used > IDLE_MS) close(id) }, 60_000)
  sweep.unref()

  /** Where on this machine the lab's bspd answers: its own address, or a tunnel's local end. */
  const local = async (id: string, url: string | null): Promise<number> => {
    const target = panelTarget(url)
    if (target.kind === 'http') {
      if (!['127.0.0.1', 'localhost'].includes(target.host)) throw new BoardError('invalid', 'bspd 只在它自己机器的回环地址上听')
      return target.port
    }
    let tunnel = tunnels.get(id)
    if (!tunnel || !tunnel.child || tunnel.child.exitCode !== null) {
      const port = await freePort()
      const args = ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'StrictHostKeyChecking=accept-new',
        ...(options.sshKey ? ['-i', options.sshKey, '-o', 'IdentitiesOnly=yes'] : []), '-L', `127.0.0.1:${port}:127.0.0.1:${target.port}`, target.target]
      const child = spawn(options.ssh ?? 'ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-400) })
      const ready = new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 15_000
        const poll = () => {
          if (child.exitCode !== null) return reject(new BoardError('hardware', `连不上 ${target.target}：${stderr.trim() || `ssh 退出 ${child.exitCode}`}`))
          const probe = httpRequest({ host: '127.0.0.1', port, path: '/api/v1/health', timeout: 2000 }, response => { response.resume(); resolve() })
          probe.on('error', () => { if (Date.now() > deadline) { child.kill(); reject(new BoardError('hardware', `${target.target} 的 bspd 没有应答`)) } else setTimeout(poll, 300) })
          probe.end()
        }
        poll()
      })
      tunnel = { port, child, ready, used: Date.now() }
      tunnels.set(id, tunnel)
      child.on('exit', () => { if (tunnels.get(id) === tunnel) tunnels.delete(id) })
      ready.catch(() => { if (tunnels.get(id) === tunnel) tunnels.delete(id) })
    }
    tunnel.used = Date.now()
    await tunnel.ready
    return tunnel.port
  }

  const pass = async ({ params, query, headers, caller, signal, body }: Parameters<Endpoint['handle']>[0], method: 'GET' | 'POST') => {
    if (!isHuman(caller.holder)) throw new BoardError('forbidden', '主机的 GPIO 面板只给人用；程序请用 boardlab 的命令和接口')
    const id = String(params.lab ?? '')
    const settings = lab.backends.labSettings().find(item => item.id === id)
    if (!settings || settings.addedAs !== 'bsp') throw new BoardError('not-found', `没有 bsp 实验室 ${id}`)
    const token = lab.backends.config(id).password
    const port = await local(id, settings.url)
    const rest = params['*'] || '/'
    if (/(^|\/)\.\.(\/|$)/.test(rest)) throw new BoardError('invalid', '路径不合法')
    const search = query.toString()
    const sent: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers ?? {})) if (!HOP.has(key) && typeof value === 'string') sent[key] = value
    const payload = method === 'POST' ? Buffer.from(body && Object.keys(body).length ? JSON.stringify(body) : '') : null
    if (payload) { sent['content-type'] = 'application/json'; sent['content-length'] = String(payload.length) }
    sent['x-forwarded-prefix'] = `/api/bsp/hosts/${id}/panel`
    if (token) sent.authorization = `Bearer ${token}`
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = httpRequest({ host: '127.0.0.1', port, method, path: rest + (search ? `?${search}` : ''), headers: sent }, resolve)
      outgoing.on('error', error => reject(new BoardError('hardware', `bspd 没有应答：${error.message}`)))
      signal.addEventListener('abort', () => outgoing.destroy(), { once: true })
      outgoing.end(payload ?? undefined)
    })
    signal.addEventListener('abort', () => response.destroy(), { once: true })
    const back: Record<string, string> = {}
    for (const [key, value] of Object.entries(response.headers)) if (!HOP.has(key) && key !== 'set-cookie' && typeof value === 'string') back[key] = value
    return new RawReply(response.statusCode ?? 502, back, response)
  }

  return [
    { method: 'GET', path: '/api/bsp/hosts/:lab/panel/*', about: '板卡主机自己的页面（GPIO 面板、事件、工具），经 boardd 转过去，只给人用', handle: request => pass(request, 'GET') },
    { method: 'POST', path: '/api/bsp/hosts/:lab/panel/*', about: '板卡主机页面上的操作，经 boardd 转过去（boardd 带上 token）', handle: request => pass(request, 'POST') },
  ]
}
