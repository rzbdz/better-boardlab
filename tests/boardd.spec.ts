import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, request } from 'node:http'
import { connect as netConnect, createServer, type Server, type Socket as NetSocket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BoardsClient } from '../src/shared/client.ts'
import { parseArgs } from '../src/cli/main.ts'
import { openDatabase } from '../src/server/db.ts'
import { groupEntities, homeAssistant, type HaClient } from '../src/server/ha.ts'
import { readFirmware } from '../src/server/firmware.ts'
import { adapterPortName, diffUsb, listSerialAdapters, type SerialAdapter, type UsbDevice } from '../src/server/hardware.ts'
import { serve } from '../src/server/http.ts'
import { encodeMessage, FrameDecoder, SerialMux, startAlias, type MuxSession } from '../src/server/serial-mux.ts'
import { BoardService, type ServiceOptions } from '../src/server/service.ts'
import { spacemitBmc, usbPathOf } from '../src/server/bmc.ts'
import { fireflyAbmc } from '../src/server/firefly.ts'
import { deviceFilter, jumpStage, type LabConfig, type LabDevice, type LabDriver, type Shell } from '../src/server/labs.ts'

/** A bench of boards behind fake HA, serial-mux, USB and fastboot. */
class Bench {
  calls: string[] = []
  usbPresent: UsbDevice[] = [{ path: '1-1', usbId: '1d6b:0002', serial: null, product: 'hub' }]
  listeners = new Map<string, Set<(data: Buffer) => void>>()
  sent: Array<{ alias: string, data: string }> = []
  staged = new Map<string, string>()
  offline = new Set<string>()
  devnum = 10
  /** serial-mux daemons by port; one daemon from before any scan already exists. */
  names = new Map<string, string>([['/dev/serial/by-id/com260-uart', 'com260']])
  stopped: string[] = []
  started: Array<[string, string]> = []
  /** serial-mux input gates by alias: the token input needs, and the note refused clients see. */
  gates = new Map<string, { token: string, note: string }>()
  /** Daemons from a serial-mux that has no input gate. */
  oldMux = new Set<string>()
  /** Slot scripts run, with the environment boardd gave them. */
  scriptRuns: Array<{ script: string, env: Record<string, string> }> = []
  constructor(readonly wiring: Array<{ slot: number, serial: string[], usb: Array<{ path: string, usbId: string, product?: string, serial?: string }> }>) {}

  adapters(): SerialAdapter[] {
    return this.wiring.flatMap(slot => slot.serial).sort().map(link => ({ link, device: `/dev/${link}`, usbPath: null, usbInterface: null }))
  }
  alias(link: string) { return this.names.get(link) ?? `unwatched-${link}` }
  emit(link: string, text: string) { this.listeners.get(this.alias(link))?.forEach(fn => fn(Buffer.from(text))) }

  /** What pressing a slot's reset or fastboot does to the boards wired to it. */
  press(slotNumber: number, kind: 'reset' | 'fastboot') {
    const slot = this.wiring.find(item => item.slot === slotNumber)
    if (!slot) return
    const paths = new Set(slot.usb.map(device => device.path))
    this.usbPresent = this.usbPresent.filter(device => !paths.has(device.path))
    if (kind === 'fastboot') {
      this.usbPresent.push(...slot.usb.map(device => ({ path: device.path, usbId: device.usbId, serial: '????????????', product: null, devnum: ++this.devnum })))
      slot.serial.forEach(link => this.emit(link, '\0\0sys: 0x10001200\r\nROM: usb download handler\r\n'))
    } else slot.serial.forEach(link => this.emit(link, '\x1b[0mU-Boot SPL 2022.10\r\nbooting\r\n'))
  }

  ha: HaClient = {
    verify: async config => { if (config.token !== 'secret-token-value') throw new Error('Home Assistant 拒绝了令牌（401）'); return 'API running；Lab 2026.10' },
    call: async (_config, entity) => {
      this.calls.push(entity)
      const [, slotText, kind] = entity.match(/board_(\d+)_(reset|fastboot_mode)$/)!
      this.press(Number(slotText), kind === 'reset' ? 'reset' : 'fastboot')
    },
    discover: async () => ({ devices: [], slots: [], unassigned: [] }),
  }

