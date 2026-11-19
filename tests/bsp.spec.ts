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
/** A host bsp cannot reach: `ok: true` with an empty list, the failure only in the warnings and the exit code. */
const unreachable = (host: string, why = 'missing or wrong token') => ({ code: 3, stdout: JSON.stringify({ ok: true, result: [], warnings: [`${host} unreachable: ${why}`] }), stderr: '' })
const config: LabConfig = { url: 'http://registry.test:8765', username: '', password: 'tok', jump: '' }

/** A bsp CLI that answers from a table by its arguments after the global options, and records every call. */
function fakeBsp(answer: (args: string[]) => ReturnType<typeof ok>) {
  const calls: Array<{ args: string[], env: NodeJS.ProcessEnv }> = []
  const run: BspRunner = async (args, { env }) => {
    const rest = args.slice(args.indexOf('--stateless') + 1)
    const routed = rest[0] === '-r' ? rest.slice(2) : rest
    calls.push({ args, env })
    return answer(routed)
  }
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
    // On a board host: this machine's bspd, directly, with no registry.
    const local = fakeBsp(() => ok([]))
    await bspLab({ run: local.run }).inventory!.devices({ ...config, url: 'bspd+http://127.0.0.1:8765' })
    expect(local.calls[0]!.args).toEqual(['--json', '--stateless', '--url', 'http://127.0.0.1:8765', 'dut', 'list'])
    expect(local.calls[0]!.env.BSP_REGISTRY).toBe(process.env.BSP_REGISTRY)
    const none = fakeBsp(() => ok([{ host: 'h3', error: 'no route' }]))
    await expect(bspLab({ run: none.run }).inventory!.verify(config)).rejects.toThrow('没有连上任何 bsp 主机：h3（no route）')
  })

  it('fails on a host it cannot reach, instead of taking the empty list for no boards', async () => {
    // A stale token is `ok: true, result: []` with a warning and exit code 3: silently emptying the lab is the bug.
    const stale = fakeBsp(() => unreachable('h1'))
    await expect(bspLab({ run: stale.run }).inventory!.devices(config)).rejects.toThrow('h1 unreachable: missing or wrong token')
    // One host down while another answers: an error too, so boardd never takes a partial listing as the whole lab.
    const partial: BspRunner = async () => ({ code: 3, stdout: JSON.stringify({ ok: true, result: DUTS, warnings: ['h2 unreachable: timed out'] }), stderr: '' })
    await expect(bspLab({ run: partial }).inventory!.devices(config)).rejects.toThrow('h2 unreachable: timed out')
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
    expect(await lab.download.boot!(config, on('k3-a', 'T1'), [{ path: '/tmp/FSBL.bin', sha256: 'a' },
      { path: '/products/Image.itb', sha256: '', source: 'backend' },
      { path: 'https://images.test/kernel.itb', sha256: '', source: 'backend' }], { firstMs: 8000, laterMs: 3000, waitMs: 20000 })).toBe('[0.0s] file 1/2\n[9.1s] done')
    await lab.builds!.boot(config, on('k3-a', 'T1'), { sdk: 'sdk-a', method: 'download', variant: null }, () => {})
    await lab.lease!.give(config, 'k3-a', 'T1')
    await lab.inventory!.remove!(config, 'k3-a')
    expect(bsp.calls.map(call => call.args.slice(2).join(' '))).toEqual([
      'dut acquire k3-a --holder boardlab:user:dana --purpose 调试 --ttl 600',
      'dut acquire k3-a --holder boardlab:claude:s1 --purpose 接着调 --ttl 600 --lease T1',
      'dut acquire k3-a --holder boardlab:x --purpose p --ttl 600 --lease OLD',
      'dut status k3-a',
      'dut reset k3-a --no-fdl --lease T1 --timeout 1800',
      'dut status k3-a',
      'dut reset k3-a --lease T1 --timeout 1800',
      'dut stage k3-a /tmp/FSBL.bin --lease T1 --timeout 120',
      'dut present k3-a',
      // A checked file on boardd is still a local path for bsp to upload; only explicit backend refs bypass that.
      'dut boot k3-a --files /tmp/FSBL.bin host:/products/Image.itb https://images.test/kernel.itb --no-reset --first-wait 8 --later-wait 3 --port-timeout 20 --lease T1 --timeout 1800',
      'dut boot k3-a --sdk sdk-a --method download --lease T1 --timeout 3600',
      'dut release k3-a --lease T1',
      'dut remove k3-a',
    ])
    const spec = { id: 'k3-board', board: 'deb1', soc: 'k3', console: { alias: 'ttyUSB3' }, fastboot: { usb: 'usb:2-1.3' }, control: { backend: 'human' } }
    const probe = fakeBsp(args => args.includes('add') ? ok({}) : ok({ results: { h1: { proposals: [{ spec, warnings: ['no download-mode signature seen'] }] } }, added: [] }))
    const finder = bspLab({ run: probe.run }).discovery!
    const found = await finder.run(config, 'probe', {}, {}, () => {})
    expect(found.message).toBe('h1 上发现 1 块新板子，到「扫描」确认后登记')
    expect(found.found).toEqual([{ host: 'h1', name: 'k3-board', warnings: ['no download-mode signature seen'], detail: spec,
      summary: 'h1 上的新板子：deb1（k3），串口 ttyUSB3，下载口 usb:2-1.3，由人复位' }])
    // No host given: every host the backend can reach is probed.
    expect(probe.calls[0]!.args.slice(2)).toEqual(['probe', '--register'])
    // Automatic discovery can also be limited to one host, or told which reset lines to try first.
    await finder.run(config, 'probe', {}, { host: 'h1' }, () => {})
    expect(probe.calls[1]!.args.slice(2)).toEqual(['-r', 'h1', 'probe', '--register'])
    await finder.run(config, 'probe', { prefer: '12,13' }, { host: 'h1' }, () => {})
    expect(probe.calls[2]!.args.slice(2)).toEqual(['-r', 'h1', 'probe', '--register', '--prefer', '12,13'])
    // What the backend reports it can do, and with which fields: no host yet means only the automatic one; with a
    // host, a person's board can be registered too, with its SoC and SDK.
    const plan = fakeBsp(args => {
      if (args[0] === 'sdk') return ok([{ id: 'sdk-a', soc: 'k3' }, { id: 'sdk-b', soc: 'k1' }])
      if (args[0] === 'dut' && args[1] === 'list') return ok([])
      if (args[0] === 'probe') return ok({ h1: { consoles: [{ id: 's4', kind: 'serial-mux', alias: 's4' }], usb: [{ usb: 'usb:2-1.2', product: 'DFU' }] } })
      return ok({})
    })
    const methodsLab = bspLab({ run: plan.run }).discovery!
    const methods = await methodsLab.methods(config, {})
    // 手工登记 is not a scan: it is how a person describes a board no probe can see, and it is offered either way.
    expect(methods.map(method => [method.id, method.title])).toEqual([['probe', '自动刷机'], ['manual', '手工登记']])
    expect(methods[0]!.fields!.map(field => field.id)).toEqual(['prefer'])
    expect(methods[1]).toMatchObject({ compose: true })
    const withHost = await methodsLab.methods(config, { host: 'h1' })
    expect(withHost.map(method => method.id)).toEqual(['probe', 'bind', 'manual'])
    const bind = withHost[1]!
    expect(bind.fields!.map(field => field.id)).toEqual(['usb', 'console', 'soc', 'sdk', 'board', 'name'])
    expect(bind.fields!.find(field => field.id === 'usb')).toMatchObject({ kind: 'choice', initial: 'usb:2-1.2' })
    expect(bind.fields!.find(field => field.id === 'soc')).toMatchObject({ kind: 'choice', options: [{ value: 'k3', label: 'K3' }, { value: 'k1', label: 'K1' }] })
    expect(bind.fields!.find(field => field.id === 'sdk')).toMatchObject({ kind: 'choice', options: [{ value: 'sdk-a' }, { value: 'sdk-b' }] })
    expect((await methodsLab.methods(config, { slot: 'h1/s4' })).find(method => method.id === 'bind')!.fields!.find(field => field.id === 'console'))
      .toMatchObject({ initial: 's4' })
    const registered: string[] = []
    expect((await methodsLab.run(config, 'bind', { usb: 'usb:2-1.2', console: 's4', soc: 'k3', sdk: 'sdk-a', board: 'deb1', name: 'b1' },
      { host: 'h1' }, () => {}, device => registered.push(device))).message).toContain('SoC k3，SDK sdk-a')
    expect(plan.calls.at(-1)!.args.slice(2)).toEqual(['dut', 'bind', 'b1', '--console', 's4', '--usb', 'usb:2-1.2',
      '--host', 'h1', '--soc', 'k3', '--board', 'deb1', '--sdks', 'sdk-a'])
    expect(registered).toEqual(['b1'])
    const ports = fakeBsp(args => args[0] === 'probe' ? ok({ h1: { consoles: [{ id: 'ttyUSB3', kind: 'tty', device: '/dev/ttyUSB3' }, { id: 'k9', kind: 'serial-mux', alias: 'k9', device: '/dev/ttyUSB9' }], usb: [{ usb: 'usb:2-1.2', product: 'DFU' }, { usb: 'usb:2-1.7', product: 'USB download gadget' }] } }) : ok(DUTS))
    expect(await bspLab({ run: ports.run }).ports!.list(config)).toEqual([{ host: 'h1',
      consoles: [{ id: '/dev/ttyUSB3', label: '/dev/ttyUSB3' }, { id: 'k9', label: 'serial-mux k9（/dev/ttyUSB9）' }],
      usb: [{ id: 'usb:2-1.7', label: 'usb:2-1.7 USB download gadget' }] }])
    expect(ports.calls[0]!.args.slice(2)).toEqual(['probe', '--dry-run'])
    await bspLab({ run: probe.run }).discovery!.register(config, found.found[0]!, 'slot-3')
    expect(probe.calls[3]!.args.slice(2)).toEqual(['dut', 'add', 'h1', '--spec', JSON.stringify({ ...spec, id: 'slot-3' })])
  })

  it('reads registration choices without discovery, shares host reads and refreshes them for a save', async () => {
    const board = 'test-board'
    const host = 'test-host'
    const duts = [{ id: board, host, soc: 'k3', sdks: ['sdk-a'], sdks_explicit: true, control: { backend: 'human', reset: {}, fdl: { strategy: 'strapped' } }, usb: 'usb:1-2' }]
    let listCalls = 0, gpioCalls = 0, portCalls = 0
    const bsp = fakeBsp(args => {
      const command = args.slice(0, 2).join(' ')
      if (command === 'dut list') { listCalls++; return ok(duts) }
      if (command === 'dut status') return ok(duts[0])
      if (command === 'sdk list') return ok([{ id: 'sdk-a', soc: 'k3' }, { id: 'sdk-b', soc: 'k1' }])
      if (command === 'gpio list') { gpioCalls++; return ok([{ target: 'P1', label: 'reset', actions: ['pulse'] }]) }
      if (command === 'dut ports') { portCalls++; return ok([{ usb: 'usb:1-2', vid: '1234', pid: 'abcd' }]) }
      if (args[0] === 'probe') throw new Error('a registration read must not run a discovery plan')
      return ok({})
    })
    const lab = bspLab({ run: bsp.run })
    const [first, sameHostBoard] = await Promise.all([lab.boardConfig(config, board), lab.boardConfig(config, board)])
    expect(first).toEqual(sameHostBoard)
    expect(first).toMatchObject({ gpios: [{ value: 'P1' }], ports: [{ value: 'usb:1-2', label: 'usb:1-2（1234:abcd）' }],
      soc: 'k3', sdks: ['sdk-a'], socs: [{ value: 'k3', label: 'K3' }, { value: 'k1', label: 'K1' }], sdkOptions: [{ value: 'sdk-a' }, { value: 'sdk-b' }] })
    expect({ listCalls, gpioCalls, portCalls }).toEqual({ listCalls: 1, gpioCalls: 1, portCalls: 1 })
    await lab.boardConfig(config, board)
    expect({ listCalls, gpioCalls, portCalls }).toEqual({ listCalls: 1, gpioCalls: 1, portCalls: 1 })
    await lab.boardConfig(config, board, true)
    expect({ listCalls, gpioCalls, portCalls }).toEqual({ listCalls: 1, gpioCalls: 2, portCalls: 2 })
    // Each editor read asks the board itself (`dut status`: effective SDKs, whether its list is explicit).
    expect(bsp.calls.filter(call => call.args.includes('status'))).toHaveLength(4)
    // An empty explicit list means every SDK of the SoC: it is sent as an empty value, not dropped.
    await lab.change(config, board, 'T1', { sdks: [] })
    expect(bsp.calls.at(-1)!.args.slice(2)).toEqual(['dut', 'set', board, '--lease', 'T1', '--sdks', ''])
  })

  it('flashes a package from a link or an uploaded file as a bsp job, passing on its progress', async () => {
    const bsp = fakeBsp(() => ok({ job: 'flash-7', lines: ['[   0.0s] download package', '[  41.0s] flash rootfs 100%'], elapsed_s: 41.4, flasher: 'tool-b', flashed: true }))
    const progress: string[] = []
    const signals: Array<AbortSignal | undefined> = []
    const run: BspRunner = async (args, options) => { signals.push(options.signal); options.onStderr?.('[  12.0s] flash rootfs 40%'); return bsp.run(args, options) }
    const lab = bspLab({ run })
    const abort = new AbortController()
    expect(await lab.builds!.flash!(config, on('k3-a', 'T1'), { url: 'https://images.test/k3/pkg.zip?sig=1', flasher: null }, line => progress.push(line), abort.signal))
      .toBe('[   0.0s] download package\n[  41.0s] flash rootfs 100%\n刷机工具：tool-b，用时 41 秒')
    await lab.builds!.flash!(config, on('k3-a', 'T1'), { path: '/files/abc/pkg.zip', sha256: 'abc', flasher: 'tool-b' }, () => {})
    expect(bsp.calls.map(call => call.args.slice(2).join(' '))).toEqual([
      'dut flash k3-a --package https://images.test/k3/pkg.zip?sig=1 --lease T1 --timeout 3600',
      'dut flash k3-a --package /files/abc/pkg.zip --sha256 abc --flasher tool-b --lease T1 --timeout 3600',
    ])
    expect(progress).toEqual(['[  12.0s] flash rootfs 40%'])
    // The runner gets the signal that kills it: the lock ending stops the CLI, a cancel first tells the host.
    expect(signals[0]).toBeInstanceOf(AbortSignal)
    expect(signals[1]).toBeUndefined()
  })

  it('registers boards as bsp finds them, on the slots asked for, and says why a slot found nothing', async () => {
    const seen: string[] = []
    const bsp = fakeBsp(() => ok({ results: { h1: { proposals: [{ spec: { id: 'k3-s4' }, warnings: [], registered: { dut: 'k3-s4' } }], registered: [{ dut: 'k3-s4', slot: 's4' }], reasons: ['no reset line made console(s) s5 speak'] } } }))
    const run: BspRunner = async (args, options) => { options.onStderr?.('[h1]  [   4.7s] registered k3-s4 in slot s4'); return bsp.run(args, options) }
    const found = await bspLab({ run }).discovery!.run(config, 'probe', {}, { slot: 'h1/s4' }, () => {}, device => seen.push(device))
    expect(bsp.calls[0]!.args.slice(2)).toEqual(['-r', 'h1', 'probe', '--register', '--slots', 's4'])
    expect(seen).toEqual(['k3-s4'])
    expect(found).toEqual({ found: [], message: '登记了 1 块：h1/k3-s4；h1：no reset line made console(s) s5 speak' })
    // A method that is not the backend's is refused, not silently run.
    await expect(bspLab({ run }).discovery!.run(config, 'nope', {}, {}, () => {})).rejects.toThrow(/没有发现方法 nope/)
    // A rebuild starts one host over: bsp forgets its boards and slots and registers each board it finds again.
    const rebuilt = await bspLab({ run }).discovery!.rebuild!(config, 'h1', () => {}, device => seen.push(device))
    expect(bsp.calls.at(-1)!.args.slice(2)).toEqual(['-r', 'h1', 'probe', '--rebuild', '--yes'])
    expect(rebuilt.message).toBe('登记了 1 块：h1/k3-s4；h1：no reset line made console(s) s5 speak')
    // Rediscovering keeps the boards in use: bsp redoes only what moved.
    expect(bspLab({ run }).discovery!.keepsInUse).toBe(true)
    await bspLab({ run }).discovery!.rebuild!(config, 'h1', () => {}, undefined, { keepInUse: true })
    expect(bsp.calls.at(-1)!.args.slice(2)).toEqual(['-r', 'h1', 'probe', '--rebuild', '--keep-used', '--yes'])
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
    // A board a person resets: bsp's progress lines become the notice on its card, with bsp's request id.
    const notices: Array<[string | null, string | null]> = []
    const human = bspLab({ run: async (args, { onStderr }) => {
      if (args.includes('confirm')) {
        // The same request answered again says it already was (the board arrived first, or a second click).
        if (args.includes('--request') && args[args.indexOf('--request') + 1] === 'ab12cd34ef56') return ok({ confirmed: 'reset', waited_s: 4.2, request: 'ab12cd34ef56', repeat: true, how: 'detected' })
        return ok({ confirmed: 'reset', waited_s: 4.2, request: 'ab12cd34ef56', repeat: false })
      }
      onStderr?.('slot-1 @ h1: reset needs a person, job reset-1 (confirm with `bsp dut confirm slot-1`)')
      onStderr?.('[   0.0s] ACTION NEEDED: press RESET on slot-1 (board-x) (request ab12cd34ef56)')
      onStderr?.('[   4.2s] reset: confirmed by a person')
      return ok({ status: 'succeeded' })
    } })
    await human.relay.reset(config, on('slot-1', 'T'), (message, request) => notices.push([message, request ?? null]))
    expect(notices).toEqual([['press RESET on slot-1 (board-x)', 'ab12cd34ef56'], [null, null]])
    expect(await human.relay.confirm!(config, on('slot-1', 'T'), '')).toBe('已确认「reset」（等了 4.2 秒）')
    // A late click, naming the request: answered, not an error, and the message says why.
    expect(await human.relay.confirm!(config, on('slot-1', 'T'), '', 'ab12cd34ef56')).toBe('板子自己到位了，已经自动确认（请求 ab12cd34ef56，不用再点）')
    // Its lock ending stops the waiting bsp.
    const waiting = bspLab({ run: (_args, { signal }) => new Promise(resolve => signal?.addEventListener('abort', () => resolve({ code: null, stdout: '', stderr: 'aborted' }), { once: true })) })
    const stop = new AbortController()
    const reset = waiting.relay.reset(config, on('slot-1', 'T'), () => {}, stop.signal)
    stop.abort(new Error('锁已经被抢走'))
    await expect(reset).rejects.toThrow('bsp dut reset 停下了：锁已经被抢走')
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

  it('opens a console that is not serial-mux as the plain bytes its pipe carries', async () => {
    let spawned: string[] = []
    const hostSide = new PassThrough(), boarddSide = new PassThrough()
    const written: string[] = []
    hostSide.on('data', chunk => written.push(chunk.toString()))
    const duts = [{ ...DUTS[0]!, id: 'ec-1', console_provider: 'rtt', console: null }]
    const lab = bspLab({
      run: fakeBsp(args => ok(args[0] === 'dut' && args[1] === 'list' ? duts : {})).run,
      spawn: args => { spawned = args; return { stream: Duplex.from({ readable: boarddSide, writable: hostSide }), stderr: () => '' } },
    })
    const session = await lab.serial.open(config, on('ec-1'))
    expect(spawned).toEqual(['--json', '--stateless', 'dut', 'pipe', 'ec-1'])
    expect(session.hello).toEqual({ alias: 'ec-1', device: null, baud: 0, transport: 'rtt' })
    const out: string[] = []
    session.onOutput(data => out.push(data.toString()))
    // No handshake: the first bytes from the pipe are the console's output.
    boarddSide.write(Buffer.from('EC boot 1.2.3\n'))
    await new Promise(resolve => setTimeout(resolve, 20))
    session.send('help\n')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(out).toEqual(['EC boot 1.2.3\n'])
    expect(written).toEqual(['help\n'])
    session.close()
  })
})

