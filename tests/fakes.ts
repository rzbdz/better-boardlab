/**
 * The fake bench the boardlab tests share: Home Assistant, serial-mux, USB, fastboot and slot scripts, all in memory,
 * behind a lab with this distribution's public modules. No test reaches real hardware.
 */
import { afterEach, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from 'boardlab-core/core/db.ts'
import type { ConsoleSession } from 'boardlab-core/core/console.ts'
import { BoardLab } from 'boardlab-core/core/lab.ts'
import type { BootTiming } from 'boardlab-core/core/download.ts'
import type { HaClient } from '../src/modules/home-assistant/client.ts'
import type { ScriptRunner, SerialAdapter, UsbDevice } from '../src/modules/local/hardware.ts'
import { local, type Hardware, type LocalApi, type Mux } from '../src/modules/local/index.ts'
import type { ScanTiming } from '../src/modules/local/scan.ts'
import { homeAssistant as haModule, type HomeAssistantApi } from '../src/modules/home-assistant/index.ts'
import { scriptSlots, type ScriptSlotsApi } from '../src/modules/script-slots/index.ts'
import { bsp } from '../src/modules/bsp/index.ts'
import type { SdkRunner } from '../src/modules/bsp/sdk.ts'

/** What a test lab is made of: the bench's fakes, and the SDK runner a test adds. */
export interface TestOptions {
  db: import('node:sqlite').DatabaseSync
  ha: HaClient
  mux: Mux
  hardware: Hardware & { scripts: ScriptRunner }
  scanTiming?: ScanTiming
  firmwareDir?: string
  filesDir?: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  bootTiming?: Partial<BootTiming>
  sdk?: SdkRunner
}

/** A lab with every module a test may use: this machine's slots and consoles, HA, script slots and bsp's SDK runner. */
export function makeLab(options: TestOptions): BoardLab {
  return new BoardLab({
    db: options.db, now: options.now, sleep: options.sleep, firmwareDir: options.firmwareDir, filesDir: options.filesDir, bootTiming: options.bootTiming,
    modules: [
      local({ mux: options.mux, hardware: options.hardware, scanTiming: options.scanTiming }),
      haModule({ client: options.ha }),
      scriptSlots({ runner: options.hardware.scripts }),
      bsp({ sdk: options.sdk, instances: [] }),
    ],
  })
}
export const scanner = (lab: BoardLab) => lab.module<LocalApi>('local').scanner
export const slotsOf = (lab: BoardLab) => lab.module<LocalApi>('local').slots.list()
export const ha = (lab: BoardLab) => lab.module<HomeAssistantApi>('home-assistant')
export const scripts = (lab: BoardLab) => lab.module<ScriptSlotsApi>('script-slots')

/** A bench of boards behind fake HA, serial-mux, USB and fastboot. */
export class Bench {
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

  options(db = openDatabase(join(mkdtempSync(join(tmpdir(), 'boards-')), 'b.sqlite'))): TestOptions {
    return {
      db, ha: this.ha,
      mux: {
        open: async (alias, token) => {
          const listeners = new Set<(data: Buffer) => void>()
          this.listeners.set(alias, this.listeners.get(alias) ?? new Set())
          const all = this.listeners.get(alias)!
          const session: ConsoleSession = {
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
        records: () => [...this.names].map(([link, alias]) => ({ alias, device: link })),
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
      firmwareDir: join(dir, 'firmware'), filesDir: join(dir, 'files'),
    }
  }
}

/** A fresh scratch directory for each test of the file that calls this; `dir` is it. */
export let dir: string
export function useTempDir() {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boards-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
}

/** Ship a firmware file the way firmware/ does: the file plus its firmware.json entry. */
export function shipFirmware(purpose: string, content: string, soc = 'k3') {
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
export function service(bench = new Bench([]), now?: () => number) {
  const db = openDatabase(join(dir, 'boards.sqlite'))
  const svc = makeLab({ ...bench.options(db), now })
  db.prepare(`INSERT INTO settings(key, value) VALUES('ha.url', 'http://ha.test:8123'), ('ha.token', 'secret-token-value')`).run()
  ha(svc).confirm('user:dana', [0, 1].map(slot => ({ slot, resetEntity: `switch.ctrl_001_board_${slot}_reset`, fastbootEntity: `button.ctrl_001_board_${slot}_fastboot_mode` })))
  svc.boards.add('user:dana', { name: 'com260', slot: 1, product: 'k3_com260', chips: [{ serialPath: '/dev/ttyUSB1', alias: 'com260', downloadUsbPath: '3-2.3' }] })
  return svc
}

export const sha = (text: string) => createHash('sha256').update(text).digest('hex')