  options(db = openDatabase(join(mkdtempSync(join(tmpdir(), 'boards-')), 'b.sqlite'))): ServiceOptions {
    return {
      db, ha: this.ha,
      mux: {
        open: async (alias, token) => {
          const listeners = new Set<(data: Buffer) => void>()
          this.listeners.set(alias, this.listeners.get(alias) ?? new Set())
          const all = this.listeners.get(alias)!
          const session: MuxSession = {
            hello: { alias, device: null, baud: 115200, transport: 'serial' }, history: ['[t] old line'],
            send: data => {
              // A gated daemon drops input that does not carry its token.
              const gate = this.gates.get(alias)
              if (gate && gate.token !== token) return
              this.sent.push({ alias, data: String(data) })
              setTimeout(() => all.forEach(fn => fn(Buffer.from(`${data}root@board:~# `))), 5)
            },
            onOutput: fn => { listeners.add(fn); all.add(fn); return () => all.delete(fn) },
            onClose: () => {},
            close: () => listeners.forEach(fn => all.delete(fn)),
          }
          return session
        },
        online: alias => !this.offline.has(alias),
        stopAll: async () => { const names = [...this.names.values()]; this.stopped.push(...names); this.names.clear(); this.gates.clear(); return names },
        start: async (adapter, alias) => {
          // A fresh daemon starts ungated.
          this.gates.delete(alias)
          for (const [link, name] of this.names) if (name === alias) this.names.delete(link)
          this.names.set(adapter.link, alias)
          this.started.push([adapter.link, alias])
          return alias
        },
        gate: async (alias, gate) => {
          if (this.oldMux.has(alias)) {
            if (gate) throw new Error(`serial-mux ${alias} 版本太旧，不支持输入闸门；升级 serial-mux 后重启这个守护进程`)
            return
          }
          if (gate) this.gates.set(alias, gate); else this.gates.delete(alias)
        },
        stop: async alias => {
          for (const [link, name] of this.names) if (name === alias) { this.names.delete(link); this.stopped.push(alias) }
        },
      },
      hardware: {
        usb: () => [...this.usbPresent],
        serialAdapters: () => this.adapters(),
        // A script acts like its slot's button; `exit N` in it fails the run with that code.
        scripts: {
          run: async (script, env) => {
            this.scriptRuns.push({ script, env })
            const code = Number(script.match(/exit (\d+)/)?.[1] ?? 0)
            if (!code) this.press(Number(env.BOARDS_SLOT), env.BOARDS_ACTION === 'fastboot' ? 'fastboot' : 'reset')
            return { code, output: script.match(/echo (.*)/)?.[1] ?? '', timedOut: false }
          },
        },
        fastboot: {
          run: async args => {
            const path = args[1]!.replace('usb:', '')
            if (args[2] === 'stage') { this.staged.set(path, args[3]!); return 'Sending OKAY' }
            const device = this.wiring.flatMap(slot => slot.usb).find(item => item.path === path)
            if (device?.product && device.serial) this.emit(device.serial, `minor-board-info: product_name=${device.product} i2c=2 addr=0x50 crc=ok\r\nminor-board-info: stopped\r\n`)
            return 'Resuming boot OKAY'
          },
        },
      },
      scanTiming: { windowMs: 20, quietMs: 5, settleMaxMs: 60, minorMs: 20, rounds: 2 },
      firmwareDir: join(dir, 'firmware'),
    }
  }
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boards-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Ship a firmware file the way firmware/ does: the file plus its firmware.json entry. */
function shipFirmware(purpose: string, content: string, soc = 'k3') {
  const firmwareDir = join(dir, 'firmware')
  mkdirSync(firmwareDir, { recursive: true })
  const manifest = join(firmwareDir, 'firmware.json')
  const entries = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : []
  writeFileSync(join(firmwareDir, `${purpose}.bin`), content)
  entries.push({ soc, purpose, file: `${purpose}.bin`, sha256: createHash('sha256').update(content).digest('hex') })
  writeFileSync(manifest, JSON.stringify(entries))
  return join(firmwareDir, `${purpose}.bin`)
}

/** HA access is entered on the web page and slots come from discovery; tests seed both directly. */
function service(bench = new Bench([]), now?: () => number, sleep?: (ms: number) => Promise<void>) {
  const db = openDatabase(join(dir, 'boards.sqlite'))
  const svc = new BoardService({ ...bench.options(db), now, sleep })
  db.prepare(`INSERT INTO settings(key, value) VALUES('ha.url', 'http://ha.test:8123'), ('ha.token', 'secret-token-value')`).run()
  svc.confirmSlots('user:troy', [0, 1].map(slot => ({ slot, resetEntity: `switch.ctrl_001_board_${slot}_reset`, fastbootEntity: `button.ctrl_001_board_${slot}_fastboot_mode` })))
  svc.addBoard('user:troy', { name: 'com260', slot: 1, product: 'k3_com260', chips: [{ serialPath: '/dev/ttyUSB1', alias: 'com260', downloadUsbPath: '3-2.3' }] })
  return svc
}

describe('inventory', () => {
  it('starts empty: no boards until a scan or a person registers one', () => {
    const svc = new BoardService(new Bench([]).options(openDatabase(join(dir, 'empty.sqlite'))))
    expect(svc.state('user:troy')).toMatchObject({ boards: [], slots: [], ha: { url: null, hasToken: false } })
  })

  it('registers boards by hand and exports TOML', () => {
    const svc = service()
    expect(svc.board('com260')).toMatchObject({ slot: 1, product: 'k3_com260', soc: 'k3', source: 'manual' })
    expect(() => svc.addBoard('user:troy', { name: 'other', slot: 1 })).toThrow(/槽位 1 已有/)
    expect(svc.exportToml()).toContain('[boards.com260.die0]')
    svc.removeBoard('user:troy', 'com260')
    expect(svc.boards()).toEqual([])
  })

  it('only offers consoles on serial ports that have a device bound', async () => {
    const bench = new Bench([])
    bench.offline.add('com260')
    const svc = service(bench)
    expect(svc.board('com260').chips[0]!.online).toBe(false)
    await expect(svc.openConsole('com260')).rejects.toThrow(/没有绑定设备/)
    await svc.lock('com260', 'user:troy', '调试')
    await expect(svc.send('com260', { holder: 'user:troy' }, { text: 'x' })).rejects.toThrow(/没有绑定设备/)
  })
})

describe('leases', () => {
  it('lets only the holder operate and never expires a lock', async () => {
    let now = Date.parse('2026-10-28T10:00:00Z')
    const bench = new Bench([])
    const svc = service(bench, () => now)
    const agent = await svc.lock('com260', 'claude:s1', '看启动日志')
    await expect(svc.lock('com260', 'user:troy', 'x')).rejects.toThrow(/正被 claude:s1 使用/)
    await expect(svc.reset('com260', { holder: 'claude:s1' })).rejects.toThrow(/正被 claude:s1 使用/)
    await expect(svc.reset('com260', { holder: 'user:troy' })).rejects.toThrow(/正被/)
    await svc.reset('com260', { holder: 'claude:s1', token: agent.token })
    expect(bench.calls).toEqual(['switch.ctrl_001_board_1_reset'])
    now += 30 * 24 * 3_600_000
    expect(svc.board('com260').lease!.holder).toBe('claude:s1')
    // Asking again while holding re-issues the token; the old one stops working.
    const again = await svc.lock('com260', 'claude:s1', '看启动日志')
    expect(again.lease!.id).toBe(agent.lease!.id)
    expect(() => svc.authorize('com260', { holder: 'claude:s1', token: agent.token })).toThrow(/正被/)
    svc.authorize('com260', { holder: 'claude:s1', token: again.token })
  })

  it('queues people first come, first served and hands the lock over on release', async () => {
    const svc = service()
    const events: unknown[] = []
    svc.events.on('event', event => events.push(event))
    await svc.lock('com260', 'user:troy', '调试')
    expect(await svc.lock('com260', 'user:alice', '回归测试', { queue: 'join' })).toMatchObject({ lease: null, queued: { position: 1 } })
    expect(await svc.lock('com260', 'user:bob', '看日志', { queue: 'join' })).toMatchObject({ queued: { position: 2 } })
    // Joining twice keeps the original place.
    expect(await svc.lock('com260', 'user:alice', '回归测试', { queue: 'join' })).toMatchObject({ queued: { position: 1 } })
    await expect(svc.lock('com260', 'user:carol', '插队')).rejects.toThrow(/2 人排队/)
    expect(svc.board('com260').waiters.map(waiter => waiter.holder)).toEqual(['user:alice', 'user:bob'])

    svc.unlock('com260', { holder: 'user:troy' })
    expect(svc.board('com260').lease).toMatchObject({ holder: 'user:alice', purpose: '回归测试' })
    expect(events).toContainEqual({ type: 'lease-granted', board: 'com260', holder: 'user:alice' })
    // A free board with a queue still goes to the queue, not to whoever asks.
    svc.unlock('com260', { holder: 'user:alice' })
    expect(svc.board('com260').lease!.holder).toBe('user:bob')
    expect(svc.board('com260').waiters).toEqual([])
  })

  it('keeps the queue across a restart and lets people leave it', async () => {
    const bench = new Bench([])
    const svc = service(bench)
    await svc.lock('com260', 'user:troy', '调试')
    await svc.lock('com260', 'user:alice', 'a', { queue: 'join' })
    await svc.lock('com260', 'user:bob', 'b', { queue: 'join' })
    const restarted = new BoardService(bench.options(openDatabase(join(dir, 'boards.sqlite'))))
    expect(restarted.board('com260').waiters.map(waiter => waiter.holder)).toEqual(['user:alice', 'user:bob'])
    restarted.unqueue('com260', 'user:alice')
    expect(() => restarted.unqueue('com260', 'user:alice')).toThrow(/没有在/)
    restarted.unlock('com260', { holder: 'user:troy' })
    expect(restarted.board('com260').lease!.holder).toBe('user:bob')
  })

  it('waits in the queue and leaves it when the waiting connection goes away', async () => {
    const svc = service()
    await svc.lock('com260', 'user:troy', '调试')
    const granted = svc.lock('com260', 'claude:a', '排队', { queue: 'wait' })
    const abort = new AbortController()
    const leaving = svc.lock('com260', 'claude:b', '排队', { queue: 'wait', signal: abort.signal })
    await new Promise(resolve => setTimeout(resolve, 5))
    abort.abort()
    await expect(leaving).rejects.toThrow(/停止排队/)
    expect(svc.board('com260').waiters.map(waiter => waiter.holder)).toEqual(['claude:a'])
    svc.unlock('com260', { holder: 'user:troy' })
    const result = await granted
    expect(result.lease!.holder).toBe('claude:a')
    svc.authorize('com260', { holder: 'claude:a', token: result.token })
  })

  it('allows only people to steal, with a reason, and tells the previous holder', async () => {
    const svc = service()
    const events: unknown[] = []
    svc.events.on('event', event => events.push(event))
    const agent = await svc.lock('com260', 'claude:s1', '长任务')
    expect(() => svc.steal('com260', 'claude:s2', '急用')).toThrow(/只有人/)
    expect(() => svc.steal('com260', 'user:troy', ' ')).toThrow(/原因/)
    svc.steal('com260', 'user:troy', '板子卡死，需要手动处理')
    expect(svc.board('com260').lease!.holder).toBe('user:troy')
    expect(events).toContainEqual({ type: 'lease-stolen', board: 'com260', from: 'claude:s1', by: 'user:troy', reason: '板子卡死，需要手动处理' })
    expect(() => svc.authorize('com260', { holder: 'claude:s1', token: agent.token })).toThrow(/正被 user:troy/)
  })
})

describe('Home Assistant buttons', () => {
  it('returns from fastboot only after the reset that comes late', async () => {
    const bench = new Bench([])
    const sleeps: Array<{ ms: number, calls: number, done: () => void }> = []
    const svc = service(bench, undefined, ms => new Promise(resolve => { sleeps.push({ ms, calls: bench.calls.length, done: resolve }) }))
    const lease = await svc.lock('com260', 'claude:s1', '内存启动')
    let returned = false
    const pressed = svc.fastboot('com260', { holder: 'claude:s1', token: lease.token }).then(() => { returned = true })
    while (!sleeps.length) await new Promise(resolve => setTimeout(resolve, 1))
    // The wait comes after the button press, and the board is not in fastboot until it ends.
    expect(sleeps.map(({ ms, calls }) => ({ ms, calls }))).toEqual([{ ms: 6_000, calls: 1 }])
    expect(bench.calls).toEqual(['button.ctrl_001_board_1_fastboot_mode'])
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(returned).toBe(false)
    expect(svc.board('com260').mode).not.toBe('fastboot')
    sleeps[0]!.done()
    await pressed
    expect(svc.board('com260').mode).toBe('fastboot')

    await svc.reset('com260', { holder: 'claude:s1', token: lease.token })
    expect(sleeps).toHaveLength(1)
  })
})

describe('serial gates', () => {
  it('lets only the holder type into a locked board and opens the port again on release', async () => {
    const bench = new Bench([])
    const svc = service(bench)
    const lock = await svc.lock('com260', 'claude:s1', '调内核')
    await svc.syncGates('com260')
    expect(bench.gates.get('com260')).toEqual({ token: lock.gateToken, note: 'claude:s1 正在使用 com260（调内核）' })
    // boardd presents the gate token itself, so the holder's input through boardd passes.
    await svc.send('com260', { holder: 'claude:s1', token: lock.token }, { text: 'uname -a', timeoutMs: 20 })
    expect(bench.sent.map(item => item.data)).toEqual(['uname -a\n'])
    // Asking for the lock again re-issues the lease token but keeps the gate token.
    const again = await svc.lock('com260', 'claude:s1', '调内核')
    expect(again.gateToken).toBe(lock.gateToken)
    svc.unlock('com260', { holder: 'claude:s1', token: again.token })
    await svc.syncGates('com260')
    expect(bench.gates.has('com260')).toBe(false)
  })

  it('moves the gate to whoever gets the lock next', async () => {
    const bench = new Bench([])
    const svc = service(bench)
    const alice = await svc.lock('com260', 'user:alice', '调试')
    await svc.lock('com260', 'user:bob', '排队', { queue: 'join' })
    svc.unlock('com260', { holder: 'user:alice' })
    await svc.syncGates('com260')
    const bob = await svc.lock('com260', 'user:bob', '排队')
    expect(bob.gateToken).not.toBe(alice.gateToken)
    expect(bench.gates.get('com260')!.token).toBe(bob.gateToken)
    const carol = svc.steal('com260', 'user:carol', '紧急修复')
    await svc.syncGates('com260')
    expect(bench.gates.get('com260')).toEqual({ token: carol.gateToken, note: 'user:carol 正在使用 com260（抢锁）' })
  })

  it('reports a serial-mux without the gate instead of leaving input silently open', async () => {
    const bench = new Bench([])
    bench.oldMux.add('com260')
    const svc = service(bench)
    await svc.lock('com260', 'user:troy', '调试')
    await svc.syncGates('com260')
    expect(svc.board('com260').chips[0]!.gateError).toMatch(/版本太旧，不支持输入闸门/)
    expect(svc.history().actions.find(action => action.kind === 'gate')).toMatchObject({ ok: false, board: 'com260', detail: 'com260' })
    // A free port with an old serial-mux is open, which is what releasing asks for.
    svc.unlock('com260', { holder: 'user:troy' })
    await svc.syncGates('com260')
    expect(svc.board('com260').chips[0]!.gateError).toBeNull()
  })

  it('gates ports again after a scan restarted their daemons', async () => {
    const bench = new Bench([
      { slot: 0, serial: ['/dev/serial/by-id/ftdi-A'], usb: [] },
      { slot: 1, serial: ['/dev/serial/by-id/com260-uart'], usb: [{ path: '3-2.3', usbId: '361c:1001', product: 'k3_com260', serial: '/dev/serial/by-id/com260-uart' }] },
    ])
    const svc = service(bench)
    svc.addBoard('user:troy', { name: 'pico', slot: 0, product: 'k3-pico-itx', chips: [{ serialPath: '/dev/serial/by-id/ftdi-A', alias: 'pico' }] })
    // Someone takes the board outside the scan while it runs; the scan still stops every daemon.
    const id = (await svc.startScan('user:troy', { slots: [1], confirmed: true })).id
    const alice = await svc.lock('pico', 'user:alice', '跑测试')
    await svc.syncGates('pico')
    for (let i = 0; i < 200 && svc.scan(id).status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(svc.scan(id).status).toBe('done')
    expect(bench.names.get('/dev/serial/by-id/ftdi-A')).toBe('pico')
    expect(bench.gates.get('pico')!.token).toBe(alice.gateToken)
  })

  it('gives leases taken before the upgrade a gate token', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const file = join(dir, 'v1.sqlite')
    const old = new DatabaseSync(file)
    old.exec(`CREATE TABLE leases (id TEXT PRIMARY KEY, board TEXT NOT NULL, holder TEXT NOT NULL, purpose TEXT NOT NULL,
      token_hash TEXT NOT NULL, started_at TEXT NOT NULL, status TEXT NOT NULL, ended_at TEXT, end_reason TEXT); PRAGMA user_version=1;`)
    old.close()
    const db = openDatabase(file)
    expect(db.prepare('PRAGMA table_info(leases)').all().map(row => row.name)).toContain('gate_token')
    db.prepare(`INSERT INTO leases(id, board, holder, purpose, token_hash, started_at, status) VALUES('l1', 'com260', 'user:troy', '旧锁', 'x', '2026-10-29T00:00:00Z', 'held')`).run()
    const bench = new Bench([])
    const svc = new BoardService(bench.options(db))
    svc.addBoard('user:troy', { name: 'com260', slot: 1, chips: [{ serialPath: '/dev/ttyUSB1', alias: 'com260' }] })
    await svc.syncGates('com260')
    expect(bench.gates.get('com260')!.token).toMatch(/^[\w-]{32}$/)
    expect((await svc.lock('com260', 'user:troy', '旧锁')).gateToken).toBe(bench.gates.get('com260')!.token)
  })
})

describe('script slots', () => {
  it('adds a slot run by scripts, which can only reset without a fastboot script', async () => {
    const bench = new Bench([])
    const svc = service(bench)
    const slot = svc.saveScriptSlot('user:troy', { slot: 5, label: '米家插座', resetScript: 'echo plug off-on' })
    expect(slot).toMatchObject({ slot: 5, kind: 'script', label: '米家插座', canReset: true, canFastboot: false, fastbootScript: null })
    expect(() => svc.saveScriptSlot('user:troy', { slot: 1, resetScript: 'true' })).toThrow(/属于 Home Assistant/)
    expect(() => svc.saveScriptSlot('user:troy', { slot: 6, resetScript: '  ' })).toThrow(/复位脚本不能为空/)

    await svc.lock('slot:5', 'user:troy', '试插座')
    await svc.reset('slot:5', { holder: 'user:troy' })
    expect(bench.scriptRuns).toEqual([{ script: 'echo plug off-on', env: { BOARDS_SLOT: '5', BOARDS_ACTION: 'reset', BOARDS_BOARD: '' } }])
    expect(svc.history().actions[0]).toMatchObject({ kind: 'reset', ok: true, detail: '槽位 5 的复位脚本', message: 'plug off-on' })
    await expect(svc.fastboot('slot:5', { holder: 'user:troy' })).rejects.toThrow(/槽位 5 只能复位/)

    // Adding a fastboot script later lets it switch the board too.
    expect(svc.saveScriptSlot('user:troy', { slot: 5, label: '米家插座', resetScript: 'echo off-on', fastbootScript: 'echo strap' }).canFastboot).toBe(true)
    await svc.fastboot('slot:5', { holder: 'user:troy' })
    expect(bench.scriptRuns.at(-1)!.env.BOARDS_ACTION).toBe('fastboot')
  })

  it('reports a failing script with its exit code', async () => {
    const svc = service(new Bench([]))
    svc.saveScriptSlot('user:troy', { slot: 6, resetScript: 'echo relay offline\nexit 7' })
    await svc.lock('slot:6', 'user:troy', '试')
    await expect(svc.reset('slot:6', { holder: 'user:troy' })).rejects.toThrow(/脚本退出码 7：relay offline/)
    expect(svc.history().actions[0]).toMatchObject({ kind: 'reset', ok: false })
  })

  it('leaves script slots alone when Home Assistant slots change', async () => {
    const bench = new Bench([])
    const svc = service(bench)
    svc.saveScriptSlot('user:troy', { slot: 5, resetScript: 'echo x' })
    // The controller now reports slots 0 and 5; slot 1 keeps its board, slot 5 stays a script slot.
    bench.ha.discover = async () => ({ devices: [], unassigned: [], slots: [0, 5].map(slot => ({ slot, resetEntity: `switch.ctrl_002_board_${slot}_reset`, fastbootEntity: `button.ctrl_002_board_${slot}_fastboot_mode`, device: 'ctrl_002' })) })
    await svc.syncSlots()
    expect(svc.slots().map(slot => [slot.slot, slot.kind, slot.resetEntity])).toEqual([
      [0, 'ha', 'switch.ctrl_002_board_0_reset'], [1, 'ha', 'switch.ctrl_001_board_1_reset'], [5, 'script', null],
    ])
    expect(() => svc.removeScriptSlot('user:troy', 0)).toThrow(/来自 Home Assistant/)
    svc.removeScriptSlot('user:troy', 5)
    expect(svc.slots().map(slot => slot.slot)).toEqual([0, 1])
  })

  it('finds a reset-only slot\'s serial port by its boot log and registers the board under the name given', async () => {
    const bench = new Bench([{ slot: 5, serial: ['/dev/serial/by-id/plug-uart'], usb: [] }])
    const svc = service(bench)
    svc.saveScriptSlot('user:troy', { slot: 5, label: '米家插座', resetScript: 'echo off-on' })
    const id = (await svc.startScan('user:troy', { slots: [5], confirmed: true })).id
    for (let i = 0; i < 200 && svc.scan(id).status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10))
    const scan = svc.scan(id)
    expect(scan.status).toBe('done')
    expect(scan.result).toEqual([{ slot: 5, board: null, flags: ['这个槽位只能复位，没有下载口，读不到型号'], chips: [{ die: 'die0', serialPath: '/dev/serial/by-id/plug-uart', downloadUsbPath: null, usbId: null, product: null, pending: true }] }])
    // Two reset rounds and no extra reset at the end: the board is already booting normally.
    expect(bench.scriptRuns.map(run => run.env.BOARDS_ACTION)).toEqual(['reset', 'reset'])
    expect(bench.calls).toEqual([])

    const [proposal] = svc.state('user:troy').proposals
    expect(proposal).toMatchObject({ kind: 'new-board', slot: 5, summary: '槽位 5 发现新板子（只能复位，读不到型号，填板名后应用）' })
    await expect(svc.resolveProposals('user:troy', [proposal!.id], 'apply')).rejects.toThrow(/槽位 5 的新板子要先填板名/)
    await expect(svc.resolveProposals('user:troy', [proposal!.id], 'apply', { [proposal!.id]: 'bad name' })).rejects.toThrow(/板名不合法/)
    await expect(svc.resolveProposals('user:troy', [proposal!.id], 'apply', { [proposal!.id]: 'com260' })).rejects.toThrow(/已有板子 com260/)
    await svc.resolveProposals('user:troy', [proposal!.id], 'apply', { [proposal!.id]: 'mijia-dev' })
    expect(svc.board('mijia-dev')).toMatchObject({ slot: 5, product: null, source: 'scan' })
    expect(svc.board('mijia-dev').chips[0]).toMatchObject({ serialPath: '/dev/serial/by-id/plug-uart', alias: 'mijia-dev' })
    expect(bench.names.get('/dev/serial/by-id/plug-uart')).toBe('mijia-dev')
  })

  async function scanSlot(svc: BoardService, slot: number) {
    const id = (await svc.startScan('user:troy', { slots: [slot], confirmed: true })).id
    for (let i = 0; i < 200 && svc.scan(id).status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10))
    return svc.scan(id)
  }

