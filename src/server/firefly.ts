/**
 * Firefly's aBMC (racks of K3 nodes): a Redfish-style API behind a session token, serial consoles over its
 * webtty WebSocket, and fastboot on the aBMC itself, which is also the jump host. Everything goes through ssh to the
 * jump host, so boardd needs no route to the aBMC's web port.
 */
import { createHash, randomBytes } from 'node:crypto'
import { request } from 'node:http'
import type { Duplex } from 'node:stream'
import { connect as tlsConnect } from 'node:tls'
import { FASTBOOT, jumpPresent, jumpStage, type LabConfig, type LabDevice, type LabDriver, type Shell } from './labs.ts'
import type { MuxSession } from './serial-mux.ts'

const TIMEOUT_MS = 20_000
/** How long the aBMC may take to show the boot ROM's download port after it was asked for download mode. */
const DOWNLOAD_WAIT_MS = 30_000
const DOWNLOAD_ID = '361c:1001'
/** The aBMC replays a port's whole collected log; that can take a while through the jump host. */
const HISTORY_WAIT_MS = 30_000
const HISTORY_LINES = 2_000
/** The aBMC's serial collector logs each line with this prefix. */
const LOG_PREFIX = /^[A-Z][a-z]{2} [ \d]\d [\d:]{8} \S+ abmc-serial\[\d+\]: /
const PING_MS = 30_000

export interface FireflyOptions {
  sleep?: (ms: number) => Promise<void>
  /** A stream to the aBMC's web server, already secured where it needs to be; tests replace it. */
  connect?: (config: LabConfig) => Duplex
}

