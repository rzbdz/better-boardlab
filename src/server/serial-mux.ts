/** Minimal serial-mux client: length-prefixed JSON over the daemon's Unix socket. */
import { execFile } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAX_MSG_SIZE = 1024 * 1024

export interface MuxHello { alias: string, device: string | null, baud: number, transport: string }

export interface MuxSession {
  hello: MuxHello
  history: string[]
  send(data: string | Uint8Array): void
  onOutput(listener: (data: Buffer) => void): () => void
  onClose(listener: (reason: string) => void): void
  close(): void
}

export interface MuxDaemon { alias: string, device: string | null, baud: number, pid: number, socket: string, usbPort: string | null }

export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

/** Incremental decoder for the 4-byte big-endian framing. */
export class FrameDecoder {
  private buffer = Buffer.alloc(0)
  push(chunk: Buffer): Array<Record<string, unknown>> {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const messages: Array<Record<string, unknown>> = []
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0)
      if (length > MAX_MSG_SIZE) throw new Error(`serial-mux 消息过大：${length}`)
      if (this.buffer.length < 4 + length) break
      messages.push(JSON.parse(this.buffer.subarray(4, 4 + length).toString('utf8')))
      this.buffer = this.buffer.subarray(4 + length)
    }
    return messages
  }
}

export class SerialMux {
  constructor(readonly home = process.env.SERIAL_MUX_HOME ?? join(homedir(), '.serial-mux')) {}

  socketPath(alias: string) { return join(this.home, 'sock', `${alias}.sock`) }

  /** Every saved daemon record, running or not. */
  records(): MuxDaemon[] {
    const dir = join(this.home, 'run')
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter(name => name.endsWith('.json')).flatMap(name => {
      try {
        const record = JSON.parse(readFileSync(join(dir, name), 'utf8'))
        return [{ alias: record.alias, device: record.device ?? null, baud: record.baud, pid: record.pid, socket: record.socket, usbPort: record.usb_port ?? null }]
      } catch { return [] }
    })
  }

  /** Running daemons according to their run records. */
  daemons(): MuxDaemon[] {
    const dir = join(this.home, 'run')
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter(name => name.endsWith('.json')).flatMap(name => {
      try {
        const record = JSON.parse(readFileSync(join(dir, name), 'utf8'))
        if (!existsSync(record.socket ?? '')) return []
        return [{ alias: record.alias, device: record.device ?? null, baud: record.baud, pid: record.pid, socket: record.socket, usbPort: record.usb_port ?? null }]
      } catch { return [] }
    })
  }

  /** Non-interactive session: it never claims terminal-query ownership. `token` passes the daemon's input gate. */
  open(alias: string, options: { token?: string | null, timeoutMs?: number } = {}): Promise<MuxSession> {
    const timeoutMs = options.timeoutMs ?? 5000
    const path = this.socketPath(alias)
    if (!existsSync(path)) return Promise.reject(new Error(`serial-mux 没有运行 ${alias}`))
    return new Promise((resolve, reject) => {
      const socket: Socket = connect(path)
      const decoder = new FrameDecoder()
      const outputs = new Set<(data: Buffer) => void>()
      const closes: Array<(reason: string) => void> = []
      let hello: MuxHello | null = null
      let settled = false
      const timer = setTimeout(() => fail(new Error(`serial-mux ${alias} 握手超时`)), timeoutMs)
      const fail = (error: Error) => { if (!settled) { settled = true; clearTimeout(timer); socket.destroy(); reject(error) } }
      socket.on('connect', () => socket.write(encodeMessage({ type: 'hello', interactive: false, ...(options.token ? { token: options.token } : {}) })))
      socket.on('error', error => fail(new Error(`serial-mux ${alias}：${error.message}`)))
      socket.on('close', () => { fail(new Error(`serial-mux ${alias} 关闭了连接`)); closes.forEach(fn => fn('closed')) })
      socket.on('data', chunk => {
        let messages: Array<Record<string, unknown>>
        try { messages = decoder.push(chunk) } catch (error) { socket.destroy(); return fail(error as Error) }
        for (const message of messages) {
          if (message.type === 'hello_ack') hello = { alias: String(message.alias), device: (message.device as string) ?? null, baud: Number(message.baud), transport: String(message.transport) }
          else if (message.type === 'history' && hello && !settled) {
            settled = true
            clearTimeout(timer)
            resolve({
              hello,
              history: (message.lines as string[]) ?? [],
              send: data => socket.write(encodeMessage({ type: 'input', data: Buffer.from(data).toString('base64') })),
              onOutput: listener => { outputs.add(listener); return () => outputs.delete(listener) },
              onClose: listener => { closes.push(listener) },
              close: () => socket.end(),
            })
          } else if (message.type === 'output') {
            const data = Buffer.from(String(message.data), 'base64')
            outputs.forEach(fn => fn(data))
          } else if (message.type === 'error' && !settled) fail(new Error(`serial-mux ${alias}：${message.message}`))
          else if (message.type === 'serial_lost') closes.forEach(fn => fn(`serial lost: ${message.reason}`))
        }
      })
    })
  }