  it('names each port after its die once a board gains a second chip, in the same batch as other changes', async () => {
    const bench = new Bench([{ slot: 4, serial: ['/dev/serial/by-path/a'], usb: [] }])
    const svc = service(bench)
    svc.saveScriptSlot('user:troy', { slot: 4, label: '米家插座', resetScript: 'echo off-on' })
    await scanSlot(svc, 4)
    const [found] = svc.state('user:troy').proposals
    await svc.resolveProposals('user:troy', [found!.id], 'apply', { [found!.id]: 'gemini' })
    expect(bench.names.get('/dev/serial/by-path/a')).toBe('gemini')

    // The second chip's port answers too now.
    bench.wiring[0]!.serial.push('/dev/serial/by-path/b')
    await scanSlot(svc, 4)
    const proposals = svc.state('user:troy').proposals
    expect(proposals.map(item => item.summary)).toEqual(['gemini 新增芯片 die1，串口 /dev/serial/by-path/b'])
    await svc.resolveProposals('user:troy', proposals.map(item => item.id), 'apply')
    expect(svc.board('gemini').chips.map(chip => [chip.die, chip.serialPath, chip.alias])).toEqual([
      ['die0', '/dev/serial/by-path/a', 'gemini-die0'], ['die1', '/dev/serial/by-path/b', 'gemini-die1'],
    ])
    expect(bench.names).toEqual(new Map([['/dev/serial/by-path/a', 'gemini-die0'], ['/dev/serial/by-path/b', 'gemini-die1']]))
  })

  it('keeps a reset-only board\'s dies when a scan hears only some of its ports', async () => {
    const bench = new Bench([{ slot: 4, serial: ['/dev/serial/by-path/b'], usb: [] }])
    const svc = service(bench)
    svc.saveScriptSlot('user:troy', { slot: 4, resetScript: 'echo off-on' })
    svc.addBoard('user:troy', { name: 'gemini', slot: 4, chips: [{ die: 'die0', serialPath: '/dev/serial/by-path/a' }, { die: 'die1', serialPath: '/dev/serial/by-path/b' }] })
    const scan = await scanSlot(svc, 4)
    // Only die1's port printed this time: it keeps its die, and die0 is reported, not moved.
    expect(scan.result[0]!.chips.map(chip => [chip.die, chip.serialPath])).toEqual([['die1', '/dev/serial/by-path/b']])
    expect(scan.result[0]!.flags).toContain('gemini.die0 的串口这次没有响应，登记保持不变')
    expect(svc.state('user:troy').proposals).toEqual([])
  })

  it('separates ports that ended up sharing one name when consoles are restored', async () => {
    const bench = new Bench([{ slot: 4, serial: ['/dev/serial/by-path/a', '/dev/serial/by-path/b'], usb: [] }])
    const svc = service(bench)
    svc.saveScriptSlot('user:troy', { slot: 4, resetScript: 'echo off-on' })
    svc.addBoard('user:troy', { name: 'gemini', slot: 4, chips: [{ die: 'die0', serialPath: '/dev/serial/by-path/a', alias: 'gemini' }, { die: 'die1', serialPath: '/dev/serial/by-path/b', alias: 'gemini' }] })
    await svc.restoreConsoles()
    expect(svc.board('gemini').chips.map(chip => chip.alias)).toEqual(['gemini-die0', 'gemini-die1'])
    expect(bench.names.get('/dev/serial/by-path/a')).toBe('gemini-die0')
    expect(bench.names.get('/dev/serial/by-path/b')).toBe('gemini-die1')
    expect([...bench.names.values()]).not.toContain('gemini')
  })

  it('runs scripts with bash or their own interpreter, with the slot in the environment, and stops hung ones', async () => {
    const { scriptRunner } = await import('../src/server/hardware.ts')
    expect(await scriptRunner.run('echo "slot $BOARDS_SLOT $BOARDS_ACTION"; echo oops >&2; exit 3', { BOARDS_SLOT: '5', BOARDS_ACTION: 'reset' }, 5000))
      .toEqual({ code: 3, output: 'slot 5 reset\noops', timedOut: false })
    expect(await scriptRunner.run('#!/bin/sh\necho "from sh"', {}, 5000)).toEqual({ code: 0, output: 'from sh', timedOut: false })
    const hung = await scriptRunner.run('echo started; sleep 30', {}, 300)
    expect(hung).toMatchObject({ timedOut: true, output: 'started' })
  })
})

describe('console and firmware', () => {
  it('sends input under a lease and waits for a pattern', async () => {
    const bench = new Bench([])
    const svc = service(bench)
    await svc.lock('com260', 'user:troy', '调试')
    const result = await svc.send('com260', { holder: 'user:troy' }, { text: 'uname -a', wait: 'root@board' })
    expect(result).toMatchObject({ matched: true })
    expect(bench.sent).toEqual([{ alias: 'com260', data: 'uname -a\n' }])
    expect(await svc.log('com260')).toEqual(['[t] old line'])
    await svc.unlock('com260', { holder: 'user:troy' })
    await expect(svc.send('com260', { holder: 'user:troy' }, { text: 'x' })).rejects.toThrow(/请先拿/)
  })

  it('only stages its own firmware whose content still matches firmware.json', async () => {
    const bench = new Bench([])
    const svc = service(bench)
    const file = shipFirmware('minor-board-info', 'image-v1')
    expect(svc.firmware()).toMatchObject([{ soc: 'k3', purpose: 'minor-board-info', path: file }])
    await svc.lock('com260', 'user:troy', '读型号')
    await svc.stage('com260', { holder: 'user:troy' }, { firmware: 'minor-board-info' })
    expect(bench.staged.get('3-2.3')).toBe(file)
    await expect(svc.stage('com260', { holder: 'user:troy' }, { firmware: 'fsbl' })).rejects.toThrow(/没有自带 k3 的固件 fsbl/)
    writeFileSync(file, 'tampered')
    await expect(svc.stage('com260', { holder: 'user:troy' }, { firmware: 'minor-board-info' })).rejects.toThrow(/sha256 与 firmware.json 不符/)
  })

  it('ships firmware whose files match the sha256 in firmware.json', () => {
    const shipped = readFirmware(join(import.meta.dirname, '../firmware'))
    expect(shipped.map(item => `${item.soc}/${item.purpose}`).sort()).toEqual(['k3/fsbl', 'k3/minor-board-info', 'k3/u-boot-opensbi'])
    for (const item of shipped) expect(createHash('sha256').update(readFileSync(item.path)).digest('hex')).toBe(item.sha256)
  })

  it('boots from RAM by staging each file in order once the download port is back', async () => {
    const bench = new Bench([])
    bench.usbPresent.push({ path: '3-2.3', usbId: '361c:1001', serial: '????????????', product: null })
    const order: string[] = []
    const run = bench.options().hardware.fastboot.run
    const svc = new BoardService({ ...bench.options(openDatabase(join(dir, 'boot.sqlite'))), sleep: async () => {}, bootTiming: { firstMs: 0, laterMs: 0, waitMs: 2, pollMs: 1, fastbootSettleMs: 0 },
      hardware: { ...bench.options().hardware, fastboot: { run: async args => { if (args[2] === 'stage') order.push(args[3]!); return run(args) } } } })
    svc.addBoard('user:troy', { name: 'com260', slot: 1, chips: [{ serialPath: '/dev/ttyUSB1', alias: 'com260', downloadUsbPath: '3-2.3' }] })
    const files = ['FSBL.bin', 'u-boot-opensbi.itb', 'Image.itb'].map(name => { const file = join(dir, name); writeFileSync(file, name); return file })
    const fsbl = shipFirmware('fsbl', 'shipped FSBL')
    await expect(svc.boot('com260', { holder: 'claude:s1' }, { files })).rejects.toThrow(/请先拿/)
    const { token } = await svc.lock('com260', 'claude:s1', '内存启动内核')
    const claude = { holder: 'claude:s1', token }
    await expect(svc.boot('com260', claude, { files: ['FSBL.bin'] })).rejects.toThrow(/绝对路径/)
    const output = await svc.boot('com260', claude, { files })
    expect(order).toEqual(files)
    expect(output).toContain('1. ' + files[0])
    expect(svc.detail('com260').actions.filter(action => action.kind === 'boot').map(action => action.ok)).toEqual([true, true, true])

    // A bare name is boardd's own firmware, checked against firmware.json like any stage.
    order.length = 0
    await svc.boot('com260', claude, { files: ['fsbl', files[2]!] })
    expect(order).toEqual([fsbl, files[2]])
    await expect(svc.boot('com260', claude, { files: ['u-boot-opensbi', files[2]!] })).rejects.toThrow(/没有自带固件 u-boot-opensbi/)

    // A stage that never brings the port back stops the boot before the next file.
    order.length = 0
    bench.usbPresent = bench.usbPresent.filter(device => device.path !== '3-2.3')
    await expect(svc.boot('com260', claude, { files })).rejects.toThrow(/第 2 个文件.*没有重新出现/)
    expect(order).toEqual([files[0]])
  })
})

