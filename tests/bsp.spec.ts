import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Duplex } from 'node:stream'
import { bspLab, type BspRunner } from '../src/modules/bsp/driver.ts'
import { encodeMessage, FrameDecoder } from '../src/modules/serial-mux/client.ts'
import type { BoardTarget, LabConfig } from 'boardlab-core/core/backend.ts'

const on = (device: string, lease: string | null = null): BoardTarget => ({ board: `bsp-${device}`, device, lease, die: 'die0', usbPath: null, port: null, gate: null })
const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' })
const fail = (message: string, hint?: string) => ({ code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'forbidden', message, hint } }), stderr: '' })
const config: LabConfig = { url: 'http://registry.test:8765', username: '', password: 'tok', jump: '' }

/** A bsp CLI that answers from a table by its arguments after the global options, and records every call. */
function fakeBsp(answer: (args: string[]) => ReturnType<typeof ok>) {
  const calls: Array<{ args: string[], env: NodeJS.ProcessEnv }> = []
  const run: BspRunner = async (args, { env }) => { calls.push({ args, env }); return answer(args.slice(args.indexOf('--stateless') + 1)) }
  return { run, calls }
}

const DUTS = [
  { id: 'k3-a', host: 'h1', board: 'deb1', soc: 'K3', usb: 'usb:2-1.2', console: 'board1', stage: 'off-bus', console_up: true, lease: null },
  { id: 'k1-b', host: 'h2', board: 'board-k1', soc: 'k1', usb: 'usb:2-1.4', console: 'k1-b', stage: 'download-mode', lease: { holder: 'alice', purpose: 'x', expires_in_s: 30 } },
  { id: 'k3-c', host: 'h1', board: 'deb1', soc: 'k3', usb: 'usb:2-1.1', console: 'k3-c', stage: 'off-bus', console_up: false, lease: { holder: 'boardlab:user:bob', purpose: 'y', expires_in_s: 500 } },
]