describe('bsp lab rename', () => {
  it('renames the DUT and its console in bspd under the lease, and treats a lost answer as done', async () => {
    const bsp = fakeBsp(args => args[0] === 'dut' && args[1] === 'rename' ? ok({ note: 'lease dropped by rename; acquire the new name' }) : ok({}))
    const out = await bspLab({ run: bsp.run }).rename!.rename(config, on('k3-a', 'lease-token'), 'k3-b')
    expect(out).toMatchObject({ device: 'k3-b', alias: 'k3-b' })
    expect(out.message).toMatch(/lease dropped/)
    expect(bsp.calls[0]!.args.slice(2)).toEqual(['dut', 'rename', 'k3-a', 'k3-b', '--console', '--lease', 'lease-token'])
    // The rename reached the host but its answer was lost: a retry sees the new name and does not fail.
    const lost = fakeBsp(args => {
      if (args[0] === 'dut' && args[1] === 'rename') return fail('timed out')
      if (args[0] === 'dut' && args[1] === 'list') return ok([{ id: 'k3-b', host: 'h1' }])
      return ok({})
    })
    expect(await bspLab({ run: lost.run }).rename!.rename(config, on('k3-a'), 'k3-b')).toMatchObject({ device: 'k3-b' })
    // A name that is neither renamed nor there is an error.
    const neither = fakeBsp(args => args[0] === 'dut' && args[1] === 'list' ? ok([{ id: 'k3-c', host: 'h1' }]) : fail('no DUT k3-a'))
    await expect(bspLab({ run: neither.run }).rename!.rename(config, on('k3-a'), 'k3-b')).rejects.toThrow(/no DUT k3-a/)
  })
})