/** A remote lab behind a fake BMC: power, consoles, and download ports on its jump host. */
class FakeLab implements LabDriver {
  kind = '测试 BMC'
  calls: string[] = []
  sent: string[] = []
  staged: Array<{ usbPath: string, sha256: string }> = []
  gone = new Set<string>()
  listed: LabDevice[] = ['sub0-0', 'sub0-1', 'sub1-0'].map((name, index) => ({
    name, model: 'k3', online: index !== 2, serialPort: `/dev/ttyS_${index}`, serialConnected: index !== 1, downloadUsbPath: `1-2.${index + 1}`, ip: `10.0.0.${index + 10}`,
  }))
  defaultJump(url: URL) { return `ubuntu@${url.hostname}` }
  async verify(config: LabConfig) {
    if (config.password !== 'lab-password') throw new Error('BMC 拒绝了账号或密码（401）')
    this.calls.push(`verify ${config.username} ${config.jump}`)
    return 'BMC 登录正常，3 台设备'
  }
  async devices() { return this.listed.map(device => ({ ...device })) }
  async reset(_config: LabConfig, device: string) { this.calls.push(`reset ${device}`) }
  /** Set for a lab that learns a board's download port when it appears. */
  learned: string | null = null
  async fastboot(_config: LabConfig, device: string) { this.calls.push(`fastboot ${device}`); return this.learned ?? undefined }
  consoles: Array<{ device: string, history: boolean | undefined }> = []
  async console(_config: LabConfig, device: string, options: { history?: boolean } = {}): Promise<MuxSession> {
    this.consoles.push({ device, history: options.history })
    const listeners = new Set<(data: Buffer) => void>()
    return {
      hello: { alias: device, device: null, baud: 115200, transport: 'bmc' }, history: [`[${device}] k3 login:`],
      send: data => { this.sent.push(`${device}: ${data}`); setTimeout(() => listeners.forEach(fn => fn(Buffer.from(`${data}root@k3:~# `))), 5) },
      onOutput: fn => { listeners.add(fn); return () => listeners.delete(fn) },
      onClose: () => {},
      close: () => listeners.clear(),
    }
  }
  async stage(_config: LabConfig, usbPath: string, file: { path: string, sha256: string }) { this.staged.push({ usbPath, sha256: file.sha256 }); return 'OKAY' }
  async present(_config: LabConfig, usbPath: string) { return !this.gone.has(usbPath) }
}

function labService(lab = new FakeLab()) {
  const bench = new Bench([])
  const svc = new BoardService({ ...bench.options(openDatabase(join(dir, 'lab.sqlite'))), labs: { lab1: lab }, sleep: async () => {}, bootTiming: { firstMs: 0, laterMs: 0, waitMs: 2, pollMs: 1, fastbootSettleMs: 0 } })
  svc.addBoard('user:troy', { name: 'com260', slot: 1, chips: [{ serialPath: '/dev/ttyUSB1', alias: 'com260', downloadUsbPath: '3-2.3' }] })
  return { svc, lab, bench }
}
const enable = (svc: BoardService, change: Partial<Parameters<BoardService['configureLab']>[2]> = {}) =>
  svc.configureLab('user:troy', 'lab1', { enabled: true, url: 'http://bmc.test:8080/dashboard/modules', username: 'admin', password: 'lab-password', devices: 'sub0-*', ...change })
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

describe('remote labs', () => {
  it('lists a lab\'s boards in its device range once enabled, and never reports the password', async () => {
    const { svc, lab } = labService()
    expect(svc.labSettings()).toMatchObject([{ id: 'lab1', kind: '测试 BMC', enabled: false, hasPassword: false }])
    await expect(enable(svc, { password: null })).rejects.toThrow(/先填地址、账号和密码/)
    const settings = await enable(svc)
    expect(settings).toMatchObject({ enabled: true, url: 'http://bmc.test:8080/dashboard/modules', username: 'admin', hasPassword: true, jump: null, defaultJump: 'ubuntu@bmc.test', devices: 'sub0-*', verifyOk: true, syncOk: true })
    expect(settings.syncMessage).toBe('列出 2 块（实验室共 3 台，范围 sub0-*）')
    expect(lab.calls).toEqual(['verify admin ubuntu@bmc.test'])
    const listed = svc.boards().filter(board => board.lab)
    expect(listed.map(board => [board.name, board.lab, board.source, board.soc, board.slot])).toEqual([
      ['lab1-sub0-0', { id: 'lab1', device: 'sub0-0', online: true, ip: '10.0.0.10' }, 'lab', 'k3', null],
      ['lab1-sub0-1', { id: 'lab1', device: 'sub0-1', online: true, ip: '10.0.0.11' }, 'lab', 'k3', null],
    ])
    expect(listed.map(board => board.chips.map(chip => [chip.serialPath, chip.downloadUsbPath, chip.online, chip.alias]))).toEqual([[['/dev/ttyS_0', '1-2.1', true, null]], [['/dev/ttyS_1', '1-2.2', false, null]]])
    // A board whose system has not reported its model yet keeps the one it had.
    lab.listed[0]!.model = null
    await svc.syncLab('lab1')
    expect(svc.board('lab1-sub0-0')).toMatchObject({ product: 'k3', soc: 'k3' })
    // The password stays write-only, a wrong one is reported without echoing it, and saving without one keeps it.
    const bad = await enable(svc, { password: 'wrong-password' })
    expect(bad).toMatchObject({ verifyOk: false, verifyMessage: 'BMC 拒绝了账号或密码（401）' })
    expect((await enable(svc, { password: 'lab-password', jump: 'ops@bmc.test:2222' })).verifyOk).toBe(true)
    expect((await enable(svc, { password: null, jump: 'ops@bmc.test:2222' })).verifyOk).toBe(true)
    expect(lab.calls.at(-1)).toBe('verify admin ops@bmc.test:2222')
    expect(JSON.stringify([svc.state('user:troy'), svc.history()])).not.toMatch(/lab-password|wrong-password/)
    await expect(enable(svc, { jump: 'not a host' })).rejects.toThrow(/跳板机格式不对/)
    await expect(enable(svc, { devices: 'sub0-0; rm' })).rejects.toThrow(/不合法的名字/)
    // Lab boards follow the lab: they are not removed by hand, exported, or given a slot.
    expect(() => svc.removeBoard('user:troy', 'lab1-sub0-0')).toThrow(/跟着实验室/)
    expect(() => svc.updateBoard('user:troy', 'lab1-sub0-0', { slot: 3 })).toThrow(/没有控制槽位/)
    expect(svc.exportToml()).not.toContain('lab1')
  })

  it('takes boards that left the range off the list unless someone holds them, and switches off only when none is held', async () => {
    const { svc, lab } = labService()
    await enable(svc, { devices: '' })
    expect(svc.boards().filter(board => board.lab).map(board => board.name)).toEqual(['lab1-sub0-0', 'lab1-sub0-1', 'lab1-sub1-0'])
    await svc.lock('lab1-sub0-1', 'claude:s1', '调试')
    await svc.lock('lab1-sub1-0', 'claude:s2', '调试', { queue: 'join' })
    await svc.lock('lab1-sub1-0', 'user:troy', '排队', { queue: 'join' })
    lab.listed = lab.listed.filter(device => device.name !== 'sub0-0')
    await enable(svc, { devices: 'sub1-*' })
    expect(svc.boards().filter(board => board.lab).map(board => board.name)).toEqual(['lab1-sub0-1', 'lab1-sub1-0'])
    expect(svc.labSettings()[0]!.syncMessage).toBe('列出 1 块（实验室共 2 台，范围 sub1-*）；lab1-sub0-1 已经不在范围里，有人在用，先留着')
    await expect(svc.configureLab('user:troy', 'lab1', { enabled: false })).rejects.toThrow(/lab1-sub\d-\d 正被 claude:s\d 使用/)
    svc.unlock('lab1-sub0-1', { holder: 'claude:s1', token: (await svc.lock('lab1-sub0-1', 'claude:s1', '调试')).token })
    svc.unlock('lab1-sub1-0', { holder: 'claude:s2', token: (await svc.lock('lab1-sub1-0', 'claude:s2', '调试')).token })
    svc.unlock('lab1-sub1-0', { holder: 'user:troy' })
    const off = await svc.configureLab('user:troy', 'lab1', { enabled: false, url: 'http://bmc.test:8080', username: 'admin' })
    expect(off).toMatchObject({ enabled: false, hasPassword: true })
    expect(svc.boards().map(board => board.name)).toEqual(['com260'])
    await svc.syncLabs()
    expect(svc.boards().map(board => board.name)).toEqual(['com260'])
  })

  it('drives a lab board through its lab under the same lease as a board here', async () => {
    const { svc, lab } = labService()
    await enable(svc)
    await expect(svc.reset('lab1-sub0-0', { holder: 'claude:s1' })).rejects.toThrow(/请先拿/)
    const { token } = await svc.lock('lab1-sub0-0', 'claude:s1', '内存启动')
    const claude = { holder: 'claude:s1', token }
    await svc.fastboot('lab1-sub0-0', claude)
    expect(svc.board('lab1-sub0-0').mode).toBe('fastboot')
    await svc.reset('lab1-sub0-0', claude)
    expect(lab.calls.slice(1)).toEqual(['fastboot sub0-0', 'reset sub0-0'])
    expect(svc.detail('lab1-sub0-0').actions.filter(action => action.kind === 'reset' || action.kind === 'fastboot').map(action => action.detail)).toEqual(['lab1 sub0-0', 'lab1 sub0-0'])

    expect(await svc.send('lab1-sub0-0', claude, { text: 'uname -a', wait: 'root@k3' })).toMatchObject({ matched: true })
    expect(lab.sent).toEqual(['sub0-0: uname -a\n'])
    expect(await svc.log('lab1-sub0-0')).toEqual(['[sub0-0] k3 login:'])
    // A listing that says the port is down can be a minute old; opening the console asks the lab.
    expect(svc.board('lab1-sub0-1').chips[0]!.online).toBe(false)
    expect((await svc.openConsole('lab1-sub0-1')).history).toEqual(['[sub0-1] k3 login:'])

    const fsbl = shipFirmware('fsbl', 'shipped FSBL')
    const kernel = join(dir, 'Image.itb')
    writeFileSync(kernel, 'kernel FIT')
    await svc.stage('lab1-sub0-0', claude, { firmware: 'fsbl' })
    expect(lab.staged).toEqual([{ usbPath: '1-2.1', sha256: sha('shipped FSBL') }])
    lab.staged.length = 0
    const output = await svc.boot('lab1-sub0-0', claude, { files: ['fsbl', kernel] })
    expect(lab.staged).toEqual([{ usbPath: '1-2.1', sha256: sha('shipped FSBL') }, { usbPath: '1-2.1', sha256: sha('kernel FIT') }])
    expect(output).toContain(`1. ${fsbl}`)
    lab.gone.add('1-2.1')
    await expect(svc.boot('lab1-sub0-0', claude, { files: ['fsbl', kernel] })).rejects.toThrow(/第 2 个文件.*没有重新出现/)
    // Boards here still go through their slots and the fastboot on this machine.
    expect(svc.board('com260').lab).toBeNull()
  })

  it('keeps the download port a lab learned when the board entered download mode, and reads no backlog to send input', async () => {
    const { svc, lab } = labService()
    lab.listed = lab.listed.map(device => ({ ...device, downloadUsbPath: null }))
    await enable(svc)
    const { token } = await svc.lock('lab1-sub0-0', 'claude:s1', '内存启动')
    lab.learned = '7-1.4'
    await svc.fastboot('lab1-sub0-0', { holder: 'claude:s1', token })
    expect(svc.board('lab1-sub0-0').chips[0]!.downloadUsbPath).toBe('7-1.4')
    expect(svc.detail('lab1-sub0-0').actions.find(action => action.kind === 'fastboot')?.message).toBe('下载口 7-1.4')
    await svc.syncLab('lab1')
    expect(svc.board('lab1-sub0-0').chips[0]!.downloadUsbPath).toBe('7-1.4')
    await svc.send('lab1-sub0-0', { holder: 'claude:s1', token }, { text: 'uname -a', wait: 'root@k3' })
    await svc.log('lab1-sub0-0')
    expect(lab.consoles).toEqual([{ device: 'sub0-0', history: false }, { device: 'sub0-0', history: true }])
  })

  it('takes device ranges as names or * patterns', () => {
    const range = deviceFilter('sub0-* sub2-1,sub3.*')
    expect(['sub0-0', 'sub0-1', 'sub2-1', 'sub2-0', 'sub3.x', 'sub3-0', 'sub10-0'].filter(range)).toEqual(['sub0-0', 'sub0-1', 'sub2-1', 'sub3.x'])
    expect(deviceFilter('')('anything')).toBe(true)
    expect(deviceFilter(null)('anything')).toBe(true)
  })
})

