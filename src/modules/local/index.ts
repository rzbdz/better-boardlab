/**
 * The `local` module: boards wired to the machine boardd runs on. It registers the local backend as the default one
 * (boards registered without a backend are its), keeps the control slots and their drivers, makes each serial port's
 * serial-mux input gate follow the board's lock, and scans the slots. Slot drivers come from other modules
 * (`home-assistant`, `script-slots`).
 */
import { required } from 'boardlab-core/core/api.ts'
import type { Module } from 'boardlab-core/core/module.ts'
import type { BoardLab } from 'boardlab-core/core/lab.ts'
import { localBackend, type Hardware, type Mux } from './backend.ts'
import type { ScanTiming } from './scan.ts'
import { Scanner } from './scanner.ts'
import { Slots } from './slots.ts'

export type { Hardware, Mux } from './backend.ts'
export type { SlotAction, SlotDriver } from './slots.ts'

export const LOCAL = 'local'

/** Control slots (each kind's columns are its driver's), and scans with their steps and the evidence they read. */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS slots (
    slot INTEGER PRIMARY KEY, reset_entity TEXT, fastboot_entity TEXT, device TEXT, confirmed_at TEXT,
    kind TEXT NOT NULL DEFAULT 'ha', label TEXT, reset_script TEXT, fastboot_script TEXT
  );
  CREATE TABLE IF NOT EXISTS scans (
    id TEXT PRIMARY KEY, holder TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL,
    started_at TEXT NOT NULL, finished_at TEXT, message TEXT, result TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS scan_steps (
    scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE, seq INTEGER NOT NULL, at TEXT NOT NULL,
    slot INTEGER, kind TEXT NOT NULL, summary TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scan_id, seq)
  );
  CREATE TABLE IF NOT EXISTS scan_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT, scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
    slot INTEGER, kind TEXT NOT NULL, label TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL
  );
`

export interface LocalApi {
  slots: Slots
  scanner: Scanner
}

export function local(options: { mux: Mux, hardware: Hardware, scanTiming?: ScanTiming }): Module<LocalApi> {
  return {
    id: LOCAL,
    title: '本机板子（槽位、串口、fastboot、扫描）',
    setup(lab) {
      lab.kernel.schema(SCHEMA, [
        // Slots from before slot kinds were all on a Home Assistant controller.
        ['slots', 'kind', "TEXT NOT NULL DEFAULT 'ha'"], ['slots', 'label', 'TEXT'], ['slots', 'reset_script', 'TEXT'], ['slots', 'fastboot_script', 'TEXT'],
      ])
      const slots = new Slots(lab)
      const scanner = new Scanner(lab, slots, options.mux, options.hardware, options.scanTiming)
      lab.backends.register(LOCAL, localBackend(slots, options.mux, options.hardware), { configurable: false, isDefault: true })
      followGates(lab, options.mux)
      lab.proposals.addOwner({ owns: proposal => scanner.owns(proposal), resolve: (actor, proposals, decision, given) => scanner.resolve(actor, proposals, decision, given) })
      lab.addState(() => ({ slots: slots.list(), scan: scanner.latest() }))
      lab.addHistory(() => ({ scans: scanner.recent() }))
      lab.api.add(LOCAL, [
        { method: 'GET', path: '/api/scan', about: '一次扫描的过程和结果', handle: ({ query }) => scanner.get(required(query.get('id'), 'id')) },
        { method: 'GET', path: '/api/scan/evidence', about: '扫描时读到的串口输出', handle: ({ query }) => scanner.evidence(required(query.get('id'), 'id')) },
        { method: 'POST', path: '/api/scan', about: '扫描本机的槽位（会复位板子，要 confirmed）', handle: ({ body, caller }) => scanner.start(caller.holder, { slots: body.slots, boards: body.boards, confirmed: body.confirmed === true }) },
        { method: 'POST', path: '/api/scan/cancel', about: '取消扫描', handle: ({ body, caller }) => { scanner.cancel(caller.holder, required(body.id, 'id')) } },
      ])
      // Boards keep their consoles across reboots and scans boardd did not live to finish.
      lab.addService(() => { void scanner.restoreConsoles().catch(() => {}) })
      return { slots, scanner }
    },
  }
}

/**
 * Make a local board's serial-mux input gates follow its lock: on with the lock's gate token while it is held, so only
 * the holder (through boardd or `smtty --token`) can type, and off while it is free. Failures are kept per port and
 * shown on the board, never ignored.
 */
function followGates(lab: BoardLab, mux: Mux) {
  const errors = new Map<string, string>()
  lab.boards.addView((board, record) => {
    if (record.backend !== LOCAL) return
    for (const chip of board.chips) chip.gateError = chip.alias ? errors.get(chip.alias) ?? null : null
  })
  lab.locks.addFollower({
    follow: async name => {
      if (lab.boards.record(name)?.backend !== LOCAL) return null
      const board = lab.boards.get(name)
      const held = lab.locks.held(name)
      const gate = held ? { token: held.gateToken, note: `${held.holder} 正在使用 ${name}（${held.purpose}）` } : null
      let changed = false
      const failed: string[] = []
      for (const chip of board.chips) {
        if (!chip.alias || !chip.online) continue
        try {
          await mux.gate(chip.alias, gate)
          if (errors.delete(chip.alias)) changed = true
        } catch (error) {
          const message = (error as Error).message
          failed.push(message)
          if (errors.get(chip.alias) !== message) {
            lab.kernel.record('boardd', name, 'gate', chip.alias, false, message)
            changed = true
          }
          errors.set(chip.alias, message)
        }
      }
      if (changed) lab.kernel.changed(name)
      return failed[0] ?? null
    },
  })
}
