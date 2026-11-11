/**
 * Another boardd as a backend: a hub boardd lists the boards of the host boardds it connects to and forwards every
 * request to the boardd that owns the board, as any client would, over its /api. The host boardd stays the authority for
 * its boards (their names, locks and queue, history): a lock taken here is a lock taken there, for the same person or
 * agent, so whoever looks at the host directly sees it too. Boards held on the host by someone else show as held.
 */
import { BoardsClient, transportFor, type Transport } from 'boardlab-core/shared/client.ts'
import type { Board, LockResult, State } from 'boardlab-core/shared/types.ts'
import type { Backend, BoardTarget, LabConfig, LabDevice, LabNews, LabSlots } from 'boardlab-core/core/backend.ts'
import type { ConsoleSession } from 'boardlab-core/core/console.ts'
import { BoardError } from 'boardlab-core/core/errors.ts'

export interface HostOptions {
  /** How to reach a host's boardd from its settings (tests pass their own). */
  transport?: (config: LabConfig) => Transport
}

/** `boardlab:<holder>` as the core names a lease it holds for someone: the host is told who that someone is. */
const holderOf = (holder: string) => holder.replace(/^boardlab:/, '')

export function hostLab(options: HostOptions = {}): Backend {
  const transport = options.transport ?? ((config: LabConfig) => transportFor({ url: config.url, user: config.username || undefined, password: config.password || undefined }))
  const transports = new Map<string, Transport>()
  const reach = (config: LabConfig) => { const key = `${config.url}\0${config.username}`; let t = transports.get(key); if (!t) transports.set(key, t = transport(config)); return t }
  /** A client acting for `holder` on the host: a person by name, an agent by its holder. */
  const as = (config: LabConfig, holder?: string | null): BoardsClient => {
    if (!holder) return new BoardsClient(reach(config))
    const client = new BoardsClient(reach(config), holder)
    if (!holder.startsWith('user:')) return client
    const person = holder.slice(5)
    const open = client.open.bind(client)
    client.open = (method, path, headers = {}) => open(method, path, { 'x-boards-user': person, ...headers })
    return client
  }
  // The leases this hub took, by the host's board name: boards held there by anyone else show as held.
  const mine = new Map<string, string>()
  const fail = (error: unknown): never => {
    const e = error as { code?: string | null, message?: string }
    throw new BoardError((e.code as never) ?? 'hardware', e.message ?? String(error))
  }
  const call = async <T>(promise: Promise<T>): Promise<T> => { try { return await promise } catch (error) { return fail(error) } }
  const lab = (state: State) => state.labs.find(item => item.enabled && item.canDiscover) ?? null
  const hostName = (board: Board) => { const ref = (board.slotRef ?? '').split('/'); return ref.length === 3 ? ref[1]! : 'local' }
  const slotName = (board: Board) => { const ref = (board.slotRef ?? '').split('/'); return ref.length === 3 ? ref[2]! : board.slot != null ? `s${board.slot}` : board.name }

  function device(board: Board): LabDevice {
    const chip = board.chips[0]
    const held = board.lease && board.lease.id !== mine.get(board.name) ? board.lease.holder : board.lab?.heldBy ?? null
    return {
      name: board.name, address: board.name, slot: `${hostName(board)}/${slotName(board)}`, host: hostName(board),
      empty: !!board.lab?.empty, slotGone: !!board.lab?.slotGone, mediaBoot: board.lab?.mediaBoot ?? null,
      model: board.product, soc: board.soc, sdks: board.lab?.sdks ?? [],
      online: board.chips.some(item => item.online), serialPort: chip?.serialPath ?? null, serialConnected: board.chips.some(item => item.online),
      downloadUsbPath: chip?.downloadUsbPath ?? null, ip: board.lab?.ip ?? null,
      heldBy: held, attention: board.lab?.attention ?? null,
    }
  }

  /** The host's console of a board as a session here: its backlog, then its output, and keystrokes sent back. */
  function console_(config: LabConfig, target: BoardTarget, history: boolean): Promise<ConsoleSession> {
    const client = as(config)
    const path = `/api/console?raw=1&board=${encodeURIComponent(target.device)}${target.die && target.die !== 'die0' ? `&die=${encodeURIComponent(target.die)}` : ''}`
    return new Promise((resolve, reject) => {
      const req = client.open('GET', path, { accept: 'text/event-stream' })
      const outputs = new Set<(data: Buffer) => void>(), closes = new Set<(reason: string) => void>()
      let opened = false, closed = false, buffer = ''
      const close = (reason: string) => { if (closed) return; closed = true; for (const fn of closes) fn(reason); req.destroy() }
      req.on('response', response => {
        if ((response.statusCode ?? 500) >= 400) {
          let text = ''
          response.on('data', chunk => { text += chunk })
          response.on('end', () => { let message = text; try { message = JSON.parse(text).error ?? text } catch {} reject(new BoardError('hardware', `主机的串口打不开：${message}`)) })
          return
        }
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          buffer += chunk
          let at: number
          while ((at = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, at); buffer = buffer.slice(at + 2)
            const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message'
            const data = block.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
            if (!data) continue
            const value = JSON.parse(data)
            if (event === 'history' && !opened) {
              opened = true
              resolve({
                hello: { alias: target.device, device: null, baud: 115200, transport: 'boardlab' },
                history: history ? value as string[] : [],
                send: data => void as(config).input(target.device, { die: target.die, data: typeof data === 'string' ? data : Buffer.from(data).toString('utf8'), token: target.lease, human: !target.lease }).catch(() => {}),
                onOutput: listener => { outputs.add(listener); return () => outputs.delete(listener) },
                onClose: listener => { closes.add(listener) },
                close: () => close('关闭'),
              })
            } else if (event === 'output') for (const fn of outputs) fn(Buffer.from(String(value), 'utf8'))
            else if (event === 'closed') close(String(value))
          }
        })
        response.on('end', () => close('主机断开了串口'))
      })
      req.on('error', error => { if (!opened) reject(new BoardError('hardware', `连不上主机：${error.message}`)); else close(error.message) })
      req.end()
    })
  }

  const backend: Backend = {
    kind: 'boardlab 主机',
    about: '另一台 boardd（板卡主机上的 boardlab）：它的板子列在这里，每个请求都转给它，锁和排队以它为准；在主机自己的页面上拿的锁这里也看得到。',
    fields: {
      url: { label: '主机的 boardd', placeholder: 'ssh://boardlab@lab-1，或 http://lab-1:38127', required: true },
      username: { label: '登录名', placeholder: '主机页面要登录时填', required: false },
      password: { label: '密码', placeholder: '主机页面要登录时填', required: false },
    },
    inventory: {
      async verify(config) {
        const state = await call(as(config).state())
        const real = state.boards.filter(board => !board.lab?.empty)
        return `${real.length} 块板子${state.boards.length > real.length ? `，${state.boards.length - real.length} 个空槽位` : ''}（${[...new Set(state.boards.map(hostName))].join('、') || '没有主机'}）`
      },
      async devices(config) { return (await call(as(config).state())).boards.map(device) },
      async refresh(config, target, input) {
        const out = await call(as(config).refresh(target.device, { name: input.name ?? undefined, rename: input.rename }, target.lease))
        return { device: out.board, message: out.message }
      },
      async remove(config, name) { await call(as(config).removeBoard(name)) },
    },
    lease: {
      async take(config, name, holder) {
        const who = holderOf(holder.holder)
        if (holder.token && mine.has(name)) {
          const now = (await call(as(config).state())).boards.find(board => board.name === name)?.lease
          // Still ours for the same holder: a host lock does not run out, so there is nothing to renew (taking it again
          // would issue a new token and cut off the sessions opened under the old one).
          if (now && now.id === mine.get(name) && now.holder === who) return holder.token
          // Handed to someone else here: give the host's lock back, then take it for them.
          if (now && now.id === mine.get(name)) await call(as(config).unlock(name, holder.token))
          mine.delete(name)
        }
        const result: LockResult = await call(as(config, who).lock(name, holder.purpose))
        if (!result.lease || !result.token) throw new BoardError('locked', `主机上 ${name} 正被占用`)
        mine.set(name, result.lease.id)
        return result.token
      },
      async give(config, name, token) {
        try { await as(config).unlock(name, token) } finally { mine.delete(name) }
      },
    },
    relay: {
      async reset(config, target) { await call(as(config).reset(target.device, target.lease)) },
      async enterDownload(config, target) { await call(as(config).fastboot(target.device, target.lease)) },
      async confirm(config, target, note) { return (await call(as(config).confirm(target.device, note))).message },
    },
    channels: {
      async list(config, target) { return (await call(as(config).channels(target.device))).channels as never },
      async set(config, target, channel, action, ms) { return (await call(as(config).setChannel(target.device, channel, action, ms, target.lease))).message },
    },
    serial: {
      open: (config, target, input) => console_(config, target, input?.history !== false),
      async logs(config, target, query) {
        const params = new URLSearchParams({ board: target.device })
        if (target.die && target.die !== 'die0') params.set('die', target.die)
        for (const [key, value] of Object.entries({ since: query.since, until: query.until, grep: query.grep, limit: query.limit })) if (value != null && value !== '') params.set(key, String(value))
        if (query.regex) params.set('regex', '1')
        if (query.first) params.set('first', '1')
        return call(as(config).call('GET', `/api/logs?${params}`))
      },
    },
    download: {
      async stage(config, target, file) {
        const client = as(config)
        const sent = await call(client.sendFile(file.path))
        return (await call(client.boot(target.device, [sent], target.die, target.lease))).output
      },
      async present() { return true },
      async boot(config, target, files) {
        const client = as(config)
        const sent: string[] = []
        for (const file of files) sent.push(await call(client.sendFile(file.path)))
        return (await call(client.boot(target.device, sent, target.die, target.lease))).output
      },
    },
    builds: {
      async boot(config, target, build) {
        return (await call(as(config).bootSdk(target.device, { sdk: build.sdk, method: build.method, variant: build.variant ?? undefined }, target.lease))).output
      },
    },
    discovery: {
      // The host's boardd finds and registers its boards itself; here they show up at the next listing.
      async discover(config, input, progress) {
        const state = await call(as(config).state()), labOn = lab(state)
        if (!labOn) throw new BoardError('invalid', '这台主机没有能发现板子的实验室')
        progress(`主机的实验室 ${labOn.id} 在找板子`)
        const out = await call(as(config).discoverLab(labOn.id, { human: input.human, host: input.host ?? undefined, slots: input.slots }))
        return { message: out.message, found: [] }
      },
      async register() { throw new BoardError('invalid', '主机的 boardd 自己登记板子') },
      async rebuild(config, host, progress, _registered, input) {
        const state = await call(as(config).state()), labOn = lab(state)
        if (!labOn) throw new BoardError('invalid', '这台主机没有能重建的实验室')
        progress(`主机的实验室 ${labOn.id} ${input?.keepInUse ? '重新发现' : '重建'} ${host}`)
        const out = await call(as(config).rebuildLab(labOn.id, host, !!input?.keepInUse))
        return { message: out.message, found: [] }
      },
      keepsInUse: true,
    },
    ports: {
      async list(config): Promise<LabSlots[]> {
        const state = await call(as(config).state()), labOn = lab(state)
        return labOn?.canBind ? (await call(as(config).labSlots(labOn.id))).hosts : []
      },
      async bind(config, host, ports, name) {
        const state = await call(as(config).state()), labOn = lab(state)
        if (!labOn) throw new BoardError('invalid', '这台主机没有能登记空闲端口的实验室')
        await call(as(config).bindLab(labOn.id, { host, console: ports.console, usb: ports.usb, name: name || undefined }))
      },
    },
    news: {
      // The host's events: anything that changes its boards lists them again here; new cables are passed on.
      watch(config, onNews, ended) {
        const req = as(config).open('GET', '/api/events', { accept: 'text/event-stream' })
        let buffer = '', stopped = false
        req.on('response', response => {
          response.setEncoding('utf8')
          response.on('data', (chunk: string) => {
            buffer += chunk
            let at: number
            while ((at = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, at); buffer = buffer.slice(at + 2)
              const event = /^event: (.*)$/m.exec(block)?.[1]
              const data = block.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
              if (event === 'lab-ports' && data) {
                const news = JSON.parse(data) as { host?: string, added?: string[], removed?: string[] }
                onNews({ kind: 'ports', host: news.host ?? '', added: news.added ?? [], removed: news.removed ?? [] } as LabNews)
              } else if (event) onNews({ kind: 'hosts', host: '' })
            }
          })
          response.on('end', () => { if (!stopped) ended('主机的事件流断了') })
        })
        req.on('error', error => { if (!stopped) ended(error.message) })
        req.end()
        return () => { stopped = true; req.destroy() }
      },
    },
  }
  return backend
}