/** A jump host that answers commands by their beginning and records them. */
const shell = (answers: Record<string, { code: number, output: string }> = {}) => {
  const runs: string[] = []
  const fake: Shell & { runs: string[] } = {
    runs,
    run: async (_jump, command) => { runs.push(command); return Object.entries(answers).find(([key]) => command.startsWith(key))?.[1] ?? { code: 0, output: '' } },
    copy: async (_jump, local, remote) => { runs.push(`copy ${local} ${remote}`); return { code: 0, output: '' } },
    connect: () => { throw new Error('tests connect to their own servers') },
  }
  return fake
}
const STAGE = (remote: string) => `f="$(command -v fastboot || echo .cache/troy-boards/bin/fastboot)"; "$f" -s usb:1-2.1 stage ${remote} && "$f" -s usb:1-2.1 continue`

describe('SpacemiT BMC', () => {
  const config = (url: string, password = 'lab-password'): LabConfig => ({ url, username: 'admin', password, jump: 'ubuntu@bmc.test' })
  /** The few BMC endpoints boardd uses, answering the way the real one does. */
  async function fakeBmc() {
    const seen: string[] = []
    let flashPolls = 0
    const devices = [
      { name: 'sub0-0', model: 'k3', status: 'online', serial_port: '/dev/ttyS_0', fastboot_port: '1-2-1', ip: '192.0.2.72' },
      { name: 'sub0-1', model: 'k3', status: 'offline', serial_port: '/dev/ttyS_1', fastboot_port: '1-2-2', ip: '' },
      { name: 'sub11-0', model: 'unknow', status: 'online', serial_port: '', fastboot_port: '', ip: '192.0.2.90' },
    ]
    const server = createHttpServer(async (req, res) => {
      const url = new URL(req.url!, 'http://bmc')
      let body = ''
      for await (const chunk of req) body += chunk
      seen.push(`${req.method} ${url.pathname}${url.search}${body ? ` ${body}` : ''}`)
      const reply = (status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
      if (req.headers.authorization !== `Basic ${Buffer.from('admin:lab-password').toString('base64')}`) return reply(401, { code: 2006, message: '用户令牌错误', data: {} })
      const ok = (data: unknown) => reply(200, { code: 0, message: 'success', data })
      if (url.pathname === '/api/v1/version') return ok({ version: '1.0.8' })
      if (url.pathname === '/api/v1/user/info') return ok({ username: 'admin' })
      // Two to a page, whatever page size is asked for.
      if (url.pathname === '/api/v1/devices') { const page = Number(url.searchParams.get('page')); return ok({ total: devices.length, page, list: devices.slice((page - 1) * 2, page * 2) }) }
      if (url.pathname === '/api/v1/serial') return reply(200, { serials: [{ connected: true, id: 0, port: '/dev/ttyS_0' }, { connected: false, id: 1, port: '/dev/ttyS_1' }] })
      if (url.pathname === '/api/v1/devices/flash-mode') return ok({ total: 1, results: [{ device_name: url.searchParams.get('device_names'), fastboot_port: '1-2-1', flash_mode: ++flashPolls >= 3 }] })
      if (url.pathname.endsWith('/reconnect')) return reply(200, { id: 0, message: 'reconnected successfully' })
      if (url.pathname.startsWith('/api/v1/openbmc/devices/')) return ok({})
      reply(404, { code: 404, message: 'not found', data: null })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/dashboard/modules`
    return { url, seen, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
  }
  it('turns the BMC\'s download port names into USB paths', () => {
    expect(['1-2-1', '3-3-1-4', '1', '', null, 'usb:1-2.1'].map(usbPathOf)).toEqual(['1-2.1', '3-3.1.4', null, null, null, null])
  })

  it('lists devices page by page, resets and enters download mode, and reopens the serial reader after each', async () => {
    const bmc = await fakeBmc()
    try {
      const driver = spacemitBmc(shell({ 'f=': { code: 0, output: '/usr/local/bin/fastboot' } }), { sleep: async () => {} })
      expect(await driver.verify(config(bmc.url))).toBe('BMC 1.0.8 登录正常，3 台设备；跳板机 ubuntu@bmc.test 可登录，fastboot 在 /usr/local/bin/fastboot')
      expect(await driver.devices(config(bmc.url))).toEqual([
        { name: 'sub0-0', model: 'k3', online: true, serialPort: '/dev/ttyS_0', serialConnected: true, downloadUsbPath: '1-2.1', ip: '192.0.2.72' },
        { name: 'sub0-1', model: 'k3', online: false, serialPort: '/dev/ttyS_1', serialConnected: false, downloadUsbPath: '1-2.2', ip: null },
        { name: 'sub11-0', model: null, online: true, serialPort: null, serialConnected: false, downloadUsbPath: null, ip: '192.0.2.90' },
      ])
      bmc.seen.length = 0
      await driver.reset(config(bmc.url), 'sub0-0')
      await driver.fastboot(config(bmc.url), 'sub0-0')
      expect(bmc.seen).toEqual([
        'POST /api/v1/openbmc/devices/sub0-0/reset {"reset_type":"ForceRestart"}', 'POST /api/v1/serial/sub0-0/reconnect',
        'POST /api/v1/openbmc/devices/sub0-0/firmware-update', 'POST /api/v1/serial/sub0-0/reconnect',
        ...Array(3).fill('GET /api/v1/devices/flash-mode?device_names=sub0-0'),
      ])
      await expect(driver.devices(config(bmc.url, 'wrong'))).rejects.toThrow('BMC 拒绝了账号或密码（401）')
      const unreachable = spacemitBmc(shell({ 'f=': { code: 255, output: 'Permission denied (publickey)' } }))
      await expect(unreachable.verify(config(bmc.url))).rejects.toThrow(/跳板机 ubuntu@bmc.test 登录不了.*Permission denied/)
    } finally { await bmc.close() }
  })

  it('reads a console over the BMC\'s WebSocket: history first, then output, with input sent as plain text', async () => {
    const sockets: Array<{ url: string, sent: unknown[], closed: boolean, onopen?: () => void, onmessage?: (event: { data: unknown }) => void, onclose?: (event: { code: number, reason: string }) => void }> = []
    const driver = spacemitBmc(shell(), {
      socket: url => { const socket = { url, sent: [] as unknown[], closed: false, binaryType: 'blob', send(data: unknown) { this.sent.push(data) }, close() { this.closed = true } }; sockets.push(socket as never); return socket as never },
    })
    const opening = driver.console(config('https://bmc.test:8443/x'), 'sub0-0')
    const socket = sockets[0]!
    expect(socket.url).toBe(`wss://bmc.test:8443/api/v1/serial/sub0-0/ws?auth=${encodeURIComponent(Buffer.from('admin:lab-password').toString('base64'))}`)
    socket.onopen!()
    socket.onmessage!({ data: JSON.stringify({ id: 0, type: 'history', data: 'U-Boot 2022.10\r\nk3 login: ' }) })
    const session = await opening
    expect(session.history).toEqual(['U-Boot 2022.10', 'k3 login: '])
    const output: string[] = []
    session.onOutput(data => output.push(data.toString()))
    const closed: string[] = []
    session.onClose(reason => closed.push(reason))
    socket.onmessage!({ data: JSON.stringify({ type: 'data', data: 'root\r\n' }) })
    socket.onmessage!({ data: new TextEncoder().encode('Password: ').buffer })
    socket.onmessage!({ data: JSON.stringify({ type: 'status', data: 'ignored' }) })
    session.send('root\n')
    expect(output).toEqual(['root\r\n', 'Password: '])
    expect(socket.sent).toEqual(['root\n'])
    socket.onclose!({ code: 1006, reason: '' })
    expect(closed).toEqual(['BMC 串口连接关闭（1006）'])
    // A refused connection fails the open.
    const refused = driver.console(config('http://bmc.test:8080'), 'sub0-1')
    expect(sockets[1]!.url.startsWith('ws://bmc.test:8080/')).toBe(true)
    sockets[1]!.onclose!({ code: 1006, reason: '' })
    await expect(refused).rejects.toThrow('sub0-1 的 BMC 串口连接失败（1006）')
  })

  it('copies a file to the jump host once, checked by its sha256, and stages it with fastboot there', async () => {
    const file = { path: join(dir, 'FSBL.bin'), sha256: sha('fsbl') }
    const remote = `.cache/troy-boards/files/${file.sha256}`
    const missing = shell({ 'test -s': { code: 1, output: '' }, 'f=': { code: 0, output: 'Sending OKAY\nResuming boot OKAY' } })
    expect(await jumpStage(missing, 'ubuntu@bmc.test', '1-2.1', file)).toBe('Sending OKAY\nResuming boot OKAY')
    expect(missing.runs).toEqual([
      `test -s ${remote} && touch ${remote}`,
      'mkdir -p .cache/troy-boards/files && find .cache/troy-boards/files -type f -mtime +3 -delete',
      `copy ${file.path} ${remote}.part`,
      `echo '${file.sha256}  ${remote}.part' | sha256sum -c --quiet && mv ${remote}.part ${remote}`,
      STAGE(remote),
    ])
    const cached = shell()
    await jumpStage(cached, 'ubuntu@bmc.test', '1-2.1', file)
    expect(cached.runs).toEqual([`test -s ${remote} && touch ${remote}`, STAGE(remote)])
    const denied = shell({ 'f=': { code: 1, output: '< waiting for usb:1-2.1>\nno permissions (missing udev rules? user is in the plugdev group)' } })
    await expect(jumpStage(denied, 'ubuntu@bmc.test', '1-2.1', file)).rejects.toThrow(/打不开下载口 1-2.1（没有 USB 权限）.*udev 规则/)
    await expect(jumpStage(cached, 'ubuntu@bmc.test', '1-2.1; reboot', file)).rejects.toThrow(/下载口路径不对/)
  })
})

describe('Firefly aBMC', () => {
  const config = (url: string, password = 'lab-password'): LabConfig => ({ url, username: 'admin', password, jump: 'bmc@abmc.test:2222' })
  /** Server side of a WebSocket: unmask client frames and send plain text ones. */
  const frames = (socket: NetSocket, onText: (text: string) => void) => {
    let buffer = Buffer.alloc(0)
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 6) {
        let length = buffer[1]! & 0x7f, offset = 2
        if (length === 126) { length = buffer.readUInt16BE(2); offset = 4 }
        if (buffer.length < offset + 4 + length) return
        const mask = buffer.subarray(offset, offset + 4)
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length)).map((byte, i) => byte ^ mask[i % 4]!)
        const opcode = buffer[0]! & 0x0f
        buffer = buffer.subarray(offset + 4 + length)
        if (opcode === 0x1) onText(Buffer.from(payload).toString('utf8'))
        if (opcode === 0x8) socket.end()
      }
    })
    // The client may hang up while the fake still has frames to send.
    socket.on('error', () => {})
    return (text: string) => {
      if (socket.destroyed || socket.writableEnded) return
      const body = Buffer.from(text)
      socket.write(Buffer.concat([body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff]), body]))
    }
  }
  /** The few aBMC endpoints boardd uses, a jump host whose USB changes when a node enters its loader, and webtty consoles. */
  async function fakeAbmc() {
    const resets: string[] = []
    const inputs: string[] = []
    let token = 'token-1', logins = 0
    /** Another port that comes up in download mode together with the node asked for. */
    let alongside: string | null = null
    const usb = new Map([['8-1.1', '361c:0008 5'], ['8-1.2', '361c:0008 6'], ['1-1', '1d6b:0002 1']])
    const nodes: Record<string, any> = {
      sub01: { PowerState: 'On', Status: { State: '' }, ProcessorSummary: { Model: 'Spacemit(R) X100' } },
      sub02: { PowerState: 'Off', Status: { State: '' }, ProcessorSummary: { Model: 'Spacemit(R) X100' } },
      sub04: { PowerState: 'On', Status: { State: 'Absent' }, ProcessorSummary: {} },
    }
    const server = createHttpServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      const reply = (status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
      const path = req.url!
      if (req.method === 'POST' && path === '/redfish/v1/SessionService/Sessions') {
        const { username, password } = JSON.parse(body)
        if (username !== 'admin' || password !== 'lab-password') return reply(401, { error: { message: 'unauthorized' } })
        logins++
        return reply(200, { Oem: { Firefly: { 'X-Xsrf-Token': token, UserAccount: 'admin' } } })
      }
      if (req.headers['x-xsrf-token'] !== token) return reply(401, { code: 401, msg: 'unauthorized' })
      if (path === '/redfish/v1/Systems') return reply(200, { Members: ['bmc', 'sub01', 'sub02', 'sub04'].map(id => ({ '@odata.id': `/redfish/v1/Systems/${id}` })) })
      if (path === '/redfish/v1/Chassis/bmc/Oem/Firefly/Board') return reply(200, { info: { ProductName: 'CSB1-N10-K3' } })
      if (path === '/redfish/v1/Oem/PrometheusServices/NodeConfig') return reply(200, { sub01: { SerialCollectStatus: 'enabled/running' }, sub02: { SerialCollectStatus: 'disabled' } })
      const node = path.match(/^\/redfish\/v1\/Systems\/(sub\d+)$/)?.[1]
      if (node && nodes[node]) return reply(200, { Id: node, ...nodes[node] })
      const action = path.match(/^\/redfish\/v1\/Systems\/(sub\d+)\/Actions\/ComputerSystem\.Reset$/)?.[1]
      if (action) {
        const type = JSON.parse(body).ResetType
        resets.push(`${action} ${type}`)
        if (type === 'LoaderByHardware') { usb.set('8-1.1', '361c:1001 9'); if (alongside) usb.set(alongside, '361c:1001 11') }
        return reply(200, {})
      }
      reply(404, { error: { message: 'not found' } })
    })
    server.on('upgrade', (req, socket: NetSocket) => {
      const board = req.url!.match(/^\/redfish\/v1\/Managers\/(sub\d+)\/Oem\/Firefly\/Terminal\/Webtty$/)?.[1]
      if (!board || req.headers['sec-websocket-protocol'] !== 'webtty') return socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
      const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: webtty\r\n\r\n`)
      let type = ''
      const send = frames(socket, text => {
        if (!type) {
          type = JSON.parse(text).Type
          send(`3${board} ${type}`)
          send('61024')
          if (type === 'SerialHistoryLog') {
            for (const line of ['U-Boot 2022.10', 'k3 login: root (automatic login)', 'root@k3:~# ']) send(`1${Buffer.from(`Nov 03 19:45:08 bmc abmc-serial[1873]: ${line}\r\n`).toString('base64')}`)
            socket.end()
          }
          return
        }
        if (text[0] === '1') {
          const input = Buffer.from(text.slice(1), 'base64').toString('utf8')
          inputs.push(input)
          send(`1${Buffer.from(`${input}root@k3:~# `).toString('base64')}`)
        }
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    return {
      url: `https://abmc.test/#/login`, port, resets, inputs, usb, logins: () => logins, alongside: (path: string) => { alongside = path },
      expire: () => { token = `token-${Math.random()}` },
      close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }),
    }
  }
  const driverFor = (abmc: Awaited<ReturnType<typeof fakeAbmc>>, extra: Record<string, { code: number, output: string }> = {}) => {
    const jump = shell(extra)
    const run = jump.run
    jump.run = async (target, command, timeoutMs) => command.startsWith('for d in /sys/bus/usb/devices')
      ? (jump.runs.push('usb'), { code: 0, output: [...abmc.usb].map(([path, state]) => `${path} ${state}`).join('\n') })
      : run(target, command, timeoutMs)
    return { jump, driver: fireflyAbmc(jump, { sleep: async () => {}, connect: () => netConnect(abmc.port, '127.0.0.1') }) }
  }

  it('logs in once and again when the session expires, lists present nodes, and refuses a wrong password', async () => {
    const abmc = await fakeAbmc()
    try {
      const { driver } = driverFor(abmc, { 'f=': { code: 0, output: '.cache/troy-boards/bin/fastboot' } })
      expect(driver.defaultJump(new URL('https://192.0.2.46/'))).toBe('bmc@192.0.2.46:2222')
      expect(await driver.verify(config(abmc.url))).toBe('aBMC 登录正常，CSB1-N10-K3，3 个节点；跳板机 bmc@abmc.test:2222 可登录，fastboot 在 .cache/troy-boards/bin/fastboot')
      expect(await driver.devices(config(abmc.url))).toEqual([
        { name: 'sub01', model: 'k3', online: true, serialPort: '/dev/ttydebug_sub01', serialConnected: true, downloadUsbPath: null, ip: null },
        { name: 'sub02', model: 'k3', online: false, serialPort: '/dev/ttydebug_sub02', serialConnected: false, downloadUsbPath: null, ip: null },
      ])
      expect(abmc.logins()).toBe(1)
      abmc.expire()
      await driver.reset(config(abmc.url), 'sub01')
      expect(abmc.logins()).toBe(2)
      expect(abmc.resets).toEqual(['sub01 PowerCycle'])
      // Checking the access logs in afresh, so a changed password shows at once.
      await expect(driver.verify(config(abmc.url, 'wrong'))).rejects.toThrow('aBMC 拒绝了账号或密码（401）')
    } finally { await abmc.close() }
  })

  it('learns the download port that appears when a node enters its loader', async () => {
    const abmc = await fakeAbmc()
    try {
      const { driver } = driverFor(abmc)
      expect(await driver.fastboot(config(abmc.url), 'sub01')).toBe('8-1.1')
      expect(abmc.resets).toEqual(['sub01 LoaderByHardware'])
      expect((await driver.devices(config(abmc.url)))[0]!.downloadUsbPath).toBe('8-1.1')
      // A port that was already in download mode and did not re-enumerate is not taken for this node.
      await expect(driver.fastboot(config(abmc.url), 'sub02')).rejects.toThrow(/30 秒内跳板机上没有出现新的下载口/)
      // Two ports appearing at once could be either node.
      abmc.usb.set('8-1.1', '361c:0008 10')
      abmc.alongside('8-1.2')
      await expect(driver.fastboot(config(abmc.url), 'sub01')).rejects.toThrow(/同时出现了几个下载口（8-1.1, 8-1.2），认不出哪个是 sub01/)
    } finally { await abmc.close() }
  })

  it('reads a console over webtty: the collected log first, then live output, with input in base64 frames', async () => {
    const abmc = await fakeAbmc()
    try {
      const { driver } = driverFor(abmc)
      const session = await driver.console(config(abmc.url), 'sub01')
      expect(session.history).toEqual(['U-Boot 2022.10', 'k3 login: root (automatic login)', 'root@k3:~# ', ''])
      const output: string[] = []
      session.onOutput(data => output.push(data.toString()))
      session.send('uname -a\n')
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(abmc.inputs).toEqual(['uname -a\n'])
      expect(output.join('')).toBe('uname -a\nroot@k3:~# ')
      session.close()
      const quick = await driver.console(config(abmc.url), 'sub01', { history: false })
      expect(quick.history).toEqual([])
      quick.close()
    } finally { await abmc.close() }
  })
})