describe('bsp lab driver', () => {
  it('lists bsp boards with their host, download port and who holds them outside boardd', async () => {
    const bsp = fakeBsp(args => args[0] === 'hosts' ? ok([{ host: 'h1', duts: ['k3-a', 'k3-c'] }, { host: 'h2', duts: ['k1-b'] }, { host: 'h3', error: 'timed out' }]) : ok(DUTS))
    const lab = bspLab({ run: bsp.run })
    expect(await lab.inventory!.verify(config)).toBe('2 台 bsp 主机（h1、h2），3 块板子；连不上：h3')
    const devices = await lab.inventory!.devices(config)
    expect(devices.map(d => [d.name, d.model, d.soc, d.serialPort, d.serialConnected, d.downloadUsbPath, d.heldBy])).toEqual([
      ['k3-a', 'deb1', 'K3', 'h1:board1', true, '2-1.2', null],
      ['k1-b', 'board-k1', 'k1', 'h2:k1-b', true, '2-1.4', 'alice'],
      ['k3-c', 'deb1', 'k3', 'h1:k3-c', false, '2-1.1', null],
    ])
    expect(bsp.calls[0]!.args.slice(0, 2)).toEqual(['--json', '--stateless'])
    expect(bsp.calls[0]!.env).toMatchObject({ BSP_REGISTRY: 'http://registry.test:8765', BSP_TOKEN: 'tok' })
    const only = fakeBsp(() => ok([]))
    await bspLab({ run: only.run }).inventory!.devices({ ...config, username: 'h1,h2', url: '', password: '' })
    expect(only.calls[0]!.args).toEqual(['--json', '--stateless', '-r', 'h1,h2', 'dut', 'list'])
    expect(only.calls[0]!.env.BSP_REGISTRY).toBe(process.env.BSP_REGISTRY)
    const none = fakeBsp(() => ok([{ host: 'h3', error: 'no route' }]))
    await expect(bspLab({ run: none.run }).inventory!.verify(config)).rejects.toThrow('没有连上任何 bsp 主机：h3（no route）')
  })

  it('works a DUT\'s relays and buttons on the relay controller of its own host', async () => {
    const pins = [
      { target: '33', label: 'GPIO33', aliases: ['k3-a/reset'], state: 'off', actions: ['on', 'off', 'toggle'], channel: { mode: 'relay' } },
      { target: '35', label: 'GPIO35', aliases: ['k3-a/power', 'rack/fan'], state: 'on', actions: ['on', 'off', 'toggle'], channel: { mode: 'relay' } },
      { target: '37', label: 'GPIO37', aliases: ['k3-c/boot'], state: 'released', actions: ['press', 'release'], channel: { mode: 'button' } },
    ]
    const bsp = fakeBsp(args => args.includes('gpio') ? ok(pins) : args[0] === 'dut' ? ok(DUTS) : ok({ target: '35', state: 'off' }))
    const lab = bspLab({ run: bsp.run })
    expect(await lab.channels!.list(config, on('k3-a'))).toEqual([
      { id: 'k3-a/reset', label: 'reset', kind: 'relay', state: 'off', actions: ['on', 'off', 'toggle', 'pulse'] },
      { id: 'k3-a/power', label: 'power', kind: 'relay', state: 'on', actions: ['on', 'off', 'toggle', 'pulse'] },
    ])
    expect((await lab.channels!.list(config, on('k3-c')))[0]).toMatchObject({ id: 'k3-c/boot', kind: 'button', actions: ['press', 'release', 'click'] })
    // The DUT's host is looked up once; its relay controller is asked there alone.
    expect(bsp.calls.map(call => call.args.slice(2))).toEqual([['dut', 'list'], ['-r', 'h1', 'gpio', 'list'], ['-r', 'h1', 'gpio', 'list']])
    expect(await lab.channels!.set(config, on('k3-a'), 'k3-a/power', 'pulse', 2000)).toBe('k3-a/power：pulse 2000ms，现在 off')
    expect(bsp.calls.at(-1)!.args.slice(2)).toEqual(['-r', 'h1', 'relay', 'pulse', 'k3-a/power', '--ms', '2000'])
    await lab.channels!.set(config, on('k3-c'), 'k3-c/boot', 'press', null)
    expect(bsp.calls.at(-1)!.args.slice(2)).toEqual(['-r', 'h1', 'button', 'press', 'k3-c/boot'])
    // Another board's line is not this board's to work.
    await expect(lab.channels!.set(config, on('k3-a'), 'k3-c/boot', 'press', null)).rejects.toThrow(/不是 k3-a 的线/)
  })

  it('takes, renews and gives back leases, and drives the board with the lease token', async () => {
    const bsp = fakeBsp(args => {
      if (args[1] === 'acquire') return args.includes('--lease') && !args.includes('T1') ? fail('DUT k3-a is leased by alice', 'wait') : ok({ token: 'T1' })
      if (args[1] === 'present') return ok({ present: true })
      if (args[1] === 'stage') return ok({ output: 'stage OKAY' })
      if (args[1] === 'boot') return ok({ lines: ['[0.0s] file 1/2', '[9.1s] done'] })
      return ok({})
    })
    const lab = bspLab({ run: bsp.run })
    expect(await lab.lease!.take(config, 'k3-a', { holder: 'boardlab:user:dana', purpose: '调试', token: null })).toBe('T1')
    expect(await lab.lease!.take(config, 'k3-a', { holder: 'boardlab:claude:s1', purpose: '接着调', token: 'T1' })).toBe('T1')
    await expect(lab.lease!.take(config, 'k3-a', { holder: 'boardlab:x', purpose: 'p', token: 'OLD' })).rejects.toThrow('bsp dut acquire：DUT k3-a is leased by alice（wait）')
    await lab.relay.reset(config, on('k3-a', 'T1'))
    await lab.relay.enterDownload(config, on('k3-a', 'T1'))
    expect(await lab.download.stage(config, on('k3-a', 'T1'), { path: '/tmp/FSBL.bin', sha256: 'x' }, 120_000)).toBe('stage OKAY')
    expect(await lab.download.present(config, on('k3-a', 'T1'))).toBe(true)
    expect(await lab.download.boot!(config, on('k3-a', 'T1'), [{ path: '/tmp/FSBL.bin', sha256: 'a' }, { path: '/tmp/Image.itb', sha256: 'b' }], { firstMs: 8000, laterMs: 3000, waitMs: 20000 })).toBe('[0.0s] file 1/2\n[9.1s] done')
    await lab.builds!.boot(config, on('k3-a', 'T1'), { sdk: 'sdk-a', method: 'download', variant: null }, () => {})
    await lab.lease!.give(config, 'k3-a', 'T1')
    await lab.inventory!.remove!(config, 'k3-a')
    expect(bsp.calls.map(call => call.args.slice(2).join(' '))).toEqual([
      'dut acquire k3-a --holder boardlab:user:dana --purpose 调试 --ttl 600',
      'dut acquire k3-a --holder boardlab:claude:s1 --purpose 接着调 --ttl 600 --lease T1',
      'dut acquire k3-a --holder boardlab:x --purpose p --ttl 600 --lease OLD',
      'dut reset k3-a --no-fdl --lease T1 --timeout 1800',
      'dut reset k3-a --lease T1 --timeout 1800',
      'dut stage k3-a /tmp/FSBL.bin --lease T1 --timeout 120',
      'dut present k3-a',
      'dut boot k3-a --files /tmp/FSBL.bin /tmp/Image.itb --no-reset --first-wait 8 --later-wait 3 --port-timeout 20 --lease T1 --timeout 1800',
      'dut boot k3-a --sdk sdk-a --method download --lease T1 --timeout 3600',
      'dut release k3-a --lease T1',
      'dut remove k3-a',
    ])
    const spec = { id: 'k3-board', board: 'deb1', soc: 'k3', console: { alias: 'ttyUSB3' }, fastboot: { usb: 'usb:2-1.3' }, control: { backend: 'human' } }
    const probe = fakeBsp(args => args.includes('add') ? ok({}) : ok({ results: { h1: { proposals: [{ spec, warnings: ['no download-mode signature seen'] }] } }, added: [] }))
    const found = await bspLab({ run: probe.run }).discovery!.discover(config, {}, () => {})
    expect(found.message).toBe('h1 上发现 1 块新板子，到「扫描」确认后登记')
    expect(found.found).toEqual([{ host: 'h1', name: 'k3-board', warnings: ['no download-mode signature seen'], detail: spec,
      summary: 'h1 上的新板子：deb1（k3），串口 ttyUSB3，下载口 usb:2-1.3，由人复位' }])
    expect(probe.calls[0]!.args.slice(2)).toEqual(['probe', '--register'])
    await bspLab({ run: probe.run }).discovery!.discover(config, { human: true, host: 'h1' }, () => {})
    expect(probe.calls[1]!.args.slice(2)).toEqual(['-r', 'h1', 'probe', '--register', '--human'])
    const ports = fakeBsp(args => args[0] === 'probe' ? ok({ h1: { consoles: [{ id: 'ttyUSB3', kind: 'tty', device: '/dev/ttyUSB3' }, { id: 'k9', kind: 'serial-mux', alias: 'k9', device: '/dev/ttyUSB9' }], usb: [{ usb: 'usb:2-1.2', product: 'DFU' }, { usb: 'usb:2-1.7', product: 'USB download gadget' }] } }) : ok(DUTS))
    expect(await bspLab({ run: ports.run }).ports!.list(config)).toEqual([{ host: 'h1',
      consoles: [{ id: '/dev/ttyUSB3', label: '/dev/ttyUSB3' }, { id: 'k9', label: 'serial-mux k9（/dev/ttyUSB9）' }],
      usb: [{ id: 'usb:2-1.7', label: 'usb:2-1.7 USB download gadget' }] }])
    expect(ports.calls[0]!.args.slice(2)).toEqual(['probe', '--dry-run'])
    await bspLab({ run: ports.run }).ports!.bind(config, 'h1', { console: '/dev/ttyUSB3', usb: 'usb:2-1.7' }, 'tmp-h1-ttyUSB3')
    expect(ports.calls.at(-1)!.args.slice(2)).toEqual(['dut', 'bind', 'tmp-h1-ttyUSB3', '--console', '/dev/ttyUSB3', '--usb', 'usb:2-1.7', '--host', 'h1'])
    await bspLab({ run: probe.run }).discovery!.register(config, found.found[0]!, 'slot-3')
    expect(probe.calls[2]!.args.slice(2)).toEqual(['dut', 'add', 'h1', '--spec', JSON.stringify({ ...spec, id: 'slot-3' })])
  })

  it('registers boards as bsp finds them, on the slots asked for, and says why a slot found nothing', async () => {
    const seen: string[] = []
    const bsp = fakeBsp(() => ok({ results: { h1: { proposals: [{ spec: { id: 'k3-s4' }, warnings: [], registered: { dut: 'k3-s4' } }], registered: [{ dut: 'k3-s4', slot: 's4' }], reasons: ['no reset line made console(s) s5 speak'] } } }))
    const run: BspRunner = async (args, options) => { options.onStderr?.('[h1]  [   4.7s] registered k3-s4 in slot s4'); return bsp.run(args, options) }
    const found = await bspLab({ run }).discovery!.discover(config, { slots: ['h1/s4', 'h1/s5'] }, () => {}, device => seen.push(device))
    expect(bsp.calls[0]!.args.slice(2)).toEqual(['-r', 'h1', 'probe', '--register', '--slots', 's4,s5'])
    expect(seen).toEqual(['k3-s4'])
    expect(found).toEqual({ found: [], message: '登记了 1 块：h1/k3-s4；h1：no reset line made console(s) s5 speak' })
    await expect(bspLab({ run }).discovery!.discover(config, { slots: ['h1/s4', 'h2/s1'] }, () => {})).rejects.toThrow(/一次只能发现一台主机/)
    // A rebuild starts one host over: bsp forgets its boards and slots and registers each board it finds again.
    const rebuilt = await bspLab({ run }).discovery!.rebuild!(config, 'h1', () => {}, device => seen.push(device))
    expect(bsp.calls.at(-1)!.args.slice(2)).toEqual(['-r', 'h1', 'probe', '--rebuild', '--yes'])
    expect(rebuilt.message).toBe('登记了 1 块：h1/k3-s4；h1：no reset line made console(s) s5 speak')
  })

  it('reads a board\'s log over a time range on its host, searched', async () => {
    const bsp = fakeBsp(() => ok({ lines: ['[2026-11-10 09:00:00] ERROR mmc0'], matched: 1, truncated: false }))
    const range = await bspLab({ run: bsp.run }).serial.logs!(config, on('k3-a'), { since: '2026-11-10 08:00:00', grep: 'error', limit: 500 })
    expect(range).toEqual({ lines: ['[2026-11-10 09:00:00] ERROR mmc0'], matched: 1, truncated: false })
    expect(bsp.calls[0]!.args.slice(2)).toEqual(['dut', 'logs', 'k3-a', '--since', '2026-11-10 08:00:00', '--grep', 'error', '--limit', '500'])
  })

  it('greys a board whose slot lost its adapter', async () => {
    const bsp = fakeBsp(args => args.includes('slot') ? ok([]) : ok([{ ...DUTS[0], slot: 's3', slot_online: false }]))
    const [device] = await bspLab({ run: bsp.run }).inventory!.devices(config)
    expect(device).toMatchObject({ slot: 'h1/s3', slotGone: true })
  })

  it('lists empty slots by their console, and reads a swapped board again under its lease', async () => {
    const bsp = fakeBsp(args => args.includes('slot') ? ok([{ id: 's3', host: 'h1', ref: 'h1/s3', alias: 's3', online: true, console_up: true, dut: 'k3-a' }, { id: 's4', host: 'h1', ref: 'h1/s4', alias: 's4', online: true, console_up: true, dut: null }, { id: 's5', host: 'h1', ref: 'h1/s5', online: false, dut: null }])
      : args.includes('refresh') ? ok({ status: 'succeeded', result: { dut: 'k3-board-32g', changed: ['board', 'id'], board: 'k3_com260', identified: true } })
        : ok([{ ...DUTS[0], slot: 's3', media_boot: { method: 'rom-handoff', available: true } }]))
    const lab = bspLab({ run: bsp.run })
    const devices = await lab.inventory!.devices(config)
    expect(devices[0]!.mediaBoot).toEqual({ method: 'rom-handoff', available: true })
    expect(devices.map(d => [d.name, d.address ?? null, d.slot, !!d.empty, d.serialPort])).toEqual([
      ['k3-a', null, 'h1/s3', false, 'h1:board1'], ['h1-s4', 'h1/s4', 'h1/s4', true, 'h1:s4'],
    ])
    // An empty slot has no bsp lease to take; its console is reached by its slot.
    expect(await lab.lease!.take(config, 'h1/s4', { holder: 'boardlab:user:a', purpose: 'p', token: null })).toBe('slot')
    await lab.lease!.give(config, 'h1/s4', 'slot')
    expect(bsp.calls.filter(call => call.args.includes('acquire') || call.args.includes('release'))).toEqual([])
    const lines: string[] = []
    expect(await lab.inventory!.refresh!(config, on('k3-a', 'T1'), { rename: true }, line => lines.push(line))).toEqual({ device: 'k3-board-32g', message: 'k3-board-32g：读到 k3_com260，改了 board、id' })
    expect(bsp.calls.at(-1)!.args.slice(2)).toEqual(['dut', 'refresh', 'k3-a', '--lease', 'T1', '--timeout', '1800', '--rename'])
    // A board a person resets: bsp's progress lines become the notice on its card.
    const notices: Array<string | null> = []
    const human = bspLab({ run: async (args, { onStderr }) => {
      if (args.includes('confirm')) return ok({ confirmed: 'reset', waited_s: 4.2 })
      onStderr?.('slot-1 @ h1: reset needs a person, job reset-1 (confirm with `bsp dut confirm slot-1`)')
      onStderr?.('[   0.0s] ACTION NEEDED: press RESET on slot-1 (board-x)')
      onStderr?.('[   4.2s] reset: confirmed by a person')
      return ok({ status: 'succeeded' })
    } })
    await human.relay.reset(config, on('slot-1', 'T'), message => notices.push(message))
    expect(notices).toEqual(['press RESET on slot-1 (board-x)', null])
    expect(await human.relay.confirm!(config, on('slot-1', 'T'), '')).toBe('已确认「reset」（等了 4.2 秒）')
    const broken = bspLab({ run: async () => ({ code: null, stdout: '', stderr: 'spawn bsp ENOENT' }) })
    await expect(broken.inventory!.devices(config)).rejects.toThrow('bsp dut list 失败（超时或没能运行）：spawn bsp ENOENT')
  })

  it('opens the console through `bsp dut pipe` with serial-mux\'s own protocol', async () => {
    let spawned: string[] = []
    const daemonSide = new PassThrough(), boarddSide = new PassThrough()
    const typed: string[] = []
    const decoder = new FrameDecoder()
    daemonSide.on('data', chunk => {
      for (const message of decoder.push(chunk)) {
        if (message.type === 'hello') {
          boarddSide.write(encodeMessage({ type: 'hello_ack', alias: 'board1', device: '/dev/ttyUSB0', baud: 115200, transport: 'serial' }))
          boarddSide.write(encodeMessage({ type: 'history', lines: ['U-Boot 2022.10', '=> '] }))
        } else if (message.type === 'input') {
          typed.push(Buffer.from(String(message.data), 'base64').toString())
          boarddSide.write(encodeMessage({ type: 'output', data: Buffer.from('version\r\n').toString('base64') }))
        }
      }
    })
    const lab = bspLab({ spawn: args => { spawned = args; return { stream: Duplex.from({ readable: boarddSide, writable: daemonSide }), stderr: () => '' } } })
    const session = await lab.serial.open(config, on('k3-a'))
    expect(spawned).toEqual(['--json', '--stateless', 'dut', 'pipe', 'k3-a'])
    expect(session.history).toEqual(['U-Boot 2022.10', '=> '])
    const out: string[] = []
    session.onOutput(data => out.push(data.toString()))
    session.send('version\n')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(typed).toEqual(['version\n'])
    expect(out).toEqual(['version\r\n'])
    session.close()

    // A pipe that cannot start prints bsp's error instead of frames.
    const errorSide = new PassThrough()
    const failing = bspLab({ spawn: () => {
      setTimeout(() => { errorSide.end(JSON.stringify({ ok: false, error: { message: 'console board1 of k3-a is not running on h1', hint: 'see `bsp dut status k3-a`' } })) }, 5)
      return { stream: Duplex.from({ readable: errorSide, writable: new PassThrough() }), stderr: () => '' }
    } })
    await expect(failing.serial.open(config, on('k3-a'))).rejects.toThrow('打不开 k3-a 的串口：console board1 of k3-a is not running on h1（see `bsp dut status k3-a`）')
  })
})