  /**
   * Turn the daemon's input gate on with `token`, or off with null. A daemon whose handshake does not offer
   * `input-gate` would ignore the request and leave input open, so it is refused instead.
   */
  gate(alias: string, gate: { token: string, note: string } | null, timeoutMs = 5000): Promise<void> {
    const path = this.socketPath(alias)
    if (!existsSync(path)) return Promise.reject(new Error(`serial-mux 没有运行 ${alias}`))
    return new Promise((resolve, reject) => {
      const socket: Socket = connect(path)
      const decoder = new FrameDecoder()
      let done = false
      const finish = (error?: Error) => {
        if (done) return
        done = true
        clearTimeout(timer)
        socket.end()
        if (error) reject(error); else resolve()
      }
      const timer = setTimeout(() => finish(new Error(`serial-mux ${alias} 没有回应闸门请求`)), timeoutMs)
      socket.on('connect', () => socket.write(encodeMessage({ type: 'hello', interactive: false })))
      socket.on('error', error => finish(new Error(`serial-mux ${alias}：${error.message}`)))
      socket.on('close', () => finish(new Error(`serial-mux ${alias} 关闭了连接`)))
      socket.on('data', chunk => {
        let messages: Array<Record<string, unknown>>
        try { messages = decoder.push(chunk) } catch (error) { return finish(error as Error) }
        for (const message of messages) {
          if (message.type === 'hello_ack') {
            if (!(message.capabilities as string[] | undefined)?.includes('input-gate')) {
              // Without a gate input is open, which is what turning it off asks for.
              return finish(gate ? new Error(`serial-mux ${alias} 版本太旧，不支持输入闸门；升级 serial-mux 后重启这个守护进程`) : undefined)
            }
            socket.write(encodeMessage(gate ? { type: 'gate_set', token: gate.token, note: gate.note } : { type: 'gate_clear' }))
          } else if (message.type === 'gate_ack') {
            finish(message.enabled === !!gate ? undefined : new Error(`serial-mux ${alias} 的闸门没有${gate ? '打开' : '关闭'}`))
          } else if (message.type === 'error') finish(new Error(`serial-mux ${alias}：${message.message}`))
        }
      })
    })
  }
}

export type SerialMuxRunner = (args: string[]) => Promise<void>

/** Stop every serial-mux daemon, so a scan never trusts names or bindings made before it. */
export async function stopAll(mux: SerialMux, run: SerialMuxRunner = runSerialMux): Promise<string[]> {
  const aliases = mux.records().map(record => record.alias)
  for (const alias of aliases) await run(['stop', alias])
  return aliases
}

/** Stop a daemon and drop its saved mapping, so it leaves `serial-mux list`. */
export async function stopAlias(mux: SerialMux, alias: string, run: SerialMuxRunner = runSerialMux): Promise<void> {
  if (mux.records().some(record => record.alias === alias)) await run(['stop', alias])
}

/** (Re)start the daemon for an adapter under `alias`, stopping whichever daemon held the port or the name before. */
export async function startAlias(mux: SerialMux, adapter: { link: string, device: string, usbPath: string | null, usbInterface: string | null }, alias: string, baud = 115200, run: SerialMuxRunner = runSerialMux): Promise<string> {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(alias)) throw new Error(`serial-mux 名字不合法：${alias}`)
  // serial-mux records the port as `usb-<port>` without the bus number, ending in the interface (`usb-2.3:1.1`).
  // Ports of a multi-port adapter share the USB port, so only the interface tells which one a daemon holds.
  const port = (adapter.usbInterface ?? adapter.usbPath)?.replace(/^\d+-/, '')
  for (const record of mux.records()) {
    const segments = record.usbPort?.split('/') ?? []
    const holdsPort = record.device === adapter.device || record.device === adapter.link
      || (!!port && (adapter.usbInterface ? segments.at(-1) === `usb-${port}` : segments.includes(`usb-${port}`)))
    if (record.alias === alias && holdsPort && mux.daemons().some(daemon => daemon.alias === alias)) return alias
    if (holdsPort || record.alias === alias) await run(['stop', record.alias])
  }
  await run(['start', '--alias', alias, '--baud', String(baud), adapter.link])
  for (let i = 0; i < 50 && !existsSync(mux.socketPath(alias)); i++) await new Promise(resolve => setTimeout(resolve, 100))
  if (!existsSync(mux.socketPath(alias))) throw new Error(`serial-mux ${alias} 启动后没有出现 socket`)
  return alias
}

function runSerialMux(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('serial-mux', args, { timeout: 15000 }, (error, stdout, stderr) => error ? reject(new Error(`serial-mux ${args[0]} 失败：${`${stdout}${stderr}`.trim() || error.message}`)) : resolve())
  })
}