describe('Home Assistant setup', () => {
  it('groups controller entities into slots', () => {
    const found = groupEntities([
      { entity_id: 'switch.ctrl_board_1_reset', device_id: 'd' },
      { entity_id: 'button.ctrl_board_1_fastboot_mode', device_id: 'd' },
      { entity_id: 'switch.ctrl_board_0_reset', device_id: 'd' },
      { entity_id: 'switch.ctrl_status_led', device_id: 'd' },
      { entity_id: 'sensor.ctrl_uptime', device_id: 'd' },
    ], new Map([['d', 'wanlong-board-ctrl-001']]))
    expect(found.slots).toEqual([
      { slot: 0, resetEntity: 'switch.ctrl_board_0_reset', fastbootEntity: null, device: 'wanlong-board-ctrl-001' },
      { slot: 1, resetEntity: 'switch.ctrl_board_1_reset', fastbootEntity: 'button.ctrl_board_1_fastboot_mode', device: 'wanlong-board-ctrl-001' },
    ])
    expect(found.unassigned).toEqual(['switch.ctrl_status_led'])
  })

  it('calls HA services on a fresh connection and reports rejected tokens without echoing them', async () => {
    const seen: Array<{ method: string, url: string, auth: string, connection: string, body: string }> = []
    const server = createHttpServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization!, connection: String(req.headers.connection), body })
        if (req.headers.authorization !== 'Bearer good') { res.writeHead(401); return res.end('{}') }
        res.setHeader('Content-Type', 'application/json')
        res.end(req.url === '/api/config' ? '{"location_name":"Lab","version":"2026.5.2"}' : req.url === '/api/' ? '{"message":"API running."}' : '[]')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    try {
      expect(await homeAssistant.verify({ url, token: 'good' })).toBe('API running.；Lab 2026.5.2')
      await homeAssistant.call({ url, token: 'good' }, 'switch.ctrl_board_1_reset')
      expect(seen.at(-1)).toMatchObject({ method: 'POST', url: '/api/services/switch/turn_on', connection: 'close', body: '{"entity_id":"switch.ctrl_board_1_reset"}' })
      const error = await homeAssistant.call({ url, token: 'bad-secret' }, 'button.ctrl_board_1_fastboot_mode').then(() => null, (e: Error) => e)
      expect(error?.message).toBe('Home Assistant 拒绝了令牌（401）')
    } finally { server.close() }
  })

  it('retries a request whose connection never opened, but never resends one that reached HA', async () => {
    // Nothing listens yet: the first attempt is refused and a later one connects.
    const probe = createServer()
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as { port: number }).port
    await new Promise<void>(resolve => probe.close(() => resolve()))
    const requests: string[] = []
    const server = createHttpServer((req, res) => {
      requests.push(req.url!)
      if (req.url!.includes('button')) return req.socket.destroy()
      res.setHeader('Content-Type', 'application/json'); res.end('[]')
    })
    setTimeout(() => server.listen(port, '127.0.0.1'), 150)
    const url = `http://127.0.0.1:${port}`
    try {
      await homeAssistant.call({ url, token: 't' }, 'switch.ctrl_board_1_reset')
      await expect(homeAssistant.call({ url, token: 't' }, 'button.ctrl_board_1_fastboot_mode')).rejects.toThrow(/无法连接/)
      expect(requests).toEqual(['/api/services/switch/turn_on', '/api/services/button/press'])
    } finally { server.close() }
  })

  it('keeps slots in step with Home Assistant on its own, without asking anyone', async () => {
    const bench = new Bench([])
    let reported = [0, 1, 2].map(slot => ({ slot, resetEntity: `switch.ctrl_board_${slot}_reset`, fastbootEntity: `button.ctrl_board_${slot}_fastboot_mode`, device: 'ctrl' }))
    bench.ha.discover = async () => ({ devices: [], slots: reported, unassigned: [] })
    const svc = service(bench)
    await svc.testHa('user:troy')
    expect(svc.slots().map(slot => [slot.slot, slot.resetEntity])).toEqual([[0, 'switch.ctrl_board_0_reset'], [1, 'switch.ctrl_board_1_reset'], [2, 'switch.ctrl_board_2_reset']])
    // Slot 0 disappears from HA and is dropped; slot 1 vanishes too but com260 sits there, so it stays.
    reported = reported.filter(slot => slot.slot === 2)
    await svc.startScan('user:troy', { slots: [2], confirmed: true }).catch(() => null)
    expect(svc.slots().map(slot => slot.slot)).toEqual([1, 2])
    // An empty answer changes nothing.
    reported = []
    await svc.testHa('user:troy')
    expect(svc.slots().map(slot => slot.slot)).toEqual([1, 2])
  })

  it('keeps the stored token when only the address changes and never reports it', async () => {
    const svc = service()
    const settings = await svc.configureHa('user:troy', { url: 'http://ha.test:8123/' })
    expect(settings).toMatchObject({ url: 'http://ha.test:8123', hasToken: true, verifyOk: true })
    const bad = await svc.configureHa('user:troy', { url: 'http://ha.test:8123', token: 'wrong' })
    expect(bad).toMatchObject({ verifyOk: false, verifyMessage: 'Home Assistant 拒绝了令牌（401）' })
    expect(JSON.stringify(svc.history())).not.toMatch(/secret-token-value|wrong/)
  })

})