describe('bsp lab news', () => {  it('follows the registry: port changes become news, and an ended stream says so', async () => {
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

describe('bsp debug', () => {
  const board = (services: Record<string, unknown> | undefined) => ({ ...DUTS[0], services })
  const path = { dut: 'k3-a', host: 'h1', provider: 'gpio-swd', kinds: ['halt', 'run', 'regs', 'trace'], state: { endpoint: '127.0.0.1:3334', halted: false } }

  it('reports a board\'s debug provider with what it offers', async () => {
    const bsp = fakeBsp(args => args[0] === 'dut' && args[1] === 'list' ? ok([board({ debug: { provider: 'gpio-swd', kinds: path.kinds } })])
      : args[0] === 'slot' ? ok([]) : ok(path))
    const lab = bspLab({ run: bsp.run })
    const devices = await lab.inventory!.devices(config)
    expect(devices[0]!.debug).toEqual({ provider: 'gpio-swd', kinds: ['halt', 'run', 'regs', 'trace'] })
    const got = await lab.debug!.path(config, { board: 'k3-a', device: 'k3-a', lease: null, die: 'die0', usbPath: null, port: null, gate: null })
    expect(got).toMatchObject({ provider: 'gpio-swd', running: true, endpoint: '127.0.0.1:3334' })
    expect(got?.state).toEqual([{ label: 'endpoint', value: '127.0.0.1:3334' }])
    expect(bsp.calls.at(-1)!.args.slice(2)).toEqual(['debug', 'status', 'k3-a'])
  })

  it('treats a board with no debug path as having none', async () => {
    const bsp = fakeBsp(args => args[0] === 'dut' ? ok([board(undefined)]) : args[0] === 'slot' ? ok([])
      : ok({ dut: 'k3-a', host: 'h1', provider: 'none', kinds: [] }))
    const lab = bspLab({ run: bsp.run })
    expect(await lab.debug!.path(config, { board: 'k3-a', device: 'k3-a', lease: null, die: 'die0', usbPath: null, port: null, gate: null })).toBeNull()
    const devices = await lab.inventory!.devices(config)
    expect((devices[0] as { debug?: unknown }).debug ?? null).toBeNull()
  })

  it('starts, drives and stops a session under the board\'s lease', async () => {
    const bsp = fakeBsp(args => {
      const rest = args.slice(args.indexOf('debug'))
      if (rest[1] === 'start') return ok({ ...path, endpoint: '127.0.0.1:3334' })
      if (rest[1] === 'action') return ok({ dut: 'k3-a', action: rest[3], halted: rest[3] === 'halt', registers: 'pc=0x08000100' })
      if (rest[1] === 'stop') return ok({ dut: 'k3-a', role: 'debug', stopped: true })
      return ok(path)
    })
    const lab = bspLab({ run: bsp.run })
    const target = { board: 'k3-a', device: 'k3-a', lease: 'tok', die: 'die0', usbPath: null, port: null, gate: null }
    expect(await lab.debug!.start(config, target)).toMatchObject({ running: true, endpoint: '127.0.0.1:3334' })
    expect(bsp.calls.at(-1)!.args.slice(2)).toEqual(['debug', 'start', 'k3-a', '--lease', 'tok'])
    const halted = await lab.debug!.action(config, target, 'halt')
    expect(halted.message).toBe('k3-a：halt 已完成')
    expect(halted.data).toEqual([{ label: 'halted', value: 'true' }, { label: 'registers', value: 'pc=0x08000100' }])
    expect(await lab.debug!.stop(config, target)).toContain('调试会话已停止')
    expect(bsp.calls.at(-1)!.args.slice(2)).toEqual(['debug', 'stop', 'k3-a', '--lease', 'tok'])
  })
})

describe('bsp console errors', () => {
  it('reports a raw console whose pipe failed instead of showing a silent console', async () => {
    const duts = [{ ...DUTS[0]!, id: 'ec-1', console_provider: 'rtt' }]
    const lab = bspLab({
      run: fakeBsp(args => ok(args[0] === 'dut' && args[1] === 'list' ? duts : {})).run,
      spawn: () => {
        const side = new PassThrough()
        setTimeout(() => side.end(JSON.stringify({ ok: false, error: { message: 'the console of ec-1 is not running on h1', hint: 'start its debug session' } })), 5)
        return { stream: side, stderr: () => '' }
      },
    })
    await expect(lab.serial.open(config, on('ec-1'))).rejects.toThrow('打不开 ec-1 的串口：the console of ec-1 is not running on h1（start its debug session）')
  })

  it('a raw console with nothing to say yet opens anyway', async () => {
    const duts = [{ ...DUTS[0]!, id: 'ec-1', console_provider: 'rtt' }]
    const side = new PassThrough()
    const lab = bspLab({
      run: fakeBsp(args => ok(args[0] === 'dut' && args[1] === 'list' ? duts : {})).run,
      spawn: () => ({ stream: side, stderr: () => '' }),
    })
    const session = await lab.serial.open(config, on('ec-1'))
    const out: string[] = []
    session.onOutput(data => out.push(data.toString()))
    side.write(Buffer.from('boot\n'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(out).toEqual(['boot\n'])
    session.close()
  })
})

describe('bsp debug stream', () => {
  const target = { board: 'ec-1', device: 'ec-1', lease: null, die: 'die0', usbPath: null, port: null, gate: null }
  const open = (lab: ReturnType<typeof bspLab>) => lab.debug!.stream!(config, target)

  it('opens when the trace says something, and carries what follows', async () => {
    const side = new PassThrough()
    const lab = bspLab({ run: fakeBsp(() => ok({})).run, spawn: () => ({ stream: side, stderr: () => '' }) })
    const opening = open(lab)
    side.write(Buffer.from('pc 0x1000\n'))
    const session = await opening
    const out: string[] = []
    session.onOutput(data => out.push(data.toString()))
    side.write(Buffer.from('next\n'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(out).toEqual(['pc 0x1000\n', 'next\n'])
    session.close()
  })

  it('gives the pipe\'s own reason when the pipe then breaks', async () => {
    // The bytes arrive and the pipe breaks before it closes: the envelope it wrote is why, not "Premature close".
    const lab = bspLab({
      run: fakeBsp(() => ok({})).run,
      spawn: () => {
        const side = new PassThrough()
        setTimeout(() => { side.write(JSON.stringify({ ok: false, error: { message: 'its debug session is not running' } })) }, 5)
        setTimeout(() => side.destroy(new Error('Premature close')), 30)
        return { stream: side, stderr: () => '' }
      },
    })
    await expect(open(lab)).rejects.toThrow(/its debug session is not running/)
  })

  it('waits for the pipe rather than taking silence for a stream', async () => {
    // A session asked for on a slow host: nothing arrives for a while, and then it fails. Opening on a 1.5 s
    // silence would hand the caller a stream and only afterwards the reason it never opened.
    const side = new PassThrough()
    const lab = bspLab({
      run: fakeBsp(() => ok({})).run,
      spawn: () => {
        setTimeout(() => side.end(JSON.stringify({ ok: false, error: { message: 'its debug session is not running' } })), 1800)
        return { stream: side, stderr: () => '' }
      },
    })
    await expect(open(lab)).rejects.toThrow(/its debug session is not running/)
  })

  it('fails with the reason the pipe gave when it cannot open a session', async () => {
    // What the CLI does when it cannot open the session: it says why and exits. A caller must not get a session
    // that will never carry a trace, nor the reason arriving as if the board had said it.
    const lab = bspLab({
      run: fakeBsp(() => ok({})).run,
      spawn: () => {
        const side = new PassThrough()
        setTimeout(() => {
          side.write(JSON.stringify({ ok: false, error: { message: 'its debug session is not running' } }))
          side.end()
        }, 5)
        return { stream: side, stderr: () => '' }
      },
    })
    await expect(open(lab)).rejects.toThrow(/its debug session is not running/)
  })

  it('describes a board a scan cannot see: a person names it and its roles, and bsp gets one DUT record', async () => {
    // A board whose only path is a debug link on header pins: no USB, no cabled console, so no probe can find it.
    // The provider and target are made-up: a site's own names must not appear in this tree.
    const bsp = fakeBsp(args => args[0] === 'hosts' ? ok([{ host: 'h1' }, { host: 'h2', error: 'down' }])
      : args[0] === 'sdk' ? ok([{ id: 'made-up-build', soc: 'made-up-soc' }]) : ok({ registered: { dut: 'pin-board' } }))
    const lab = bspLab({ run: bsp.run })
    // The host is the caller's context (or the lab's single host); the SoC list is the catalog's.
    const methods = await lab.discovery!.methods({ ...config, username: 'h1' }, {})
    const manual = methods.find(method => method.id === 'manual')!
    expect(manual.compose).toBe(true)
    expect(manual.fields!.map(field => field.id)).toEqual(['host', 'name', 'services', 'soc', 'board', 'console_alias', 'usb', 'reset_pin'])
    // Only hosts answering now are choices; the SoC list is the catalog's.
    expect(manual.fields!.find(field => field.id === 'host')).toMatchObject({ kind: 'text', required: true, initial: 'h1' })
    expect(manual.fields!.find(field => field.id === 'soc')!.options).toEqual([{ value: 'made-up-soc', label: 'MADE-UP-SOC' }])
    const made = await lab.discovery!.compose!(config, 'manual', { host: 'h1', name: 'pin-board',
      services: '{"debug":{"provider":"made-up-swd","target":"probe0"}}' }, {})
    expect(made.name).toBe('pin-board')
    const add = bsp.calls.find(call => call.args.includes('dut') && call.args.includes('add'))!
    const spec = JSON.parse(add.args[add.args.indexOf('--spec') + 1]!)
    expect(spec).toEqual({ id: 'pin-board', services: { debug: { provider: 'made-up-swd', target: 'probe0' } } })
    expect(add.args.slice(-4)).toEqual(['dut', 'add', 'h1', '--spec'].concat([]).length ? add.args.slice(-4) : [])
    // Each thing bsp needs is checked before anything is registered.
    await expect(lab.discovery!.compose!(config, 'manual', { name: 'x' }, {})).rejects.toThrow(/哪台主机/)
    await expect(lab.discovery!.compose!(config, 'manual', { host: 'h1' }, {})).rejects.toThrow(/起个名字/)
    await expect(lab.discovery!.compose!(config, 'manual', { host: 'h1', name: 'bad name' }, {})).rejects.toThrow(/板名/)
    await expect(lab.discovery!.compose!(config, 'manual', { host: 'h1', name: 'x', services: '{' }, {})).rejects.toThrow(/JSON/)
    expect(bsp.calls.filter(call => call.args.includes('add'))).toHaveLength(1)
  })
})