describe('bsp lab news', () => {
  it('follows the registry: port changes become news, and an ended stream says so', async () => {
    const out = new PassThrough()
    let args: string[] = []
    const lab = bspLab({ spawn: given => { args = given; return { stream: Duplex.from({ readable: out, writable: new PassThrough() }), stderr: () => 'registry gone' } } })
    const news: unknown[] = []
    let ended = ''
    const stop = lab.news!.watch(config, item => news.push(item), reason => { ended = reason })
    expect(args).toEqual(['--json', '--stateless', 'watch', '--registry'])
    out.write(JSON.stringify({ host: 'reg', topic: 'registry.ports', data: { host: 'h1', added: { tty: ['/dev/ttyUSB3'], usb: ['usb:2-1.3 361c:1001'] }, removed: { tty: [], usb: [] } } }) + '\n')
    out.write(JSON.stringify({ host: 'reg', topic: 'registry.announced', data: { host: 'h2' } }) + '\nnot json\n')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(news).toEqual([{ kind: 'ports', host: 'h1', added: ['/dev/ttyUSB3', 'usb:2-1.3'], removed: [] }, { kind: 'hosts', host: 'h2' }])
    out.end()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(ended).toBe('registry gone')
    stop()
  })
})

/** The real bsp client against bsp's mock host, when the submodule and a mock host are there (see the README). */
const MOCK = process.env.BSP_URL
describe.skipIf(!MOCK)('bsp lab driver against a bsp mock host', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bsp-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  it('lists, leases and resets the mock board', async () => {
    const lab = bspLab({ bin: process.env.BOARDS_BSP ?? join(__dirname, '../externals/bsp/bin/bsp') })
    const mock: LabConfig = { url: '', username: '', password: '', jump: '' }
    process.env.BSP_URL = MOCK
    const devices = await lab.inventory!.devices(mock)
    expect(devices.map(device => device.name)).toContain('mock-board')
    const token = await lab.lease!.take(mock, 'mock-board', { holder: 'boardlab:user:test', purpose: 'contract', token: null })
    await lab.relay.reset(mock, on('mock-board', token))
    expect(await lab.lease!.take(mock, 'mock-board', { holder: 'boardlab:user:other', purpose: 'renew', token })).toBe(token)
    await lab.lease!.give(mock, 'mock-board', token)
  })
})
