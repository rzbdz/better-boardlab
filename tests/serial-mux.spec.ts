import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { encodeMessage, FrameDecoder, SerialMux } from '../src/modules/serial-mux/client.ts'
import { dir, useTempDir } from './fakes.ts'

useTempDir()

describe('serial-mux protocol', () => {
  let server: Server
  afterEach(() => new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()))

  it('handshakes, replays history, streams output and sends base64 input', async () => {
    const home = join(dir, 'mux')
    mkdirSync(join(home, 'sock'), { recursive: true })
    const received: unknown[] = []
    server = createServer(socket => {
      const decoder = new FrameDecoder()
      socket.on('data', chunk => {
        for (const message of decoder.push(chunk)) {
          received.push(message)
          if (message.type === 'hello') {
            const ack = encodeMessage({ type: 'hello_ack', alias: 'com260', device: '/dev/ttyUSB1', baud: 115200, transport: 'serial', terminal_owner: false })
            const history = encodeMessage({ type: 'history', lines: ['[2026-10-28 10:00:00] login:'] })
            // Split frames across writes to exercise the decoder.
            const both = Buffer.concat([ack, history])
            socket.write(both.subarray(0, 7)); socket.write(both.subarray(7))
          }
          if (message.type === 'input') socket.write(encodeMessage({ type: 'output', data: Buffer.from('echo:' + Buffer.from(String(message.data), 'base64')).toString('base64') }))
        }
      })
    })
    await new Promise<void>(resolve => server.listen(join(home, 'sock', 'com260.sock'), resolve))
    const session = await new SerialMux(home).open('com260')
    expect(session.hello).toEqual({ alias: 'com260', device: '/dev/ttyUSB1', baud: 115200, transport: 'serial' })
    expect(session.history).toEqual(['[2026-10-28 10:00:00] login:'])
    const output = new Promise<string>(resolve => session.onOutput(data => resolve(data.toString())))
    session.send('ls\n')
    expect(await output).toBe('echo:ls\n')
    expect(received[0]).toEqual({ type: 'hello', interactive: false })
    session.close()
  })
})

describe('serial-mux input gate', () => {
  let server: Server
  afterEach(() => new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()))

  /** A daemon that answers the handshake, offering the gate or not, and records what it was sent. */
  async function daemon(capabilities: string[] | undefined) {
    const home = join(dir, 'mux')
    mkdirSync(join(home, 'sock'), { recursive: true })
    const received: Array<Record<string, unknown>> = []
    server = createServer(socket => {
      const decoder = new FrameDecoder()
      socket.on('data', chunk => {
        for (const message of decoder.push(chunk)) {
          received.push(message)
          if (message.type === 'hello') {
            socket.write(encodeMessage({ type: 'hello_ack', alias: 'com260', device: '/dev/ttyUSB1', baud: 115200, transport: 'serial', ...(capabilities ? { capabilities } : {}) }))
            socket.write(encodeMessage({ type: 'history', lines: [] }))
          }
          if (message.type === 'gate_set') socket.write(encodeMessage({ type: 'gate_ack', enabled: true, note: message.note }))
          if (message.type === 'gate_clear') socket.write(encodeMessage({ type: 'gate_ack', enabled: false, note: null }))
        }
      })
    })
    await new Promise<void>(resolve => server.listen(join(home, 'sock', 'com260.sock'), resolve))
    return { mux: new SerialMux(home), received }
  }

  it('sets and clears the gate, and presents the token when opening a session', async () => {
    const { mux, received } = await daemon(['input-gate'])
    await mux.gate('com260', { token: 't0k', note: 'user:dana 正在使用 com260（调试）' })
    await mux.gate('com260', null)
    const session = await mux.open('com260', { token: 't0k' })
    session.close()
    expect(received.filter(message => message.type !== 'hello')).toEqual([
      { type: 'gate_set', token: 't0k', note: 'user:dana 正在使用 com260（调试）' },
      { type: 'gate_clear' },
    ])
    expect(received.filter(message => message.type === 'hello').at(-1)).toEqual({ type: 'hello', interactive: false, token: 't0k' })
  })

  it('refuses to gate through an older serial-mux, which would leave input open', async () => {
    const { mux, received } = await daemon(undefined)
    await expect(mux.gate('com260', { token: 't0k', note: 'x' })).rejects.toThrow(/版本太旧，不支持输入闸门/)
    // Turning the gate off needs nothing from a daemon that has none.
    await mux.gate('com260', null)
    expect(received.map(message => message.type)).toEqual(['hello', 'hello'])
  })
})