describe('scan', () => {
  const wiring = [
    { slot: 0, serial: ['/dev/serial/by-id/ftdi-A'], usb: [{ path: '3-6.4.3', usbId: '361c:1001', product: 'k3-pico-itx', serial: '/dev/serial/by-id/ftdi-A' }] },
    { slot: 1, serial: ['/dev/serial/by-id/com260-uart'], usb: [{ path: '3-2.3', usbId: '361c:1001', product: 'k3_com260', serial: '/dev/serial/by-id/com260-uart' }] },
  ]

  async function finish(svc: BoardService, id: string) {
    for (let i = 0; i < 200 && svc.scan(id).status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10))
    return svc.scan(id)
  }

  it('needs confirmation and every lease up front', async () => {
    const svc = service(new Bench(wiring))
    await expect(svc.startScan('user:troy', { confirmed: false })).rejects.toThrow(/确认/)
    await svc.lock('com260', 'claude:x', '忙')
    await expect(svc.startScan('user:troy', { confirmed: true })).rejects.toThrow(/com260 正被 claude:x/)
  })

  it('does not start while any board is held, even outside its scope or by the scanner', async () => {
    const svc = service(new Bench(wiring))
    const agent = await svc.lock('com260', 'claude:x', '忙')
    await expect(svc.startScan('user:troy', { slots: [0], confirmed: true })).rejects.toThrow(/com260 正被 claude:x 使用，扫描未开始/)
    svc.unlock('com260', { holder: 'claude:x', token: agent.token })
    await svc.lock('com260', 'user:troy', '自己拿着')
    await expect(svc.startScan('user:troy', { slots: [0], confirmed: true })).rejects.toThrow(/com260 正被 user:troy/)
  })

  it('maps slots to serial ports, download ports and products, then proposes inventory changes', async () => {
    const bench = new Bench(wiring)
    const svc = service(bench)
    shipFirmware('minor-board-info', 'minor')
    const scan = await finish(svc, (await svc.startScan('user:troy', { confirmed: true })).id)
    expect(scan.status).toBe('done')
    expect(scan.result).toEqual([
      { slot: 0, board: null, flags: [], chips: [{ die: 'die0', serialPath: '/dev/serial/by-id/ftdi-A', downloadUsbPath: '3-6.4.3', usbId: '361c:1001', product: 'k3-pico-itx', pending: false }] },
      { slot: 1, board: 'com260', flags: [], chips: [{ die: 'die0', serialPath: '/dev/serial/by-id/com260-uart', downloadUsbPath: '3-2.3', usbId: '361c:1001', product: 'k3_com260', pending: false }] },
    ])
    // Both slots were restored by a reset and the scan's own leases are gone.
    expect(bench.calls.filter(call => call.endsWith('_reset'))).toEqual(['switch.ctrl_001_board_0_reset', 'switch.ctrl_001_board_1_reset'])
    expect(svc.boards().every(board => board.lease === null)).toBe(true)
    expect(svc.evidence(scan.id).some(item => item.body.includes('product_name=k3_com260'))).toBe(true)
    // The scan trusted no earlier daemon: it stopped them all and listened on fresh ones, which it then took down
    // because no registered board claims those ports yet.
    expect(bench.started).toEqual([['/dev/serial/by-id/com260-uart', 'port-com260-uart'], ['/dev/serial/by-id/ftdi-A', 'port-ftdi-A']])
    expect(bench.stopped).toEqual(['com260', 'port-com260-uart', 'port-ftdi-A'])
    expect(bench.names).toEqual(new Map())

    const proposals = svc.state('user:troy').proposals
    expect(proposals.map(item => item.summary)).toEqual([
      '槽位 0 发现新板子（k3-pico-itx）',
      'com260.die0 串口 /dev/ttyUSB1 → /dev/serial/by-id/com260-uart',
    ])
    await svc.resolveProposals('user:troy', proposals.map(item => item.id), 'apply')
    expect(svc.board('k3-pico-itx-slot0')).toMatchObject({ slot: 0, product: 'k3-pico-itx', soc: 'k3', source: 'scan' })
    // Applying renames each identified port's daemon after its board.
    expect(svc.board('k3-pico-itx-slot0').chips[0]).toMatchObject({ serialPath: '/dev/serial/by-id/ftdi-A', alias: 'k3-pico-itx-slot0', downloadUsbPath: '3-6.4.3' })
    expect(svc.board('com260').chips[0]).toMatchObject({ serialPath: '/dev/serial/by-id/com260-uart', alias: 'com260' })
    expect(bench.names).toEqual(new Map([['/dev/serial/by-id/com260-uart', 'com260'], ['/dev/serial/by-id/ftdi-A', 'k3-pico-itx-slot0']]))
  })

  it('still finds a download port that was already up from an earlier fastboot press', async () => {
    const bench = new Bench(wiring)
    // Slot 1 was left in boot-ROM mode: its download port is present before the scan starts.
    bench.usbPresent.push({ path: '3-2.3', usbId: '361c:1001', serial: '????????????', product: null, devnum: 3 })
    const svc = service(bench)
    shipFirmware('minor-board-info', 'minor')
    const scan = await finish(svc, (await svc.startScan('user:troy', { slots: [1], confirmed: true })).id)
    expect(scan.result[0]!.chips[0]).toMatchObject({ downloadUsbPath: '3-2.3', product: 'k3_com260' })
  })

  it('keeps the ROM banner in the evidence even though it starts with NUL bytes', async () => {
    const svc = service(new Bench(wiring))
    const scan = await finish(svc, (await svc.startScan('user:troy', { slots: [1], confirmed: true })).id)
    const round = svc.evidence(scan.id).find(item => item.label.startsWith('第 1 次 fastboot'))!
    expect(round.body).toBe('sys: 0x10001200\r\nROM: usb download handler\r\n')
  })

  it('does not register a board whose product it could not read', async () => {
    // Serial answers on slot 0, but its download cable is missing, so minor-board-info cannot run.
    const bench = new Bench([{ slot: 0, serial: ['/dev/serial/by-id/ftdi-A'], usb: [] }])
    const svc = service(bench)
    shipFirmware('minor-board-info', 'minor')
    const scan = await finish(svc, (await svc.startScan('user:troy', { slots: [0], confirmed: true })).id)
    expect(scan.result[0]!.flags).toEqual(['fastboot 后没有出现下载口', '认不出型号，没有登记为板子；按上面的原因处理后重新扫描'])
    expect(svc.state('user:troy').proposals).toEqual([])
    expect(bench.names).toEqual(new Map())
  })

  it('renames a board an earlier scan registered under a placeholder once its product is read', async () => {
    const bench = new Bench(wiring)
    const svc = service(bench)
    shipFirmware('minor-board-info', 'minor')
    const db = (svc as unknown as { db: import('node:sqlite').DatabaseSync }).db
    db.prepare(`INSERT INTO boards(name, slot, source) VALUES('board-slot0', 0, 'scan')`).run()
    db.prepare(`INSERT INTO chips(board, die, serial_path, alias) VALUES('board-slot0', 'die0', '/dev/serial/by-id/ftdi-A', 'board-slot0')`).run()
    await svc.lock('board-slot0', 'user:alice', '调试')
    await svc.lock('board-slot0', 'user:bob', '排队', { queue: 'join' })
    const scan = svc.startScan('user:troy', { slots: [0], confirmed: true })
    await expect(scan).rejects.toThrow(/board-slot0 正被 user:alice/)
    svc.unlock('board-slot0', { holder: 'user:alice' })
    svc.unlock('board-slot0', { holder: 'user:bob' })
    await finish(svc, (await svc.startScan('user:troy', { slots: [0], confirmed: true })).id)
    const proposals = svc.state('user:troy').proposals
    expect(proposals.map(item => item.summary)).toContain('board-slot0 读到型号 k3-pico-itx，改名为 k3-pico-itx-slot0')
    await svc.lock('board-slot0', 'user:carol', '持锁时改名')
    await svc.resolveProposals('user:troy', proposals.map(item => item.id), 'apply')
    expect(svc.boards().map(board => board.name)).toContain('k3-pico-itx-slot0')
    expect(svc.board('k3-pico-itx-slot0')).toMatchObject({ product: 'k3-pico-itx', lease: { holder: 'user:carol' } })
    expect(svc.board('k3-pico-itx-slot0').chips[0]).toMatchObject({ alias: 'k3-pico-itx-slot0', downloadUsbPath: '3-6.4.3' })
    expect(bench.names.get('/dev/serial/by-id/ftdi-A')).toBe('k3-pico-itx-slot0')
  })

  it('gives every registered board its serial-mux daemon back when a scan ends', async () => {
    const bench = new Bench(wiring)
    const svc = service(bench)
    shipFirmware('minor-board-info', 'minor')
    const db = (svc as unknown as { db: import('node:sqlite').DatabaseSync }).db
    db.prepare(`UPDATE chips SET serial_path='/dev/serial/by-id/com260-uart' WHERE board='com260'`).run()
    // Slot 0 holds a board outside the scan; its daemon was stopped all the same.
    svc.addBoard('user:troy', { name: 'pico', slot: 0, product: 'k3-pico-itx', chips: [{ serialPath: '/dev/serial/by-id/ftdi-A', alias: 'pico', downloadUsbPath: '3-6.4.3' }] })
    const scan = await finish(svc, (await svc.startScan('user:troy', { slots: [1], confirmed: true })).id)
    expect(scan.status).toBe('done')
    // Nothing changed, so no proposal would have renamed the scan's `port-*` listeners.
    expect(svc.state('user:troy').proposals).toEqual([])
    expect(bench.names).toEqual(new Map([['/dev/serial/by-id/com260-uart', 'com260'], ['/dev/serial/by-id/ftdi-A', 'pico']]))
  })

  it('notices a moved cable and a board that does not answer', async () => {
    const moved = [
      { slot: 0, serial: [], usb: [] },
      { slot: 1, serial: ['/dev/serial/by-id/ftdi-A'], usb: [{ path: '3-2.4', usbId: '361c:1001', product: 'k3_com260', serial: '/dev/serial/by-id/ftdi-A' }] },
    ]
    const svc = service(new Bench(moved))
    shipFirmware('minor-board-info', 'minor')
    const scan = await finish(svc, (await svc.startScan('user:troy', { confirmed: true })).id)
    expect(scan.result[0]!.flags).toEqual(['无串口响应（可能没上电、没接线或板子坏了）', 'fastboot 后没有出现下载口'])
    expect(svc.state('user:troy').proposals.map(item => item.kind)).toEqual(['serial-moved', 'download-moved'])
  })

  it('groups two chips on one board and marks unknown non-K3 download ports', async () => {
    const svc = service(new Bench([
      { slot: 1, serial: ['/dev/serial/by-id/d0', '/dev/serial/by-id/d1'], usb: [
        { path: '3-1.2', usbId: '361c:1001', product: 'k3_dual', serial: '/dev/serial/by-id/d1' },
        { path: '3-1.1', usbId: '361c:1001', product: 'k3_dual', serial: '/dev/serial/by-id/d0' },
      ] },
      { slot: 0, serial: ['/dev/serial/by-id/k1'], usb: [{ path: '3-9', usbId: '361c:1000' }] },
    ]))
    shipFirmware('minor-board-info', 'minor')
    const scan = await finish(svc, (await svc.startScan('user:troy', { slots: [0, 1], confirmed: true })).id)
    expect(scan.result[0]!.chips).toEqual([{ die: 'die0', serialPath: '/dev/serial/by-id/k1', downloadUsbPath: '3-9', usbId: '361c:1000', product: null, pending: false }])
    expect(scan.result[0]!.flags).toEqual(['下载口 3-9（361c:1000）不是 K3，型号未知', '认不出型号，没有登记为板子；按上面的原因处理后重新扫描'])
    expect(scan.result[1]!.chips.map(chip => [chip.die, chip.downloadUsbPath, chip.serialPath])).toEqual([
      ['die0', '3-1.1', '/dev/serial/by-id/d0'], ['die1', '3-1.2', '/dev/serial/by-id/d1'],
    ])
    // Slot 1 held com260, so the scan proposes a board swap; each chip's daemon is named <board>-<die>.
    const swap = svc.state('user:troy').proposals.find(item => item.slot === 1)!
    expect(swap.kind).toBe('replace-board')
    await svc.resolveProposals('user:troy', [swap.id], 'apply')
    expect(svc.board('com260').chips.map(chip => [chip.die, chip.alias])).toEqual([['die0', 'com260-die0'], ['die1', 'com260-die1']])
  })

  it('stops between steps when cancelled and still restores touched slots', async () => {
    const bench = new Bench(wiring)
    const svc = service(bench)
    const scan = await svc.startScan('user:troy', { confirmed: true })
    while (!bench.calls.length) await new Promise(resolve => setTimeout(resolve, 1))
    svc.cancelScan('user:troy', scan.id)
    const done = await finish(svc, scan.id)
    expect(done.status).toBe('cancelled')
    expect(bench.calls.filter(call => call.includes('board_1'))).toEqual([])
    expect(bench.calls.at(-1)).toBe('switch.ctrl_001_board_0_reset')
    expect(svc.boards().every(board => board.lease === null)).toBe(true)
  })
})