/** A WebSocket carrying text frames, over a stream boardd opened itself. */
export interface TextSocket {
  send(text: string): void
  close(): void
  /** Messages that arrived before the listener was set are delivered to it. */
  listen(onMessage: (text: string) => void, onClose: (reason: string) => void): void
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** A minimal RFC 6455 client: text frames, fragmentation, ping and close. Node's WebSocket cannot run over a stream it did not open. */
export function webSocket(stream: Duplex, host: string, path: string, protocol: string, timeoutMs = TIMEOUT_MS): Promise<TextSocket> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64')
    let buffer = Buffer.alloc(0), open = false, ended = false
    let fragments: Buffer[] = []
    const queued: string[] = []
    let onMessage: ((text: string) => void) | null = null, onClose: ((reason: string) => void) | null = null, closeReason: string | null = null
    const write = (opcode: number, payload: Buffer) => {
      if (ended) return
      const mask = randomBytes(4)
      const header = payload.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
        : payload.length < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, payload.length >> 8, payload.length & 0xff])
          : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(payload.length)); return length })()])
      const body = Buffer.from(payload)
      for (let i = 0; i < body.length; i++) body[i]! ^= mask[i % 4]!
      stream.write(Buffer.concat([header, mask, body]))
    }
    const finish = (reason: string) => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      stream.destroy()
      if (!open) return reject(new Error(reason))
      closeReason = reason
      onClose?.(reason)
    }
    const deliver = (text: string) => onMessage ? onMessage(text) : queued.push(text)
    const socket: TextSocket = {
      send: text => write(0x1, Buffer.from(text)),
      close: () => { write(0x8, Buffer.alloc(0)); finish('closed') },
      listen: (message, close) => {
        onMessage = message
        onClose = close
        for (const text of queued.splice(0)) message(text)
        if (closeReason) close(closeReason)
      },
    }
    const timer = setTimeout(() => finish(`${timeoutMs / 1000} 秒内没有连上 WebSocket ${path}`), timeoutMs)
    stream.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!open) {
        const end = buffer.indexOf('\r\n\r\n')
        if (end < 0) return
        const head = buffer.subarray(0, end).toString('latin1')
        buffer = buffer.subarray(end + 4)
        const accept = head.match(/^sec-websocket-accept:\s*(\S+)/im)?.[1]
        if (!/^HTTP\/1\.1 101/.test(head) || accept !== createHash('sha1').update(key + GUID).digest('base64')) {
          return finish(`WebSocket 握手失败：${head.split('\r\n')[0]}`)
        }
        open = true
        clearTimeout(timer)
        resolve(socket)
      }
      while (buffer.length >= 2) {
        const fin = (buffer[0]! & 0x80) !== 0, opcode = buffer[0]! & 0x0f, masked = (buffer[1]! & 0x80) !== 0
        let length = buffer[1]! & 0x7f, offset = 2
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4 }
        else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10 }
        const start = offset + (masked ? 4 : 0)
        if (buffer.length < start + length) return
        const payload = Buffer.from(buffer.subarray(start, start + length))
        if (masked) for (let i = 0; i < payload.length; i++) payload[i]! ^= buffer[offset + (i % 4)]!
        buffer = buffer.subarray(start + length)
        if (opcode === 0x8) { write(0x8, Buffer.alloc(0)); return finish(`对方关闭了连接${payload.length >= 2 ? `（${payload.readUInt16BE(0)}）` : ''}`) }
        if (opcode === 0x9) { write(0xa, payload); continue }
        if (opcode === 0xa) continue
        fragments.push(payload)
        if (!fin) continue
        const message = Buffer.concat(fragments)
        fragments = []
        deliver(message.toString('utf8'))
      }
    })
    stream.on('error', error => finish(error.message))
    stream.on('close', () => finish('连接断开'))
    stream.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: ${protocol}\r\n\r\n`)
  })
}

export function fireflyAbmc(shell: Shell, options: FireflyOptions = {}): LabDriver {
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  // The aBMC serves its web pages on the jump host itself; the address in its URL can be a NAT in front of it. Its
  // certificate is its own, and the stream already reached it through the jump host ssh authenticated.
  const connect = options.connect ?? (config => {
    const url = new URL(config.url)
    const tunnel = shell.connect(config.jump, '127.0.0.1', Number(url.port || (url.protocol === 'https:' ? 443 : 80)))
    return url.protocol === 'https:' ? tlsConnect({ socket: tunnel, rejectUnauthorized: false }) : tunnel
  })
  const tokens = new Map<string, string>()
  /** Download ports learned by watching them appear, by lab and board. */
  const ports = new Map<string, string>()
  const keyOf = (config: LabConfig) => `${new URL(config.url).origin}|${config.username}`
  let entering: Promise<unknown> = Promise.resolve()

  const http = (config: LabConfig, method: string, path: string, headers: Record<string, string>, body?: unknown) => new Promise<{ status: number, json: any, text: string }>((resolve, reject) => {
    const url = new URL(config.url)
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = request({
      createConnection: () => connect(config) as never, host: url.hostname, method, path: `/redfish/v1${path}`, timeout: TIMEOUT_MS,
      headers: { Host: url.host, Connection: 'close', Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) } : {}), ...headers },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json: any = null
        try { json = JSON.parse(text) } catch {}
        resolve({ status: response.statusCode ?? 0, json, text })
      })
      response.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error(`aBMC ${method} ${path} 超过 ${TIMEOUT_MS / 1000} 秒没有回应`)))
    req.on('error', error => reject(new Error(`连不上 aBMC ${url.origin}：${error.message}`)))
    req.end(data)
  })
  const message = (result: { json: any, text: string }) => result.json?.error?.message ?? result.json?.message ?? result.json?.msg ?? result.text.slice(0, 200)
  const login = async (config: LabConfig) => {
    const result = await http(config, 'POST', '/SessionService/Sessions', {}, { username: config.username, password: config.password })
    const token = result.json?.Oem?.Firefly?.['X-Xsrf-Token']
    if (result.status >= 400 || typeof token !== 'string' || !token) throw new Error(`aBMC 拒绝了账号或密码（${result.status}）`)
    tokens.set(keyOf(config), token)
    return token
  }
  const api = async (config: LabConfig, method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> => {
    for (const retry of [true, false]) {
      const token = tokens.get(keyOf(config)) ?? await login(config)
      const result = await http(config, method, path, { 'X-Xsrf-Token': token }, body)
      // Sessions expire; one fresh login is worth a try.
      if (result.status === 401 && retry) { tokens.delete(keyOf(config)); continue }
      if (result.status >= 400) throw new Error(`aBMC ${method} ${path} 返回 ${result.status}：${message(result)}`)
      return result.json
    }
  }
  const reset = (config: LabConfig, device: string, type: string) => api(config, 'POST', `/Systems/${encodeURIComponent(device)}/Actions/ComputerSystem.Reset`, { ResetType: type })
  /** USB devices on the jump host: path → vid:pid and the number its latest enumeration got. */
  const usb = async (config: LabConfig) => {
    const result = await shell.run(config.jump, 'for d in /sys/bus/usb/devices/*; do [ -f "$d/idVendor" ] && echo "${d##*/} $(cat $d/idVendor):$(cat $d/idProduct) $(cat $d/devnum)"; done; true', 15_000)
    if (result.code !== 0) throw new Error(`读不了跳板机 ${config.jump} 的 USB 设备：${result.output.slice(-300)}`)
    return new Map(result.output.split('\n').map(line => line.trim().split(' ')).filter(parts => parts.length === 3).map(([path, id, devnum]) => [path!, `${id} ${devnum}`]))
  }
  /** A webtty stream of one board's serial port: its live console, or the log the aBMC collected. */
  const webtty = async (config: LabConfig, device: string, type: 'Serial' | 'SerialHistoryLog') => {
    const url = new URL(config.url)
    const socket = await webSocket(connect(config), url.host, `/redfish/v1/Managers/${encodeURIComponent(device)}/Oem/Firefly/Terminal/Webtty`, 'webtty')
    socket.send(JSON.stringify({ Type: type }))
    socket.send(`3${JSON.stringify({ columns: 200, rows: 50 })}`)
    socket.send('4base64')
    return socket
  }
  const history = async (config: LabConfig, device: string): Promise<string[]> => {
    const socket = await webtty(config, device, 'SerialHistoryLog')
    const chunks: Buffer[] = []
    await new Promise<void>(done => {
      const timer = setTimeout(() => { socket.close(); done() }, HISTORY_WAIT_MS)
      socket.listen(text => { if (text[0] === '1') chunks.push(Buffer.from(text.slice(1), 'base64')) }, () => { clearTimeout(timer); done() })
    })
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/).map(line => line.replace(LOG_PREFIX, '')).slice(-HISTORY_LINES)
  }

  return {
    kind: 'Firefly aBMC',
    defaultJump: url => `bmc@${url.hostname}:2222`,

    async verify(config) {
      tokens.delete(keyOf(config))
      const systems = await api(config, 'GET', '/Systems')
      const board = await api(config, 'GET', '/Chassis/bmc/Oem/Firefly/Board').catch(() => null)
      const nodes = (systems?.Members ?? []).filter((member: any) => !String(member['@odata.id']).endsWith('/bmc')).length
      const abmc = `aBMC 登录正常${board?.info?.ProductName ? `，${board.info.ProductName}` : ''}，${nodes} 个节点`
      const fastboot = await shell.run(config.jump, `f=${FASTBOOT}; [ -x "$f" ] && echo "$f"`, 20_000)
      if (fastboot.code === 0) return `${abmc}；跳板机 ${config.jump} 可登录，fastboot 在 ${fastboot.output.split('\n').at(-1)}`
      if (fastboot.code === 1) throw new Error(`${abmc}；跳板机 ${config.jump} 上没有 fastboot，boot 和 stage 用不了`)
      throw new Error(`${abmc}；跳板机 ${config.jump} 登录不了，boot 和 stage 用不了：${fastboot.output.slice(-300)}`)
    },

    async devices(config) {
      const systems = await api(config, 'GET', '/Systems')
      const ids: string[] = (systems?.Members ?? []).map((member: any) => String(member['@odata.id']).split('/').at(-1)).filter((id: string) => id && id !== 'bmc')
      const nodeConfig = await api(config, 'GET', '/Oem/PrometheusServices/NodeConfig').catch(() => ({}))
      const list: LabDevice[] = []
      for (const id of ids) {
        const system = await api(config, 'GET', `/Systems/${encodeURIComponent(id)}`)
        // An empty slot is still listed by the aBMC.
        if (system?.Status?.State === 'Absent') continue
        list.push({
          name: id, model: /X100/i.test(String(system?.ProcessorSummary?.Model ?? '')) ? 'k3' : null,
          online: system?.PowerState === 'On', serialPort: `/dev/ttydebug_${id}`,
          // Consoles come from the aBMC's serial collector, so they work while it runs.
          serialConnected: /running/.test(String(nodeConfig?.[id]?.SerialCollectStatus ?? '')),
          downloadUsbPath: ports.get(`${keyOf(config)}|${id}`) ?? null, ip: null,
        })
      }
      return list
    },

    reset: async (config, device) => { await reset(config, device, 'PowerCycle') },

    // Which download port is this board's shows only when it appears, so boards enter download mode one at a time.
    fastboot(config, device) {
      const run = entering.then(async () => {
        const before = await usb(config)
        await reset(config, device, 'LoaderByHardware')
        for (let waited = 0; ; waited += 1_000) {
          await sleep(1_000)
          const now = await usb(config)
          const fresh = [...now].filter(([path, state]) => state.startsWith(`${DOWNLOAD_ID} `) && before.get(path) !== state).map(([path]) => path)
          if (fresh.length === 1) { ports.set(`${keyOf(config)}|${device}`, fresh[0]!); return fresh[0]! }
          if (fresh.length > 1) throw new Error(`同时出现了几个下载口（${fresh.join(', ')}），认不出哪个是 ${device}`)
          if (waited >= DOWNLOAD_WAIT_MS) throw new Error(`已经让 ${device} 进 Loader，但 ${DOWNLOAD_WAIT_MS / 1000} 秒内跳板机上没有出现新的下载口`)
        }
      })
      entering = run.catch(() => {})
      return run
    },

    async console(config, device, consoleOptions = {}) {
      const backlog = consoleOptions.history === false ? [] : await history(config, device).catch(() => [])
      const socket = await webtty(config, device, 'Serial')
      const outputs = new Set<(data: Buffer) => void>()
      const closes = new Set<(reason: string) => void>()
      // The aBMC says how large an input frame may be; base64 makes three bytes four characters.
      let frameSize = 1024
      const ping = setInterval(() => socket.send('2'), PING_MS)
      socket.listen(text => {
        if (text[0] === '1') { const data = Buffer.from(text.slice(1), 'base64'); outputs.forEach(listener => listener(data)) }
        else if (text[0] === '6') frameSize = Number(text.slice(1)) || 1024
      }, reason => { clearInterval(ping); closes.forEach(listener => listener(`aBMC 串口连接关闭：${reason}`)) })
      return {
        hello: { alias: device, device: `/dev/ttydebug_${device}`, baud: 115200, transport: 'webtty' },
        history: backlog,
        send: data => {
          const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data)
          const step = Math.max(3, Math.floor((frameSize - 1) / 4) * 3)
          for (let i = 0; i < bytes.length; i += step) socket.send(`1${bytes.subarray(i, i + step).toString('base64')}`)
        },
        onOutput: listener => { outputs.add(listener); return () => outputs.delete(listener) },
        onClose: listener => { closes.add(listener) },
        close: () => { clearInterval(ping); outputs.clear(); closes.clear(); socket.close() },
      } satisfies MuxSession
    },

    stage: (config, usbPath, file, timeoutMs) => jumpStage(shell, config.jump, usbPath, file, timeoutMs),
    present: (config, usbPath) => jumpPresent(shell, config.jump, usbPath),
  }
}