describe('serial-mux protocol', () => {
  let server: Server
  afterEach(() => new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()))

  it('handshakes, replays history, streams output and sends base64 input', async () => {
    const home = join(dir, 'mux')
    const { mkdirSync } = await import('node:fs')
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
    const { mkdirSync } = await import('node:fs')
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
    await mux.gate('com260', { token: 't0k', note: 'user:troy 正在使用 com260（调试）' })
    await mux.gate('com260', null)
    const session = await mux.open('com260', { token: 't0k' })
    session.close()
    expect(received.filter(message => message.type !== 'hello')).toEqual([
      { type: 'gate_set', token: 't0k', note: 'user:troy 正在使用 com260（调试）' },
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

describe('boardd API', () => {
  it('serves the CLI over the Unix socket, listens on opted-in hosts and refuses foreign ones', async () => {
    const svc = service()
    const socketPath = join(dir, 'boardd.sock')
    const port = 38000 + Math.floor(Math.random() * 1000)
    const running = await serve(svc, { port, hosts: ['127.0.0.2'], socketPath, uiDir: null })
    try {
      const agent = new BoardsClient(socketPath, 'claude:s9')
      const lock = await agent.lock('com260', '读日志')
      expect(lock.lease!.holder).toBe('claude:s9')
      await expect(new BoardsClient(socketPath, 'claude:other').reset('com260')).rejects.toMatchObject({ status: 423 })
      await agent.unlock('com260', lock.token)
      const ok = await fetch(`http://127.0.0.1:${port}/api/state`)
      expect((await ok.json()).you).toMatch(/^user:/)
      const extra = await fetch(`http://127.0.0.2:${port}/api/state`)
      expect(extra.status).toBe(200)
      // People on the page name themselves; malformed names fall back to the local user.
      expect((await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'X-Boards-User': 'alice' } })).json()).you).toBe('user:alice')
      expect((await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'X-Boards-User': 'a b' } })).json()).you).not.toBe('user:a b')
      const rebinding = await new Promise<number>((resolve, reject) => request({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: `evil.test:${port}` } }, response => { response.resume(); resolve(response.statusCode!) }).on('error', reject).end())
      expect(rebinding).toBe(403)
      const crossSite = await fetch(`http://127.0.0.1:${port}/api/lock`, { method: 'POST', headers: { Origin: 'http://evil.test' }, body: '{}' })
      expect(crossSite.status).toBe(403)
    } finally { await running.close() }
  })
})

describe('CLI arguments', () => {
  it('reads the pattern after send --wait, while lock --wait stays a switch', () => {
    const send = parseArgs(['send', 'com260', 'printenv ethaddr', '--wait', '=> ', '--timeout', '10s'])
    expect(send.positional).toEqual(['send', 'com260', 'printenv ethaddr'])
    expect(send.flags.get('wait')).toBe('=> ')
    const lock = parseArgs(['lock', 'com260', '--wait', '--for', '调试'])
    expect(lock.flags.get('wait')).toBe(true)
    expect(lock.flags.get('for')).toBe('调试')
  })
})

describe('usb diff', () => {
  it('reports devices that appeared and disappeared', () => {
    const a = { path: '3-2.3', usbId: '361c:1001', serial: null, product: null }
    const b = { path: '3-6', usbId: '0403:6001', serial: null, product: null }
    expect(diffUsb([b], [a, b])).toEqual({ added: [a], removed: [] })
  })
})

describe('multi-port serial adapters', () => {
  // A quad FTDI (1-2.3) has four ttys, one per USB interface, beside a single-port adapter (1-2.1).
  const ports = [['ttyUSB4', '1-2.1', '1.0'], ['ttyUSB5', '1-2.3', '1.0'], ['ttyUSB6', '1-2.3', '1.1'], ['ttyUSB7', '1-2.3', '1.2'], ['ttyUSB8', '1-2.3', '1.3']] as const
  const byPath = (usb: string, iface: string) => `pci-0000:00:14.0-usb-0:${usb.replace(/^\d+-/, '')}:${iface}-port0`

  function sysfs() {
    const sys = join(dir, 'sys'), dev = join(dir, 'dev')
    mkdirSync(join(sys, 'class/tty'), { recursive: true })
    mkdirSync(join(dev, 'serial/by-path'), { recursive: true })
    for (const [tty, usb, iface] of ports) {
      const device = join(sys, 'devices/pci0000:00/0000:00:14.0/usb1/1-2', usb, `${usb}:${iface}`, tty)
      mkdirSync(device, { recursive: true })
      mkdirSync(join(sys, 'class/tty', tty), { recursive: true })
      symlinkSync(device, join(sys, 'class/tty', tty, 'device'))
      mkdirSync(join(sys, 'bus/usb/devices', usb), { recursive: true })
      writeFileSync(join(sys, 'bus/usb/devices', usb, 'idVendor'), '0403\n')
      writeFileSync(join(dev, tty), '')
      symlinkSync(join(dev, tty), join(dev, 'serial/by-path', byPath(usb, iface)))
    }
    return { sys, dev }
  }

  it('tells the ports of one adapter apart by their USB interface', () => {
    const { sys, dev } = sysfs()
    const adapters = listSerialAdapters(dev, sys)
    expect(adapters.map(adapter => [adapter.device.split('/').at(-1), adapter.usbPath, adapter.usbInterface])).toEqual(ports.map(([tty, usb, iface]) => [tty, usb, `${usb}:${iface}`]))
    expect(adapters.map(adapter => adapter.link)).toEqual(ports.map(([, usb, iface]) => join(dev, 'serial/by-path', byPath(usb, iface))))
    // Only the adapter whose ports share one USB port needs the interface in its name.
    expect(adapters.map(adapter => adapterPortName(adapter, adapters))).toEqual(['1-2.1', '1-2.3-1.0', '1-2.3-1.1', '1-2.3-1.2', '1-2.3-1.3'])
  })

  it('starts a daemon for each port, not one for the whole adapter', async () => {
    const home = join(dir, 'mux')
    mkdirSync(join(home, 'run'), { recursive: true })
    mkdirSync(join(home, 'sock'), { recursive: true })
    const mux = new SerialMux(home)
    const calls: string[][] = []
    const run = async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'stop') { rmSync(mux.socketPath(args[1]!), { force: true }); rmSync(join(home, 'run', `${args[1]}.json`), { force: true }) }
      if (args[0] !== 'start') return
      const alias = args[2]!, link = args[5]!
      const iface = link.match(/usb-0:([\d.]+:\d+\.\d+)-port0$/)![1]
      writeFileSync(mux.socketPath(alias), '')
      writeFileSync(join(home, 'run', `${alias}.json`), JSON.stringify({ alias, device: link, baud: 115200, pid: 1, socket: mux.socketPath(alias), usb_port: `pci0000:00/0000:00:14.0/usb/usb-1/usb-${iface.split(':')[0]}/usb-${iface}` }))
    }
    const adapter = (iface: string): SerialAdapter => ({ link: `/dev/serial/by-path/${byPath('1-2.3', iface)}`, device: `/dev/ttyUSB${5 + Number(iface.split('.')[1])}`, usbPath: '1-2.3', usbInterface: `1-2.3:${iface}` })
    for (const iface of ['1.0', '1.1', '1.2', '1.3']) await startAlias(mux, adapter(iface), `port-1-2.3-${iface}`, 115200, run)
    // Each port got its own daemon, and none stopped another port's daemon of the same adapter.
    expect(calls.map(args => args.slice(0, 3))).toEqual(['1.0', '1.1', '1.2', '1.3'].map(iface => ['start', '--alias', `port-1-2.3-${iface}`]))
    expect(mux.daemons().map(daemon => daemon.alias).sort()).toEqual(['port-1-2.3-1.0', 'port-1-2.3-1.1', 'port-1-2.3-1.2', 'port-1-2.3-1.3'])
    // A port already under the name it asks for is left running; a new name for a held port replaces the old one.
    calls.length = 0
    await startAlias(mux, adapter('1.2'), 'port-1-2.3-1.2', 115200, run)
    expect(calls).toEqual([])
    await startAlias(mux, adapter('1.2'), 'gemini-die0', 115200, run)
    expect(calls.map(args => args.slice(0, 3))).toEqual([['stop', 'port-1-2.3-1.2'], ['start', '--alias', 'gemini-die0']])
  })
})
