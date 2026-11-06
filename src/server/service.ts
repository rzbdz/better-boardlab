/** boardd's authority: inventory, leases, controls and scans. Every hardware action goes through a held lease. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type {
  Action, Board, BoardDetail, BoardEvent, BoardMode, Chip, Firmware, HaDiscovery, HaSettings, LabSettings, Lease, LockResult,
  Proposal, ProposalKind, Scan, ScanRow, SendResult, Slot, State, Waiter,
} from '../shared/types.ts'
import { transaction } from './db.ts'
import { readFirmware } from './firmware.ts'
import type { HaClient, HaConfig } from './ha.ts'
import { adapterPortName, stageAndContinue, type FastbootRunner, type ScriptRunner, type SerialAdapter, type UsbDevice } from './hardware.ts'
import { DEVICE_PATTERN, deviceFilter, JUMP, type LabConfig, type LabDevice, type LabDriver } from './labs.ts'
import { formatToml, type TomlTable } from './toml.ts'
import { runScan, ScanCancelled, type ScanTiming } from './scan.ts'
import type { MuxSession } from './serial-mux.ts'

export class BoardError extends Error {
  constructor(readonly code: 'not-found' | 'invalid' | 'locked' | 'forbidden' | 'conflict' | 'hardware', message: string) { super(message) }
}

export interface Mux {
  /** `token` is the lease's gate token, so boardd's own input passes the port's serial-mux gate. */
  open(alias: string, token?: string | null): Promise<MuxSession>
  /** Turn the port's input gate on with this token, or off with null; fails on a serial-mux without the gate. */
  gate(alias: string, gate: { token: string, note: string } | null): Promise<void>
  /** Whether a daemon for this alias is running with a serial device bound. */
  online(alias: string): boolean
  stopAll(): Promise<string[]>
  /** Run the adapter's daemon under `alias`, replacing whatever held the port or the name. */
  start(adapter: SerialAdapter, alias: string): Promise<string>
  /** Stop and forget the daemon under `alias`; nothing happens if there is none. */
  stop(alias: string): Promise<void>
}

export interface Hardware {
  usb(): UsbDevice[]
  serialAdapters(): SerialAdapter[]
  fastboot: FastbootRunner
  scripts: ScriptRunner
}

export interface ServiceOptions {
  db: DatabaseSync
  ha: HaClient
  mux: Mux
  hardware: Hardware
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  scanTiming?: ScanTiming
  bootTiming?: BootTiming
  /** firmware/: firmware.json and the files it lists. */
  firmwareDir?: string
  /** Remote labs boardd knows how to drive, by id; each is enabled and given access on the page. */
  labs?: Record<string, LabDriver>
}

/** Where a board's download port is: on this machine, or on its lab's jump host. */
interface DownloadPort {
  stage(usbPath: string, file: { path: string, sha256: string }, timeoutMs?: number): Promise<string>
  present(usbPath: string): Promise<boolean>
}

/**
 * A RAM boot hands the port from the boot ROM to FSBL, then to U-Boot: each
 * stage needs time to come up and re-enumerate before the next file goes in.
 * Before that, a Home Assistant fastboot button answers once its key sequence
 * starts, and the board resets about 2 s later; `fastbootSettleMs` waits that out.
 */
export interface BootTiming { firstMs: number, laterMs: number, waitMs: number, pollMs: number, fastbootSettleMs: number }
/** What `boards boot` and `boards stage` take as one of boardd's own firmware files rather than a path. */
const FIRMWARE_NAME = /^[a-z0-9][a-z0-9-]*$/
const BOOT_TIMING: BootTiming = { firstMs: 8_000, laterMs: 3_000, waitMs: 20_000, pollMs: 500, fastbootSettleMs: 6_000 }
/** A kernel FIT is tens of MB. */
const BOOT_STAGE_TIMEOUT_MS = 120_000

const HOLDER = /^(user|claude|dsh|workspace):[^\s]{1,120}$/
const BOARD_NAME = /^[A-Za-z0-9_.-]{1,64}$/
/** Power-cycling through a smart plug can take a while; anything longer is treated as hung. */
const SCRIPT_TIMEOUT_MS = 120_000
const SCRIPT_LIMIT = 64 * 1024
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g

export const isHuman = (holder: string) => holder.startsWith('user:')
/** Printable text only: ANSI sequences and control bytes go, so a K3 ROM banner's leading NULs cannot cut stored text short. */
export const stripAnsi = (text: string) => text.replace(ANSI, '').replace(/\r(?!\n)/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
const hash = (token: string) => createHash('sha256').update(token).digest('hex')
const slotKey = (slot: number) => `slot:${slot}`

type Row = Record<string, any>

export class BoardService {
  readonly events = new EventEmitter()
  private readonly db: DatabaseSync
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly waiting = new Map<string, (result: LockResult) => void>()
  private scanAbort: { id: string, cancelled: boolean } | null = null
  /** Ports whose gate could not be made to follow the lock, by alias. */
  private readonly gateErrors = new Map<string, string>()
  private readonly gateRuns = new Map<string, Promise<void>>()
  /** What each lab board's lab said about it at the last listing, by board name. */
  private readonly labDevices = new Map<string, LabDevice>()

  constructor(private readonly options: ServiceOptions) {
    this.db = options.db
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.db.prepare(`UPDATE scans SET status='failed', finished_at=?, message='boardd 重启，扫描中断' WHERE status='running'`).run(this.iso())
    this.events.setMaxListeners(100)
  }

  private iso(offset = 0) { return new Date(this.now() + offset).toISOString() }
  private emit(event: BoardEvent) { this.events.emit('event', event) }
  private changed(board: string | null) { this.emit({ type: 'changed', board }) }

  // ---------- reads ----------

  state(you: string): State {
    return {
      boards: this.boards(), slots: this.slots(), ha: this.haSettings(), labs: this.labSettings(), firmware: this.firmware(),
      proposals: this.db.prepare(`SELECT * FROM proposals WHERE status='pending' ORDER BY slot, rowid`).all().map(toProposal),
      scan: this.latestScan(), you, now: this.iso(),
    }
  }

  boards(): Board[] {
    const lab = new Set(this.db.prepare('SELECT name FROM boards WHERE lab IS NOT NULL').all().map(row => String(row.name)))
    // A lab board's console is the lab's serial reader, so it is usable while the lab has the port open.
    const online = (chip: ReturnType<typeof toChip>) => lab.has(chip.board) ? !!this.labDevices.get(chip.board)?.serialConnected : !!chip.alias && this.options.mux.online(chip.alias)
    const chips = this.db.prepare('SELECT * FROM chips ORDER BY board, die').all().map(toChip)
      .map(chip => ({ ...chip, online: online(chip), gateError: chip.alias ? this.gateErrors.get(chip.alias) ?? null : null }))
    const leases = new Map(this.db.prepare(`SELECT * FROM leases WHERE status='held'`).all().map(row => [String(row.board), toLease(row)]))
    const waiters = this.db.prepare('SELECT * FROM lease_waiters ORDER BY queued_at').all().map(toWaiter)
    return this.db.prepare('SELECT * FROM boards ORDER BY slot IS NULL, slot, name').all().map(row => ({
      name: String(row.name), slot: row.slot === null ? null : Number(row.slot), serial: str(row.serial), product: str(row.product),
      baseMac: str(row.base_mac), soc: str(row.soc), notes: str(row.notes), source: row.source as Board['source'],
      mode: row.mode as BoardMode, lastSeenAt: str(row.last_seen_at),
      chips: chips.filter(chip => chip.board === row.name), lease: leases.get(String(row.name)) ?? null,
      waiters: waiters.filter(waiter => waiter.board === row.name),
      lab: row.lab ? {
        id: String(row.lab), device: String(row.lab_device),
        online: !!this.labDevices.get(String(row.name))?.online, ip: this.labDevices.get(String(row.name))?.ip ?? null,
      } : null,
    }))
  }

  board(name: string): Board {
    const board = this.boards().find(item => item.name === name)
    if (!board) throw new BoardError('not-found', `没有这块板：${name}`)
    return board
  }

  detail(name: string): BoardDetail {
    return {
      board: this.board(name),
      actions: this.db.prepare('SELECT * FROM actions WHERE board=? ORDER BY id DESC LIMIT 100').all(name).map(toAction),
      leases: this.db.prepare('SELECT * FROM leases WHERE board=? ORDER BY started_at DESC LIMIT 50').all(name).map(toLease),
    }
  }

  history(limit = 200): { actions: Action[], leases: Lease[], scans: Scan[] } {
    return {
      actions: this.db.prepare('SELECT * FROM actions ORDER BY id DESC LIMIT ?').all(limit).map(toAction),
      leases: this.db.prepare('SELECT * FROM leases ORDER BY started_at DESC LIMIT ?').all(limit).map(toLease),
      scans: this.db.prepare('SELECT id FROM scans ORDER BY started_at DESC LIMIT 20').all().map(row => this.scan(String(row.id))),
    }
  }

  slots(): Slot[] {
    return this.db.prepare('SELECT * FROM slots ORDER BY slot').all().map(row => {
      const kind = row.kind === 'script' ? 'script' : 'ha'
      const resetScript = str(row.reset_script), fastbootScript = str(row.fastboot_script)
      const resetEntity = str(row.reset_entity), fastbootEntity = str(row.fastboot_entity)
      return {
        slot: Number(row.slot), kind, label: str(row.label), resetEntity, fastbootEntity, resetScript, fastbootScript,
        device: str(row.device), confirmedAt: str(row.confirmed_at),
        canReset: kind === 'script' ? !!resetScript : !!resetEntity,
        canFastboot: kind === 'script' ? !!fastbootScript : !!fastbootEntity,
      }
    })
  }

  firmware(): Firmware[] {
    return readFirmware(this.options.firmwareDir)
  }

  private record(actor: string, board: string | null, kind: string, detail: string | null, ok: boolean, message: string | null = null) {
    this.db.prepare('INSERT INTO actions(at, actor, board, kind, detail, ok, message) VALUES(?,?,?,?,?,?,?)')
      .run(this.iso(), actor, board, kind, detail, ok ? 1 : 0, message)
  }

  // ---------- leases ----------

  /** Lease targets are board names, or `slot:N` for a control slot that has no board yet. */
  private assertTarget(target: string) {
    const slot = target.match(/^slot:(\d+)$/)
    if (slot) {
      if (!this.db.prepare('SELECT 1 FROM slots WHERE slot=?').get(Number(slot[1]))) throw new BoardError('not-found', `没有槽位 ${slot[1]}`)
    } else if (!this.db.prepare('SELECT 1 FROM boards WHERE name=?').get(target)) throw new BoardError('not-found', `没有这块板：${target}`)
  }

  private heldLease(target: string): (Lease & { tokenHash: string, gateToken: string }) | null {
    const row = this.db.prepare(`SELECT * FROM leases WHERE board=? AND status='held'`).get(target)
    if (!row) return null
    // Leases taken before boardd gated serial ports get their gate token when first needed.
    let gateToken = str(row.gate_token)
    if (!gateToken) {
      gateToken = randomBytes(24).toString('base64url')
      this.db.prepare('UPDATE leases SET gate_token=? WHERE id=?').run(gateToken, row.id)
    }
    return { ...toLease(row), tokenHash: String(row.token_hash), gateToken }
  }

  private grant(target: string, holder: string, purpose: string): { lease: Lease, token: string, gateToken: string } {
    const token = randomBytes(24).toString('base64url')
    const gateToken = randomBytes(24).toString('base64url')
    const lease: Lease = { id: randomUUID(), board: target, holder, purpose, startedAt: this.iso(), status: 'held', endedAt: null, endReason: null }
    this.db.prepare('INSERT INTO leases(id, board, holder, purpose, token_hash, started_at, status, gate_token) VALUES(?,?,?,?,?,?,?,?)')
      .run(lease.id, target, holder, purpose, hash(token), lease.startedAt, 'held', gateToken)
    this.record(holder, target, 'lock', purpose, true)
    return { lease, token, gateToken }
  }

  private queue(target: string): Waiter[] {
    return this.db.prepare('SELECT * FROM lease_waiters WHERE board=? ORDER BY queued_at, rowid').all(target).map(toWaiter)
  }

  /**
   * Take a board's lock. Locks have no time limit: they last until released or stolen.
   * A busy board can be queued for (`queue: 'join'`), or waited on until granted (`queue: 'wait'`, leaving the queue if
   * the caller goes away). The queue is first come, first served and survives restarts; asking again while holding the
   * lock re-issues its token.
   */
  async lock(target: string, holder: string, purpose: string, options: { queue?: 'none' | 'join' | 'wait', signal?: AbortSignal } = {}): Promise<LockResult> {
    if (!HOLDER.test(holder)) throw new BoardError('invalid', `持有人格式不对：${holder}`)
    if (!purpose.trim()) throw new BoardError('invalid', '请写明用途')
    const mode = options.queue ?? 'none'
    const result = transaction(this.db, (): LockResult | { waiter: string } => {
      this.assertTarget(target)
      const held = this.heldLease(target)
      if (held?.holder === holder) {
        const token = randomBytes(24).toString('base64url')
        this.db.prepare('UPDATE leases SET token_hash=? WHERE id=?').run(hash(token), held.id)
        const { tokenHash: _, gateToken, ...lease } = held
        return { lease, token, gateToken, queued: null }
      }
      const queue = this.queue(target)
      if (!held && !queue.length) return { ...this.grant(target, holder, purpose), queued: null }
      if (mode === 'none') {
        throw new BoardError('locked', held ? `${target} 正被 ${held.holder} 使用（${held.purpose}）${queue.length ? `，${queue.length} 人排队` : ''}` : `${target} 有 ${queue.length} 人排队`)
      }
      const mine = queue.find(waiter => waiter.holder === holder)
      if (mine) return mode === 'join' ? { lease: null, token: null, gateToken: null, queued: { position: queue.indexOf(mine) + 1 } } : { waiter: mine.id }
      const id = randomUUID()
      this.db.prepare('INSERT INTO lease_waiters(id, board, holder, purpose, queued_at) VALUES(?,?,?,?,?)').run(id, target, holder, purpose, this.iso())
      this.record(holder, target, 'queue', purpose, true, `第 ${queue.length + 1} 位`)
      return mode === 'join' ? { lease: null, token: null, gateToken: null, queued: { position: queue.length + 1 } } : { waiter: id }
    })
    this.changed(target)
    if (!('waiter' in result)) {
      if (result.lease) void this.syncGates(target)
      return result
    }
    const id = result.waiter
    return new Promise<LockResult>((resolve, reject) => {
      const leave = () => {
        this.waiting.delete(id)
        this.unqueue(target, holder)
        reject(new BoardError('locked', '已停止排队'))
      }
      options.signal?.addEventListener('abort', leave, { once: true })
      this.waiting.set(id, granted => { options.signal?.removeEventListener('abort', leave); resolve(granted) })
      this.promote(target)
    })
  }

  unqueue(target: string, holder: string) {
    const removed = this.db.prepare('DELETE FROM lease_waiters WHERE board=? AND holder=?').run(target, holder).changes
    if (!removed) throw new BoardError('not-found', `你没有在 ${target} 排队`)
    this.record(holder, target, 'unqueue', null, true)
    this.changed(target)
  }

  /** Hand a free board to the first in its queue. */
  private promote(target: string) {
    const granted = transaction(this.db, () => {
      if (this.heldLease(target)) return null
      const waiter = this.queue(target)[0]
      if (!waiter) return null
      this.db.prepare('DELETE FROM lease_waiters WHERE id=?').run(waiter.id)
      return { id: waiter.id, ...this.grant(target, waiter.holder, waiter.purpose) }
    })
    if (!granted) return
    this.waiting.get(granted.id)?.({ lease: granted.lease, token: granted.token, gateToken: granted.gateToken, queued: null })
    this.waiting.delete(granted.id)
    this.emit({ type: 'lease-granted', board: target, holder: granted.lease.holder })
    this.changed(target)
    void this.syncGates(target)
  }

  /** The caller's held lease. A token proves it; humans may instead be matched by their own holder name. */
  authorize(target: string, caller: { holder: string, token?: string | null }): Lease {
    const held = this.heldLease(target)
    if (!held) throw new BoardError('locked', `请先拿 ${target} 的锁`)
    const ok = caller.token ? hash(caller.token) === held.tokenHash : isHuman(caller.holder) && caller.holder === held.holder
    if (!ok) throw new BoardError('locked', `${target} 正被 ${held.holder} 使用（${held.purpose}）`)
    const { tokenHash: _, gateToken: __, ...lease } = held
    return lease
  }

  unlock(target: string, caller: { holder: string, token?: string | null }): void {
    const lease = this.authorize(target, caller)
    this.end(lease, 'released', '主动释放')
    this.record(lease.holder, target, 'unlock', null, true)
    this.changed(target)
    this.promote(target)
    void this.syncGates(target)
  }

  /** People may take a lock from its holder with a recorded reason; the queue keeps its order. */
  steal(target: string, holder: string, reason: string, purpose = '抢锁'): LockResult {
    if (!isHuman(holder)) throw new BoardError('forbidden', '只有人可以抢锁')
    if (!reason.trim()) throw new BoardError('invalid', '抢锁必须写明原因')
    const result = transaction(this.db, () => {
      this.assertTarget(target)
      const held = this.heldLease(target)
      if (held?.holder === holder) throw new BoardError('conflict', '你已经持有这把锁')
      if (held) this.end(held, 'stolen', `${holder}：${reason}`)
      this.db.prepare('DELETE FROM lease_waiters WHERE board=? AND holder=?').run(target, holder)
      this.record(holder, target, 'steal', reason, true, held ? `原持有人 ${held.holder}` : '没有持有人')
      return { previous: held?.holder ?? null, ...this.grant(target, holder, purpose) }
    })
    if (result.previous) this.emit({ type: 'lease-stolen', board: target, from: result.previous, by: holder, reason })
    this.changed(target)
    void this.syncGates(target)
    return { lease: result.lease, token: result.token, gateToken: result.gateToken, queued: null }
  }

  private end(lease: Pick<Lease, 'id'>, status: Lease['status'], reason: string) {
    this.db.prepare('UPDATE leases SET status=?, ended_at=?, end_reason=? WHERE id=?').run(status, this.iso(), reason, lease.id)
  }

  /**
   * Make a board's serial-mux input gates follow its lock: on with the lease's gate token while it is held, so only the
   * holder (through boardd or `smtty --token`) can type, and off while it is free. Runs queue per board and read the
   * lock when they run, so the latest change wins. Failures are kept per port and shown, never ignored.
   */
  syncGates(board: string): Promise<void> {
    const run = (this.gateRuns.get(board) ?? Promise.resolve()).then(() => this.applyGates(board)).catch(() => {})
    this.gateRuns.set(board, run)
    void run.then(() => { if (this.gateRuns.get(board) === run) this.gateRuns.delete(board) })
    return run
  }

  private async applyGates(name: string) {
    const board = this.boards().find(item => item.name === name)
    if (!board) return
    const held = this.heldLease(name)
    const gate = held ? { token: held.gateToken, note: `${held.holder} 正在使用 ${name}（${held.purpose}）` } : null
    let changed = false
    for (const chip of board.chips) {
      if (!chip.alias || !chip.online) continue
      try {
        await this.options.mux.gate(chip.alias, gate)
        if (this.gateErrors.delete(chip.alias)) changed = true
      } catch (error) {
        const message = (error as Error).message
        if (this.gateErrors.get(chip.alias) !== message) {
          this.record('boardd', name, 'gate', chip.alias, false, message)
          changed = true
        }
        this.gateErrors.set(chip.alias, message)
      }
    }
    if (changed) this.changed(name)
  }

  // ---------- controls ----------

  private haConfig(): HaConfig {
    const url = this.setting('ha.url'), token = this.setting('ha.token')
    if (!url || !token) throw new BoardError('invalid', '还没有配置 Home Assistant')
    return { url, token }
  }

  private slotOf(target: string): Slot {
    const match = target.match(/^slot:(\d+)$/)
    const slot = match ? Number(match[1]) : this.board(target).slot
    if (slot === null) throw new BoardError('invalid', `${target} 没有对应的控制槽位`)
    const found = this.slots().find(item => item.slot === slot)
    if (!found) throw new BoardError('not-found', `没有槽位 ${slot}`)
    return found
  }

  /** `settle: false` returns as soon as Home Assistant answers, for a caller that waits and listens on its own. */
  private async control(target: string, caller: { holder: string, token?: string | null }, kind: 'reset' | 'fastboot', settle = true) {
    const lease = this.authorize(target, caller)
    const board = target.startsWith('slot:') ? null : target
    const lab = board ? this.labOf(board) : null
    let detail: string, act: () => Promise<string | null | void>
    if (lab) {
      detail = `${lab.id} ${lab.device}`
      act = async () => {
        if (kind === 'reset') return lab.driver.reset(lab.config, lab.device)
        // A lab that tells the download port only once it appears hands it back here.
        const port = await lab.driver.fastboot(lab.config, lab.device)
        if (!port) return null
        this.upsertChip(target, 'die0', { download_usb_path: port })
        return `下载口 ${port}`
      }
    } else {
      const slot = this.slotOf(target)
      if (kind === 'fastboot' && !slot.canFastboot) {
        throw new BoardError('invalid', slot.kind === 'script' ? `槽位 ${slot.slot} 只能复位` : `槽位 ${slot.slot} 没有 fastboot 实体`)
      }
      if (kind === 'reset' && !slot.canReset) throw new BoardError('invalid', `槽位 ${slot.slot} 没有复位实体`)
      const entity = (kind === 'reset' ? slot.resetEntity : slot.fastbootEntity)!
      detail = slot.kind === 'script' ? `槽位 ${slot.slot} 的${kind === 'reset' ? '复位' : ' fastboot '}脚本` : entity
      act = slot.kind === 'script' ? () => this.runSlotScript(slot, kind, board) : async () => {
        await this.options.ha.call(this.haConfig(), entity)
        // Otherwise a board already waiting in the boot ROM takes the next file at once and the late reset cuts it off.
        if (kind === 'fastboot' && settle) await this.sleep((this.options.bootTiming ?? BOOT_TIMING).fastbootSettleMs)
      }
    }
    let message: string | null = null
    try {
      message = (await act()) ?? null
    } catch (error) {
      this.record(lease.holder, target, kind, detail, false, (error as Error).message)
      throw error instanceof BoardError ? error : new BoardError('hardware', (error as Error).message)
    }
    this.record(lease.holder, target, kind, detail, true, message)
    if (board) this.db.prepare('UPDATE boards SET mode=? WHERE name=?').run(kind === 'reset' ? 'normal' : 'fastboot', board)
    this.changed(target)
  }

  /** Run a script slot's reset or fastboot script; a non-zero exit or a timeout fails with the end of its output. */
  private async runSlotScript(slot: Slot, kind: 'reset' | 'fastboot', board: string | null): Promise<string | null> {
    const script = (kind === 'reset' ? slot.resetScript : slot.fastbootScript)!
    const result = await this.options.hardware.scripts.run(script, { BOARDS_SLOT: String(slot.slot), BOARDS_ACTION: kind, BOARDS_BOARD: board ?? '' }, SCRIPT_TIMEOUT_MS)
    const tail = result.output.split('\n').slice(-5).join('\n').slice(-500)
    if (result.timedOut) throw new BoardError('hardware', `脚本超过 ${SCRIPT_TIMEOUT_MS / 1000} 秒没有结束，已终止${tail ? `：${tail}` : ''}`)
    if (result.code !== 0) throw new BoardError('hardware', `脚本退出码 ${result.code ?? '未知'}${tail ? `：${tail}` : ''}`)
    return tail || null
  }

  reset(target: string, caller: { holder: string, token?: string | null }) { return this.control(target, caller, 'reset') }
  fastboot(target: string, caller: { holder: string, token?: string | null }) { return this.control(target, caller, 'fastboot') }

  chip(board: string, die?: string): Chip {
    const target = this.board(board)
    const chips = target.chips
    const chip = die ? chips.find(item => item.die === die) : chips[0]
    if (!chip) throw new BoardError('not-found', die ? `${board} 没有 ${die}` : `${board} 没有登记串口`)
    // A lab's listing can be a minute old, and a board that just restarted can drop out of it for a moment: opening the
    // console asks the lab itself.
    if (target.lab) return chip
    if (!chip.alias) throw new BoardError('invalid', `${board}.${chip.die} 没有登记串口`)
    if (!chip.online) throw new BoardError('invalid', `${board}.${chip.die} 的串口 ${chip.alias} 没有绑定设备，无法使用`)
    return chip
  }

  /** Read-only console stream. Returns the session's history; the caller closes the session when done. */
  async openConsole(board: string, die?: string): Promise<MuxSession> {
    const chip = this.chip(board, die)
    const lab = this.labOf(board)
    return lab ? lab.driver.console(lab.config, lab.device, { history: true }) : this.options.mux.open(chip.alias!)
  }

  async log(board: string, die?: string, lines = 200): Promise<string[]> {
    const session = await this.openConsole(board, die)
    session.close()
    return session.history.slice(-lines)
  }

  /** Send text to a chip's console under the board's lease and optionally wait for a pattern. */
  async send(board: string, caller: { holder: string, token?: string | null }, input: { die?: string, text: string, newline?: boolean, wait?: string, timeoutMs?: number }): Promise<SendResult> {
    const lease = this.authorize(board, caller)
    const chip = this.chip(board, input.die)
    let pattern: RegExp | null = null
    if (input.wait) {
      try { pattern = new RegExp(input.wait) } catch { throw new BoardError('invalid', `等待模式不是合法正则：${input.wait}`) }
    }
    // A lab's serial reader has no input gate of boardd's; the lease is the only check there.
    const lab = this.labOf(board)
    const session = lab ? await lab.driver.console(lab.config, lab.device, { history: false }) : await this.options.mux.open(chip.alias!, this.heldLease(board)?.gateToken)
    let output = ''
    try {
      const matched = await new Promise<boolean>(resolve => {
        const timeoutMs = Math.min(input.timeoutMs ?? (pattern ? 10_000 : 1_000), 300_000)
        const timer = setTimeout(() => resolve(false), timeoutMs)
        session.onOutput(data => {
          output += data.toString('utf8')
          if (pattern?.test(stripAnsi(output))) { clearTimeout(timer); resolve(true) }
        })
        session.onClose(() => { clearTimeout(timer); resolve(false) })
        session.send(input.text + (input.newline === false ? '' : '\n'))
      })
      this.record(lease.holder, board, 'send', `${chip.die}: ${input.text.slice(0, 120)}`, true, pattern ? (matched ? '匹配' : '超时') : null)
      return { output: stripAnsi(output), matched }
    } finally { session.close() }
  }

  /** Load one of boardd's own firmware files into a chip's RAM through its download port. Never flashes. */
  async stage(board: string, caller: { holder: string, token?: string | null }, input: { die?: string, firmware: string }): Promise<string> {
    const lease = this.authorize(board, caller)
    const target = this.board(board)
    const chip = input.die ? target.chips.find(item => item.die === input.die) : target.chips[0]
    if (!chip?.downloadUsbPath) throw new BoardError('invalid', `${board} 没有登记下载口`)
    const image = this.verifiedFirmware(input.firmware, target.soc)
    const port = this.downloadPort(board)
    try {
      const output = await port.stage(chip.downloadUsbPath, image)
      this.record(lease.holder, board, 'stage', `${chip.die}: ${image.purpose} ${image.sha256.slice(0, 12)}`, true)
      this.db.prepare(`UPDATE boards SET mode='unknown' WHERE name=?`).run(board)
      this.changed(board)
      return output
    } catch (error) {
      this.record(lease.holder, board, 'stage', `${chip.die}: ${image.purpose}`, false, (error as Error).message)
      throw new BoardError('hardware', (error as Error).message)
    }
  }

  /**
   * Boot a chip from RAM through its download port: stage each file in order
   * (FSBL, U-Boot/OpenSBI, kernel), waiting for the port to come back between
   * them. Never flashes.
   */
  async boot(board: string, caller: { holder: string, token?: string | null }, input: { die?: string, files: string[] }): Promise<string> {
    const lease = this.authorize(board, caller)
    const target = this.board(board)
    const chip = input.die ? target.chips.find(item => item.die === input.die) : target.chips[0]
    if (!chip?.downloadUsbPath) throw new BoardError('invalid', `${board} 没有登记下载口`)
    if (!input.files.length) throw new BoardError('invalid', '要按顺序给出启动文件，例如 fsbl u-boot-opensbi /path/Image.itb')
    // A bare name is one of boardd's own firmware files; anything else is a file on this machine.
    const files = input.files.map(path => {
      if (FIRMWARE_NAME.test(path)) { const firmware = this.verifiedFirmware(path, target.soc); return { path: firmware.path, sha256: firmware.sha256 } }
      if (!isAbsolute(path)) throw new BoardError('invalid', `启动文件要用绝对路径或 boardd 自带固件的名字：${path}`)
      let data: Buffer
      try { data = readFileSync(path) } catch { throw new BoardError('invalid', `读不到启动文件：${path}`) }
      if (!data.length) throw new BoardError('invalid', `启动文件是空的：${path}`)
      return { path, sha256: createHash('sha256').update(data).digest('hex') }
    })
    const timing = this.options.bootTiming ?? BOOT_TIMING
    const port = this.downloadPort(board)
    const outputs: string[] = []
    for (const [index, file] of files.entries()) {
      const step = `${chip.die}: ${index + 1}/${files.length} ${basename(file.path)} ${file.sha256.slice(0, 12)}`
      try {
        if (index) await this.portBack(port, chip.downloadUsbPath, index === 1 ? timing.firstMs : timing.laterMs, timing)
        outputs.push(await port.stage(chip.downloadUsbPath, file, BOOT_STAGE_TIMEOUT_MS))
        this.record(lease.holder, board, 'boot', step, true, file.path)
      } catch (error) {
        this.record(lease.holder, board, 'boot', step, false, (error as Error).message)
        this.db.prepare(`UPDATE boards SET mode='unknown' WHERE name=?`).run(board)
        this.changed(board)
        throw new BoardError('hardware', `第 ${index + 1} 个文件 ${file.path} 没有加载成功：${(error as Error).message}`)
      }
    }
    this.db.prepare(`UPDATE boards SET mode='unknown' WHERE name=?`).run(board)
    this.changed(board)
    return [...files.map((file, index) => `${index + 1}. ${file.path} sha256 ${file.sha256}`), ...outputs].join('\n')
  }

  /** Wait for the stage just started to bring the download port back. */
  private async portBack(port: DownloadPort, usbPath: string, settleMs: number, timing: BootTiming): Promise<void> {
    await this.sleep(settleMs)
    for (let waited = 0; ; waited += timing.pollMs) {
      if (await port.present(usbPath)) return
      if (waited >= timing.waitMs) throw new Error(`下载口 ${usbPath} 在 ${(settleMs + timing.waitMs) / 1000} 秒内没有重新出现，上一个文件可能没有起来；看串口日志`)
      await this.sleep(timing.pollMs)
    }
  }

  private downloadPort(board: string): DownloadPort {
    const lab = this.labOf(board)
    if (lab) return { stage: (usbPath, file, timeoutMs) => lab.driver.stage(lab.config, usbPath, file, timeoutMs), present: usbPath => lab.driver.present(lab.config, usbPath) }
    const hardware = this.options.hardware
    return {
      stage: (usbPath, file, timeoutMs) => stageAndContinue(hardware.fastboot, usbPath, file.path, timeoutMs),
      present: async usbPath => hardware.usb().some(device => device.path === usbPath),
    }
  }

  /** A firmware file by purpose, for the board's SoC when it is known, whose content still matches firmware.json. */
  private verifiedFirmware(purpose: string, soc: string | null): Firmware {
    const matches = this.firmware().filter(item => item.purpose === purpose && (!soc || item.soc === soc))
    if (!matches.length) throw new BoardError('not-found', `boardd 没有自带${soc ? ` ${soc} 的` : ''}固件 ${purpose}（见仓库的 firmware/firmware.json）`)
    if (matches.length > 1) throw new BoardError('invalid', `有多个 SoC 的固件叫 ${purpose}，这块板的 SoC 未知`)
    const image = matches[0]!
    let actual: string
    try { actual = createHash('sha256').update(readFileSync(image.path)).digest('hex') }
    catch { throw new BoardError('invalid', `固件文件不可读：${image.path}`) }
    if (actual !== image.sha256) throw new BoardError('invalid', `固件 ${image.path} 的 sha256 与 firmware.json 不符，拒绝加载`)
    return image
  }

  // ---------- Home Assistant ----------

  private setting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)
    return row ? String(row.value) : null
  }

  private setSetting(key: string, value: string | null) {
    if (value === null) this.db.prepare('DELETE FROM settings WHERE key=?').run(key)
    else this.db.prepare('INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
  }

  haSettings(): HaSettings {
    const ok = this.setting('ha.verify_ok')
    return {
      url: this.setting('ha.url'), hasToken: !!this.setting('ha.token'), verifiedAt: this.setting('ha.verified_at'),
      verifyOk: ok === null ? null : ok === '1', verifyMessage: this.setting('ha.verify_message'),
    }
  }

  /** Save HA access. The token is write-only: omit it to keep the stored one. */
  async configureHa(actor: string, input: { url: string, token?: string | null }): Promise<HaSettings> {
    let url: URL
    try { url = new URL(input.url) } catch { throw new BoardError('invalid', 'Home Assistant 地址不合法') }
    if (!/^https?:$/.test(url.protocol)) throw new BoardError('invalid', 'Home Assistant 地址须是 http 或 https')
    this.setSetting('ha.url', url.toString().replace(/\/$/, ''))
    if (input.token) this.setSetting('ha.token', input.token.trim())
    this.record(actor, null, 'ha-config', url.origin, true, input.token ? '已更新令牌' : null)
    return this.testHa(actor)
  }

  async testHa(actor: string): Promise<HaSettings> {
    let ok = true, message: string
    try { message = await this.options.ha.verify(this.haConfig()) }
    catch (error) { ok = false; message = (error as Error).message }
    this.setSetting('ha.verified_at', this.iso())
    this.setSetting('ha.verify_ok', ok ? '1' : '0')
    this.setSetting('ha.verify_message', message)
    this.record(actor, null, 'ha-test', null, ok, message)
    if (ok) await this.syncSlots(actor).catch(() => {})
    this.changed(null)
    return this.haSettings()
  }

  /**
   * Keep the slot table in step with Home Assistant. People never pick entities: `board_N_reset` / `board_N_fastboot_mode`
   * entities are grouped into slot N. An empty answer changes nothing, and a slot that vanished from HA is kept while a
   * board still sits in it.
   */
  async syncSlots(actor = 'boardd'): Promise<void> {
    let found: HaDiscovery
    try { found = await this.options.ha.discover(this.haConfig()) }
    catch (error) { throw new BoardError('hardware', (error as Error).message) }
    if (!found.slots.length) return
    const before = JSON.stringify(this.slots().map(slot => [slot.slot, slot.resetEntity, slot.fastbootEntity]))
    transaction(this.db, () => {
      for (const slot of found.slots) {
        // A script slot keeps its number even if the controller later offers the same one.
        this.db.prepare(`INSERT INTO slots(slot, reset_entity, fastboot_entity, device, confirmed_at) VALUES(?,?,?,?,?)
          ON CONFLICT(slot) DO UPDATE SET reset_entity=excluded.reset_entity, fastboot_entity=excluded.fastboot_entity, device=excluded.device WHERE slots.kind='ha'`)
          .run(slot.slot, slot.resetEntity, slot.fastbootEntity, slot.device, this.iso())
      }
      const keep = found.slots.map(slot => slot.slot)
      this.db.prepare(`DELETE FROM slots WHERE kind='ha' AND slot NOT IN (${keep.map(() => '?').join(',')}) AND slot NOT IN (SELECT slot FROM boards WHERE slot IS NOT NULL)`).run(...keep)
    })
    const after = JSON.stringify(this.slots().map(slot => [slot.slot, slot.resetEntity, slot.fastbootEntity]))
    if (after !== before) { this.record(actor, null, 'slots-sync', `${found.slots.length} 个槽位`, true); this.changed(null) }
  }

  confirmSlots(actor: string, slots: Array<{ slot: number, resetEntity: string | null, fastbootEntity: string | null, device?: string | null }>) {
    transaction(this.db, () => {
      for (const slot of slots) {
        if (!Number.isInteger(slot.slot) || slot.slot < 0) throw new BoardError('invalid', `槽位号不合法：${slot.slot}`)
        for (const entity of [slot.resetEntity, slot.fastbootEntity]) {
          if (entity && !/^(switch|button)\.[a-z0-9_]+$/.test(entity)) throw new BoardError('invalid', `实体名不合法：${entity}`)
        }
        this.db.prepare(`INSERT INTO slots(slot, reset_entity, fastboot_entity, device, confirmed_at) VALUES(?,?,?,?,?)
          ON CONFLICT(slot) DO UPDATE SET reset_entity=excluded.reset_entity, fastboot_entity=excluded.fastboot_entity, device=excluded.device, confirmed_at=excluded.confirmed_at`)
          .run(slot.slot, slot.resetEntity, slot.fastbootEntity, slot.device ?? null, this.iso())
      }
      this.record(actor, null, 'slots-confirm', slots.map(slot => slot.slot).join(','), true)
    })
    this.changed(null)
  }

  /**
   * Create or change a slot driven by scripts. The reset script is required; without a fastboot script the slot can
   * only reset its board. Numbers the Home Assistant controller uses are not available.
   */
  saveScriptSlot(actor: string, input: { slot: number, label?: string | null, resetScript: string, fastbootScript?: string | null }): Slot {
    const slot = input.slot
    if (!Number.isInteger(slot) || slot < 0 || slot > 9999) throw new BoardError('invalid', `槽位号不合法：${slot}`)
    const resetScript = input.resetScript.replace(/\r\n/g, '\n')
    const fastbootScript = (input.fastbootScript ?? '').replace(/\r\n/g, '\n')
    const label = input.label?.trim() || null
    if (!resetScript.trim()) throw new BoardError('invalid', '复位脚本不能为空')
    if (resetScript.length > SCRIPT_LIMIT || fastbootScript.length > SCRIPT_LIMIT) throw new BoardError('invalid', '脚本太长（最多 64 KB）')
    if (label && label.length > 60) throw new BoardError('invalid', '名称太长（最多 60 个字符）')
    const existing = this.db.prepare('SELECT kind FROM slots WHERE slot=?').get(slot)
    if (existing && existing.kind !== 'script') throw new BoardError('conflict', `槽位 ${slot} 属于 Home Assistant 控制器，换一个槽位号`)
    this.db.prepare(`INSERT INTO slots(slot, kind, label, reset_script, fastboot_script, confirmed_at) VALUES(?,'script',?,?,?,?)
      ON CONFLICT(slot) DO UPDATE SET label=excluded.label, reset_script=excluded.reset_script, fastboot_script=excluded.fastboot_script, confirmed_at=excluded.confirmed_at`)
      .run(slot, label, resetScript, fastbootScript.trim() ? fastbootScript : null, this.iso())
    this.record(actor, null, 'slot-save', `槽位 ${slot}${label ? `（${label}）` : ''}${fastbootScript.trim() ? '' : '，只能复位'}`, true)
    this.changed(null)
    return this.slots().find(item => item.slot === slot)!
  }

  removeScriptSlot(actor: string, slot: number) {
    const row = this.db.prepare('SELECT kind FROM slots WHERE slot=?').get(slot)
    if (!row) throw new BoardError('not-found', `没有槽位 ${slot}`)
    if (row.kind !== 'script') throw new BoardError('invalid', `槽位 ${slot} 来自 Home Assistant，不能在这里删除`)
    const board = this.db.prepare('SELECT name FROM boards WHERE slot=?').get(slot)
    if (board) throw new BoardError('conflict', `槽位 ${slot} 上还有板子 ${board.name}，先移除板子`)
    if (this.heldLease(slotKey(slot))) throw new BoardError('locked', `槽位 ${slot} 正被使用`)
    this.db.prepare('DELETE FROM slots WHERE slot=?').run(slot)
    this.record(actor, null, 'slot-remove', `槽位 ${slot}`, true)
    this.changed(null)
  }

  // ---------- remote labs ----------

  private labDriver(id: string): LabDriver {
    const driver = this.options.labs?.[id]
    if (!driver) throw new BoardError('not-found', `没有实验室 ${id}`)
    return driver
  }

  private labConfig(id: string): LabConfig {
    const get = (key: string) => this.setting(`lab.${id}.${key}`)
    if (get('enabled') !== '1') throw new BoardError('invalid', `实验室 ${id} 没有开启`)
    const url = get('url'), username = get('username'), password = get('password')
    if (!url || !username || !password) throw new BoardError('invalid', `实验室 ${id} 的地址、账号或密码没有填`)
    return { url, username, password, jump: get('jump') ?? this.labDriver(id).defaultJump(new URL(url)) }
  }

  /** The lab a board sits in, with what reaching it takes; null for a board on this machine. */
  private labOf(board: string): { id: string, device: string, driver: LabDriver, config: LabConfig } | null {
    const row = this.db.prepare('SELECT lab, lab_device FROM boards WHERE name=?').get(board)
    if (!row?.lab) return null
    const id = String(row.lab)
    return { id, device: String(row.lab_device), driver: this.labDriver(id), config: this.labConfig(id) }
  }

  labSettings(): LabSettings[] {
    return Object.entries(this.options.labs ?? {}).map(([id, driver]) => {
      const get = (key: string) => this.setting(`lab.${id}.${key}`)
      const flag = (key: string) => { const value = get(key); return value === null ? null : value === '1' }
      const url = get('url')
      return {
        id, kind: driver.kind, enabled: get('enabled') === '1', url, username: get('username'), hasPassword: !!get('password'),
        jump: get('jump'), defaultJump: url ? driver.defaultJump(new URL(url)) : null, devices: get('devices'),
        verifiedAt: get('verified_at'), verifyOk: flag('verify_ok'), verifyMessage: get('verify_message'),
        syncedAt: get('synced_at'), syncOk: flag('sync_ok'), syncMessage: get('sync_message'),
      }
    })
  }

  /**
   * Save a lab's access and whether boardd uses it. The password is write-only: omit it to keep the stored one. Enabling
   * checks the access and lists the lab's boards; disabling takes them off the list, once nobody holds any of them.
   */
  async configureLab(actor: string, id: string, input: { enabled: boolean, url?: string | null, username?: string | null, password?: string | null, jump?: string | null, devices?: string | null }): Promise<LabSettings> {
    this.labDriver(id)
    const key = (name: string) => `lab.${id}.${name}`
    let url: string | null = null
    if (input.url?.trim()) {
      let parsed: URL
      try { parsed = new URL(input.url.trim()) } catch { throw new BoardError('invalid', '实验室地址不合法') }
      if (!/^https?:$/.test(parsed.protocol)) throw new BoardError('invalid', '实验室地址须是 http 或 https')
      url = parsed.toString().replace(/\/$/, '')
    }
    const jump = input.jump?.trim() || null
    if (jump && !JUMP.test(jump)) throw new BoardError('invalid', `跳板机格式不对：${jump}（要写成 user@host 或 user@host:port）`)
    const devices = (input.devices ?? '').split(/[\s,]+/).filter(Boolean)
    const bad = devices.find(item => !DEVICE_PATTERN.test(item))
    if (bad) throw new BoardError('invalid', `设备范围里有不合法的名字：${bad}（只能用字母、数字、点、横线、下划线和 *）`)
    const username = input.username?.trim() || null
    const password = input.password || this.setting(key('password'))
    if (input.enabled && (!url || !username || !password)) throw new BoardError('invalid', '开启实验室要先填地址、账号和密码')
    if (!input.enabled) {
      const held = this.db.prepare(`SELECT leases.board, leases.holder FROM leases JOIN boards ON boards.name = leases.board WHERE boards.lab=? AND leases.status='held' LIMIT 1`).get(id)
      if (held) throw new BoardError('locked', `${String(held.board)} 正被 ${String(held.holder)} 使用，放锁以后才能关掉实验室`)
    }
    transaction(this.db, () => {
      this.setSetting(key('enabled'), input.enabled ? '1' : '0')
      this.setSetting(key('url'), url)
      this.setSetting(key('username'), username)
      if (input.password) this.setSetting(key('password'), input.password)
      this.setSetting(key('jump'), jump)
      this.setSetting(key('devices'), devices.length ? devices.join(' ') : null)
      if (!input.enabled) this.dropLabBoards(id, () => true)
    })
    this.record(actor, null, 'lab-config', `${id}${input.enabled ? ' 开启' : ' 关闭'}`, true, input.password ? '已更新密码' : null)
    this.changed(null)
    if (input.enabled) return this.testLab(actor, id)
    return this.labSettings().find(lab => lab.id === id)!
  }

  /** Check a lab's access, then list its boards again. */
  async testLab(actor: string, id: string): Promise<LabSettings> {
    const config = this.labConfig(id)
    let ok = true, message: string
    try { message = await this.labDriver(id).verify(config) }
    catch (error) { ok = false; message = (error as Error).message }
    this.setSetting(`lab.${id}.verified_at`, this.iso())
    this.setSetting(`lab.${id}.verify_ok`, ok ? '1' : '0')
    this.setSetting(`lab.${id}.verify_message`, message)
    this.record(actor, null, 'lab-test', id, ok, message)
    // A lab whose jump host is out of reach still has power and consoles.
    await this.syncLab(id, actor).catch(() => {})
    this.changed(null)
    return this.labSettings().find(lab => lab.id === id)!
  }

  /** List every enabled lab's boards again; a lab that cannot be read keeps what it had. */
  async syncLabs(): Promise<void> {
    for (const lab of this.labSettings().filter(item => item.enabled)) await this.syncLab(lab.id).catch(() => {})
  }

  /**
   * List a lab's boards: each one in its device range becomes the board `<lab>-<device>` here, with the lab's serial
   * port and download port as its chip. Boards that left the range or the lab go, unless someone holds them.
   */
  async syncLab(id: string, actor = 'boardd'): Promise<void> {
    const config = this.labConfig(id)
    const range = this.setting(`lab.${id}.devices`)
    const status = (ok: boolean, message: string) => {
      this.setSetting(`lab.${id}.synced_at`, this.iso())
      this.setSetting(`lab.${id}.sync_ok`, ok ? '1' : '0')
      this.setSetting(`lab.${id}.sync_message`, message)
    }
    let all: LabDevice[]
    try { all = await this.labDriver(id).devices(config) }
    catch (error) {
      status(false, (error as Error).message)
      this.changed(null)
      throw new BoardError('hardware', (error as Error).message)
    }
    const devices = all.filter(device => deviceFilter(range)(device.name))
    const listing = () => JSON.stringify(this.db.prepare('SELECT boards.name, chips.serial_path, chips.download_usb_path FROM boards LEFT JOIN chips ON chips.board = boards.name WHERE boards.lab=? ORDER BY boards.name').all(id))
    const known = () => JSON.stringify([...this.labDevices].filter(([name]) => name.startsWith(`${id}-`)))
    const before = listing(), beforeStatus = known()
    const seen = this.iso()
    const listed = new Set<string>(), clashes: string[] = []
    let kept: string[] = []
    transaction(this.db, () => {
      for (const device of devices) {
        const name = `${id}-${device.name}`
        const existing = this.db.prepare('SELECT lab, lab_device FROM boards WHERE name=?').get(name)
        if (!BOARD_NAME.test(name) || (existing && (existing.lab !== id || existing.lab_device !== device.name))) { clashes.push(device.name); continue }
        listed.add(name)
        const soc = device.model && /^k\d+$/i.test(device.model) ? device.model.toLowerCase() : null
        this.db.prepare(`INSERT INTO boards(name, product, soc, source, lab, lab_device, last_seen_at) VALUES(?,?,?,'lab',?,?,?)
          ON CONFLICT(name) DO UPDATE SET product=COALESCE(excluded.product, boards.product), soc=COALESCE(excluded.soc, boards.soc), last_seen_at=excluded.last_seen_at`)
          .run(name, device.model, soc, id, device.name, seen)
        // A download port learned when the board last entered download mode stays until the lab names another.
        this.upsertChip(name, 'die0', { serial_path: device.serialPort, last_seen_at: seen, ...(device.downloadUsbPath ? { download_usb_path: device.downloadUsbPath } : {}) })
      }
      kept = this.dropLabBoards(id, name => !listed.has(name))
    })
    for (const name of [...this.labDevices.keys()]) if (name.startsWith(`${id}-`) && !listed.has(name)) this.labDevices.delete(name)
    for (const device of devices) if (listed.has(`${id}-${device.name}`)) this.labDevices.set(`${id}-${device.name}`, device)
    const message = [
      `列出 ${listed.size} 块（实验室共 ${all.length} 台${range ? `，范围 ${range}` : ''}）`,
      ...(clashes.length ? [`和已有的板子重名，没有列出：${clashes.join(', ')}`] : []),
      ...(kept.length ? [`${kept.join(', ')} 已经不在范围里，有人在用，先留着`] : []),
    ].join('；')
    status(true, message)
    if (listing() !== before) this.record(actor, null, 'lab-sync', id, true, message)
    if (listing() !== before || known() !== beforeStatus) this.changed(null)
  }

  /** Take a lab's boards that `drop` names off the list, except held ones, which are returned. */
  private dropLabBoards(id: string, drop: (name: string) => boolean): string[] {
    const kept: string[] = []
    for (const row of this.db.prepare('SELECT name FROM boards WHERE lab=?').all(id)) {
      const name = String(row.name)
      if (!drop(name)) continue
      if (this.db.prepare(`SELECT 1 FROM leases WHERE board=? AND status='held'`).get(name)) { kept.push(name); continue }
      this.db.prepare('DELETE FROM lease_waiters WHERE board=?').run(name)
      this.db.prepare('DELETE FROM boards WHERE name=?').run(name)
      this.labDevices.delete(name)
    }
    return kept
  }

  // ---------- inventory ----------

  /** Register a board by hand; its chips' serial ports and download ports are whatever the person states. */
  addBoard(actor: string, input: { name: string, slot?: number | null, product?: string | null, chips?: Array<{ die?: string, serialPath?: string | null, alias?: string | null, downloadUsbPath?: string | null, usbId?: string | null }> }) {
    if (!BOARD_NAME.test(input.name)) throw new BoardError('invalid', `板名不合法：${input.name}`)
    transaction(this.db, () => {
      if (this.db.prepare('SELECT 1 FROM boards WHERE name=?').get(input.name)) throw new BoardError('conflict', `已有板子 ${input.name}`)
      if (input.slot != null && this.db.prepare('SELECT 1 FROM boards WHERE slot=?').get(input.slot)) throw new BoardError('conflict', `槽位 ${input.slot} 已有别的板子`)
      const product = input.product ?? null
      this.db.prepare(`INSERT INTO boards(name, slot, product, soc, source) VALUES(?,?,?,?,'manual')`).run(input.name, input.slot ?? null, product, product ? socOf(product) : null)
      ;(input.chips ?? []).forEach((chip, index) => {
        this.db.prepare('INSERT INTO chips(board, die, serial_path, alias, download_usb_path, usb_id) VALUES(?,?,?,?,?,?)')
          .run(input.name, chip.die ?? `die${index}`, chip.serialPath ?? null, chip.alias ?? null, chip.downloadUsbPath ?? null, chip.usbId ?? null)
      })
      this.record(actor, input.name, 'add', input.slot != null ? `槽位 ${input.slot}` : null, true)
    })
    this.changed(input.name)
  }

  removeBoard(actor: string, name: string) {
    const board = this.board(name)
    if (board.lab) throw new BoardError('invalid', `${name} 跟着实验室 ${board.lab.id} 的设置走：改设备范围或关掉实验室`)
    if (board.lease) throw new BoardError('locked', `${name} 正被 ${board.lease.holder} 使用`)
    this.db.prepare('DELETE FROM boards WHERE name=?').run(name)
    this.record(actor, name, 'remove', null, true)
    this.changed(name)
  }

  exportToml(): string {
    const boards: TomlTable = {}
    // Lab boards are listed from their lab, not kept by hand.
    for (const board of this.boards().filter(item => !item.lab)) {
      const table: TomlTable = {}
      if (board.slot !== null) table.slot = board.slot
      if (board.serial) table.board_serial = board.serial
      if (board.product) table.product_name = board.product
      if (board.baseMac) table.base_mac = board.baseMac
      for (const chip of board.chips) {
        const hints: TomlTable = { baud: chip.baud }
        if (chip.alias) hints.serial_alias = chip.alias
        if (chip.serialPath) hints.serial_device = chip.serialPath
        if (chip.downloadUsbPath) hints.download_usb_path = chip.downloadUsbPath
        if (chip.usbId) hints.usb_vid_pid = chip.usbId
        table[chip.die] = hints
      }
      boards[board.name] = table
    }
    return `# Exported by boardd at ${this.iso()}. boardd's database is the authority.\nschema_version = 2\n\n${formatToml({ boards })}`
  }

  updateBoard(actor: string, name: string, patch: { notes?: string | null, slot?: number | null }) {
    if (this.board(name).lab && patch.slot !== undefined) throw new BoardError('invalid', `${name} 在实验室里，没有控制槽位`)
    if (patch.notes !== undefined) this.db.prepare('UPDATE boards SET notes=? WHERE name=?').run(patch.notes, name)
    if (patch.slot !== undefined) {
      try { this.db.prepare('UPDATE boards SET slot=? WHERE name=?').run(patch.slot, name) }
      catch { throw new BoardError('conflict', `槽位 ${patch.slot} 已有别的板子`) }
    }
    this.record(actor, name, 'edit', JSON.stringify(patch), true)
    this.changed(name)
  }

  // ---------- scan ----------

  scan(id: string): Scan {
    const row = this.db.prepare('SELECT * FROM scans WHERE id=?').get(id)
    if (!row) throw new BoardError('not-found', `没有这次扫描：${id}`)
    return {
      id: String(row.id), holder: String(row.holder), scope: JSON.parse(String(row.scope)), status: row.status as Scan['status'],
      startedAt: String(row.started_at), finishedAt: str(row.finished_at), message: str(row.message), result: JSON.parse(String(row.result)),
      steps: this.db.prepare('SELECT * FROM scan_steps WHERE scan_id=? ORDER BY seq').all(id).map(step => ({
        seq: Number(step.seq), at: String(step.at), slot: step.slot === null ? null : Number(step.slot), kind: String(step.kind),
        summary: String(step.summary), data: JSON.parse(String(step.data)),
      })),
    }
  }

  latestScan(): Scan | null {
    const row = this.db.prepare('SELECT id FROM scans ORDER BY started_at DESC LIMIT 1').get()
    return row ? this.scan(String(row.id)) : null
  }

  evidence(scanId: string): Array<{ slot: number | null, kind: string, label: string, body: string, at: string }> {
    return this.db.prepare('SELECT * FROM scan_evidence WHERE scan_id=? ORDER BY id').all(scanId).map(row => ({
      slot: row.slot === null ? null : Number(row.slot), kind: String(row.kind), label: String(row.label), body: String(row.body), at: String(row.at),
    }))
  }

  /**
   * Start a scan. Requires explicit confirmation and every target lease up front; it runs in the background. The slot
   * table is refreshed from Home Assistant first; if HA cannot be read, the stored slots are used.
   */
  async startScan(holder: string, input: { slots?: number[], boards?: string[], confirmed: boolean }): Promise<Scan> {
    if (!input.confirmed) throw new BoardError('forbidden', '扫描会复位并切换板子，需要用户确认')
    if (this.scanAbort) throw new BoardError('conflict', '已有扫描在进行')
    if (this.setting('ha.url') && this.setting('ha.token')) await this.syncSlots(holder).catch(() => {})
    const known = this.slots()
    let scope = input.slots?.length ? input.slots : known.map(slot => slot.slot)
    if (input.boards?.length) scope = input.boards.map(name => this.slotOf(name).slot)
    scope = [...new Set(scope)].sort((a, b) => a - b)
    for (const slot of scope) {
      const found = known.find(item => item.slot === slot)
      if (!found) throw new BoardError('not-found', `没有槽位 ${slot}`)
      if (!found.canFastboot && !found.canReset) throw new BoardError('invalid', `槽位 ${slot} 既不能复位也不能 fastboot`)
    }
    if (!scope.length) throw new BoardError('invalid', '没有可扫描的槽位')
    if (scope.some(slot => known.find(item => item.slot === slot)!.kind === 'ha')) this.haConfig()
    const targets = scope.map(slot => {
      const board = this.db.prepare('SELECT name FROM boards WHERE slot=?').get(slot)
      return { slot, board: board ? String(board.name) : null, target: board ? String(board.name) : slotKey(slot) }
    })

    const id = randomUUID()
    const tokens = transaction(this.db, () => {
      // A scan stops every serial-mux daemon and switches boards around, so anyone holding any board, the scanner included, rules it out.
      const held = this.db.prepare(`SELECT board, holder FROM leases WHERE status='held' ORDER BY started_at LIMIT 1`).get()
      if (held) throw new BoardError('locked', `${String(held.board)} 正被 ${String(held.holder)} 使用，扫描未开始`)
      this.db.prepare('INSERT INTO scans(id, holder, scope, status, started_at) VALUES(?,?,?,?,?)').run(id, holder, JSON.stringify(scope), 'running', this.iso())
      return targets.map(({ target }) => ({ target, token: this.grant(target, holder, `扫描 ${id.slice(0, 8)}`).token, own: false }))
    })
    this.scanAbort = { id, cancelled: false }
    this.record(holder, null, 'scan', `槽位 ${scope.join(', ')}`, true)
    this.changed(null)
    void this.executeScan(id, holder, targets, tokens)
    return this.scan(id)
  }

  cancelScan(holder: string, id: string) {
    if (this.scanAbort?.id !== id) throw new BoardError('conflict', '这次扫描已经结束')
    this.scanAbort.cancelled = true
    this.record(holder, null, 'scan-cancel', id, true)
  }

  private async executeScan(id: string, holder: string, targets: Array<{ slot: number, board: string | null, target: string }>, tokens: Array<{ target: string, token: string | null, own: boolean }>) {
    let seq = 0
    const caller = (target: string) => ({ holder, token: tokens.find(item => item.target === target)?.token ?? null })
    const targetOf = (slot: number) => targets.find(item => item.slot === slot)!.target
    const publish = () => this.emit({ type: 'scan', scan: this.scan(id) })
    const report = {
      step: (slot: number | null, kind: string, summary: string, data: unknown = null) => {
        this.db.prepare('INSERT INTO scan_steps(scan_id, seq, at, slot, kind, summary, data) VALUES(?,?,?,?,?,?,?)').run(id, ++seq, this.iso(), slot, kind, summary, JSON.stringify(data ?? null))
        publish()
      },
      evidence: (slot: number | null, kind: string, label: string, body: string) => {
        this.db.prepare('INSERT INTO scan_evidence(scan_id, slot, kind, label, body, at) VALUES(?,?,?,?,?,?)').run(id, slot, kind, label, stripAnsi(body), this.iso())
      },
      cancelled: () => this.scanAbort?.cancelled ?? false,
    }
    let minorPath: string | null = null
    if (this.firmware().some(item => item.soc === 'k3' && item.purpose === 'minor-board-info')) {
      try { minorPath = this.verifiedFirmware('minor-board-info', 'k3').path }
      catch (error) { report.step(null, 'prepare', (error as Error).message) }
    }
    const hw = this.options.hardware
    let status: Scan['status'] = 'done', message: string | null = null, rows: ScanRow[] = []
    const listeners = new Set<string>()
    try {
      rows = await runScan({
        serialAdapters: () => hw.serialAdapters(),
        stopMux: () => this.options.mux.stopAll(),
        listen: async adapter => { const alias = await this.options.mux.start(adapter, `port-${adapterPortName(adapter, hw.serialAdapters())}`); listeners.add(alias); return alias },
        watch: async (alias, onData) => {
          const session = await this.options.mux.open(alias)
          session.onOutput(data => onData(data.toString('utf8')))
          return () => session.close()
        },
        // The scan listens for windowMs after every press, longer than the late reset.
        fastboot: slot => this.control(targetOf(slot), caller(targetOf(slot)), 'fastboot', false),
        reset: slot => this.control(targetOf(slot), caller(targetOf(slot)), 'reset'),
        usb: () => hw.usb(),
        stage: usbPath => stageAndContinue(hw.fastboot, usbPath, minorPath!),
        sleep: this.sleep,
        now: this.now,
      }, targets.map(({ slot, board }) => ({ slot, board, fastboot: this.slots().find(item => item.slot === slot)!.canFastboot })), minorPath, report, this.options.scanTiming)
      this.propose(id, rows)
    } catch (error) {
      status = error instanceof ScanCancelled ? 'cancelled' : 'failed'
      message = (error as Error).message
    } finally {
      this.scanAbort = null
      for (const failure of await this.restoreConsoles()) report.step(null, 'console', failure)
      // Listeners no registered board took over go away; applying a proposal starts its board's own daemon.
      const claimed = new Set(this.boards().flatMap(board => board.chips.map(chip => chip.alias)))
      for (const alias of listeners) {
        if (claimed.has(alias)) continue
        try { await this.options.mux.stop(alias) } catch (error) { report.step(null, 'console', `没能停掉临时监听 ${alias}：${(error as Error).message}`) }
      }
      this.db.prepare('UPDATE scans SET status=?, finished_at=?, message=?, result=? WHERE id=?').run(status, this.iso(), message, JSON.stringify(rows), id)
      for (const { target, token, own } of tokens) {
        if (own || !token) continue
        try { this.unlock(target, { holder, token }) } catch {}
      }
      this.record(holder, null, 'scan-end', id, status === 'done', message)
      publish()
      this.changed(null)
    }
  }

  /**
   * Run each registered serial port's daemon under its board's alias again, then gate it as its lock says. A scan
   * listens on every port under `port-*` names and daemons do not outlive a reboot or keep their gate across a restart.
   */
  async restoreConsoles(): Promise<string[]> {
    const adapters = this.options.hardware.serialAdapters()
    const failures: string[] = []
    for (const board of this.boards()) failures.push(...await this.bindConsoles(board.name, adapters))
    return failures
  }

  /**
   * Run each of a board's serial ports under the name it should have — the board's name, or `<board>-<die>` once it has
   * several chips — and record that name. Names the board no longer uses are stopped, and the ports are gated as the
   * lock says. Returns what could not be started.
   */
  private async bindConsoles(name: string, adapters = this.options.hardware.serialAdapters()): Promise<string[]> {
    const board = this.boards().find(item => item.name === name)
    if (!board || board.lab) return []
    const failures: string[] = []
    const wanted = new Set<string>()
    for (const chip of board.chips) {
      if (!chip.serialPath) continue
      const alias = board.chips.length > 1 ? `${name}-${chip.die}` : name
      wanted.add(alias)
      if (chip.alias !== alias) this.db.prepare('UPDATE chips SET alias=? WHERE board=? AND die=?').run(alias, name, chip.die)
      const adapter = adapters.find(item => item.link === chip.serialPath)
      if (!adapter) continue
      try { await this.options.mux.start(adapter, alias) }
      catch (error) {
        const message = `${name}.${chip.die} 的串口 ${alias} 没能启动：${(error as Error).message}`
        failures.push(message)
        this.record('boardd', name, 'console-restore', alias, false, message)
      }
    }
    for (const chip of board.chips) {
      if (!chip.alias || wanted.has(chip.alias)) continue
      try { await this.options.mux.stop(chip.alias) } catch {}
    }
    await this.syncGates(name)
    return failures
  }

  private propose(scanId: string, rows: ScanRow[]) {
    const insert = (kind: ProposalKind, board: string | null, slot: number, summary: string, change: Record<string, unknown>) =>
      this.db.prepare(`INSERT INTO proposals(id, scan_id, kind, board, slot, summary, change, status) VALUES(?,?,?,?,?,?,?,'pending')`)
        .run(randomUUID(), scanId, kind, board, slot, summary, JSON.stringify(change))
    this.db.prepare(`UPDATE proposals SET status='rejected' WHERE status='pending'`).run()
    const resetOnly = new Set(this.slots().filter(slot => !slot.canFastboot).map(slot => slot.slot))
    for (const row of rows) {
      if (!row.chips.length) continue
      const board = row.board ? this.board(row.board) : null
      const product = row.chips.find(chip => chip.product)?.product ?? null
      if (!board) {
        // A board is only registered once its product name is read; its name comes from that product. A slot that can
        // only reset never reads one, so the person applying the proposal names the board.
        if (product) insert('new-board', null, row.slot, `槽位 ${row.slot} 发现新板子（${product}）`, { name: boardName(product, row.slot), product, chips: row.chips })
        else if (resetOnly.has(row.slot)) insert('new-board', null, row.slot, `槽位 ${row.slot} 发现新板子（只能复位，读不到型号，填板名后应用）`, { name: null, product: null, chips: row.chips })
        else row.flags.push('认不出型号，没有登记为板子；按上面的原因处理后重新扫描')
        continue
      }
      if (resetOnly.has(row.slot)) {
        // Without download ports a scan cannot tell a board's chips apart, and boot logs come and go. Registered ports
        // keep their dies, ports not seen before become new dies, and registered ports that stayed silent are only
        // reported rather than proposed as moves.
        let next = Math.max(-1, ...board.chips.map(chip => Number(chip.die.match(/^die(\d+)$/)?.[1] ?? -1))) + 1
        for (const chip of row.chips) {
          const known = board.chips.find(item => item.serialPath === chip.serialPath)
          if (known) { chip.die = known.die; chip.pending = false; continue }
          chip.die = `die${next++}`
          if (chip.serialPath) insert('serial-moved', board.name, row.slot, `${board.name} 新增芯片 ${chip.die}，串口 ${chip.serialPath}`, { die: chip.die, serialPath: chip.serialPath })
        }
        for (const known of board.chips) {
          if (known.serialPath && !row.chips.some(chip => chip.serialPath === known.serialPath)) row.flags.push(`${board.name}.${known.die} 的串口这次没有响应，登记保持不变`)
        }
        continue
      }
      if (product && board.product && product !== board.product) {
        insert('replace-board', board.name, row.slot, `槽位 ${row.slot} 的型号从 ${board.product} 变成 ${product}，可能换了板子`, { product, chips: row.chips })
        continue
      }
      // Boards a scan registered under a placeholder name take the name of the product now read.
      const rename = product && board.source === 'scan' && PLACEHOLDER.test(board.name) ? boardName(product, row.slot) : null
      if (product && (!board.product || rename)) {
        insert('product-changed', board.name, row.slot, `${board.name} 读到型号 ${product}${rename ? `，改名为 ${rename}` : ''}`, {
          product, ...(rename ? { name: rename, chips: board.chips.map(chip => ({ die: chip.die, serialPath: chip.serialPath })) } : {}),
        })
      }
      for (const chip of row.chips) {
        const known = board.chips.find(item => item.die === chip.die)
        if (chip.serialPath && known?.serialPath !== chip.serialPath) {
          insert('serial-moved', board.name, row.slot, `${board.name}.${chip.die} 串口 ${known?.serialPath ?? '（无）'} → ${chip.serialPath}`, { die: chip.die, serialPath: chip.serialPath })
        }
        if (chip.downloadUsbPath && known?.downloadUsbPath !== chip.downloadUsbPath) {
          insert('download-moved', board.name, row.slot, `${board.name}.${chip.die} 下载口 ${known?.downloadUsbPath ?? '（无）'} → ${chip.downloadUsbPath}`, { die: chip.die, downloadUsbPath: chip.downloadUsbPath, usbId: chip.usbId })
        }
      }
    }
  }

  /**
   * Apply or reject scan proposals. Applying names each identified serial port's daemon after its board
   * (`<board>-<die>` on multi-chip boards), so serial-mux names follow what the scan proved. Names are worked out
   * from the boards as they stand once every proposal in the batch is applied.
   */
  async resolveProposals(actor: string, ids: string[], decision: 'apply' | 'reject', given: Record<string, string> = {}) {
    const pending = this.db.prepare(`SELECT * FROM proposals WHERE status='pending'`).all().map(toProposal).filter(item => ids.includes(item.id))
    if (!pending.length) throw new BoardError('not-found', '没有待处理的改动建议')
    const names = new Map<string, string>()
    if (decision === 'apply') {
      const taken = new Set(this.boards().map(board => board.name))
      const unique = (wanted: string) => { let name = wanted; for (let n = 2; taken.has(name); n++) name = `${wanted}-${n}`; taken.add(name); return name }
      // Names people give are used as given, so a clash is an error rather than a silent suffix.
      for (const proposal of pending) {
        if (proposal.kind !== 'new-board' || proposal.change.name) continue
        const name = given[proposal.id]?.trim()
        if (!name) throw new BoardError('invalid', `槽位 ${proposal.slot} 的新板子要先填板名`)
        if (!BOARD_NAME.test(name)) throw new BoardError('invalid', `板名不合法：${name}（只能用字母、数字、点、横线和下划线）`)
        if (taken.has(name)) throw new BoardError('conflict', `已有板子 ${name}`)
        taken.add(name)
        names.set(proposal.id, name)
      }
      // Renames first, so every proposal for a renamed board is applied under the new name.
      const renamed = new Map<string, string>()
      for (const proposal of pending) {
        if (proposal.kind === 'product-changed' && proposal.change.name && proposal.board) renamed.set(proposal.board, unique(String(proposal.change.name)))
      }
      for (const proposal of pending) {
        names.set(proposal.id, names.get(proposal.id) ?? (proposal.kind === 'new-board' ? unique(String(proposal.change.name)) : renamed.get(proposal.board!) ?? proposal.board!))
      }
    }
    // A rename goes last so the other proposals still find the board under its old name.
    pending.sort((a, b) => Number(a.kind === 'product-changed') - Number(b.kind === 'product-changed'))
    transaction(this.db, () => {
      for (const proposal of pending) {
        if (decision === 'apply') this.applyProposal(proposal, names.get(proposal.id)!)
        this.db.prepare('UPDATE proposals SET status=? WHERE id=?').run(decision === 'apply' ? 'applied' : 'rejected', proposal.id)
        this.record(actor, proposal.board ?? names.get(proposal.id) ?? null, `proposal-${decision}`, proposal.summary, true)
      }
    })
    if (decision === 'reject') return this.changed(null)
    const failures: string[] = []
    for (const name of new Set(names.values())) failures.push(...await this.bindConsoles(name))
    this.changed(null)
    if (failures.length) throw new BoardError('hardware', `建议已应用，但有串口没能启动：${failures.join('；')}`)
  }

  /** Inventory changes only; serial-mux names are set afterwards for the boards as they end up. */
  private applyProposal(proposal: Proposal, name: string) {
    const change = proposal.change
    const seen = this.iso()
    const writeChips = (board: string, chips: ScanRow['chips']) => {
      this.db.prepare('DELETE FROM chips WHERE board=?').run(board)
      for (const chip of chips) {
        this.db.prepare('INSERT INTO chips(board, die, serial_path, download_usb_path, usb_id, last_seen_at) VALUES(?,?,?,?,?,?)')
          .run(board, chip.die, chip.serialPath, chip.downloadUsbPath, chip.usbId, seen)
      }
    }
    switch (proposal.kind) {
      case 'new-board': {
        const product = (change.product as string | null) ?? null
        this.db.prepare(`INSERT INTO boards(name, slot, product, soc, source, last_seen_at) VALUES(?,?,?,?,'scan',?)`).run(name, proposal.slot, product, product ? socOf(product) : null, seen)
        writeChips(name, change.chips as ScanRow['chips'])
        break
      }
      case 'replace-board': {
        const product = String(change.product)
        this.db.prepare(`UPDATE boards SET product=?, soc=?, serial=NULL, base_mac=NULL, source='scan', last_seen_at=?, notes=COALESCE(notes || char(10), '') || ? WHERE name=?`)
          .run(product, socOf(product), seen, `扫描 ${proposal.scanId.slice(0, 8)} 发现换板`, proposal.board)
        writeChips(proposal.board!, change.chips as ScanRow['chips'])
        break
      }
      case 'product-changed':
        this.db.prepare('UPDATE boards SET product=?, soc=?, last_seen_at=? WHERE name=?').run(String(change.product), socOf(String(change.product)), seen, proposal.board)
        if (change.name && name !== proposal.board) this.renameBoard(proposal.board!, name)
        break
      case 'serial-moved':
        this.upsertChip(proposal.board!, String(change.die), { serial_path: change.serialPath, last_seen_at: seen })
        break
      case 'download-moved':
        this.upsertChip(proposal.board!, String(change.die), { download_usb_path: change.downloadUsbPath, usb_id: change.usbId ?? null, last_seen_at: seen })
        break
    }
    if (proposal.board) this.db.prepare('UPDATE boards SET last_seen_at=? WHERE name=?').run(seen, proposal.board)
  }

  /** Chips follow through the foreign key; locks and the queue are carried over by hand. */
  private renameBoard(from: string, to: string) {
    this.db.prepare('UPDATE boards SET name=? WHERE name=?').run(to, from)
    this.db.prepare('UPDATE leases SET board=? WHERE board=?').run(to, from)
    this.db.prepare('UPDATE lease_waiters SET board=? WHERE board=?').run(to, from)
  }

  private upsertChip(board: string, die: string, fields: Record<string, unknown>) {
    this.db.prepare('INSERT INTO chips(board, die) VALUES(?,?) ON CONFLICT(board, die) DO NOTHING').run(board, die)
    for (const [column, value] of Object.entries(fields)) {
      this.db.prepare(`UPDATE chips SET ${column}=? WHERE board=? AND die=?`).run(value as string | null, board, die)
    }
  }
}

/** Names a scan gives: the product read plus the slot. */
const boardName = (product: string, slot: number) => `${product}-slot${slot}`
/** The name earlier scans gave boards whose product they could not read. */
const PLACEHOLDER = /^board-slot\d+(-\d+)?$/

export function socOf(product: string): string | null {
  if (/^k3[_-]/i.test(product)) return 'k3'
  if (/^k1[_-]/i.test(product)) return 'k1'
  return null
}

const str = (value: unknown) => typeof value === 'string' && value ? value : null
const toLease = (row: Row): Lease => ({
  id: String(row.id), board: String(row.board), holder: String(row.holder), purpose: String(row.purpose),
  startedAt: String(row.started_at), status: row.status, endedAt: str(row.ended_at), endReason: str(row.end_reason),
})
const toWaiter = (row: Row): Waiter => ({ id: String(row.id), board: String(row.board), holder: String(row.holder), purpose: String(row.purpose), queuedAt: String(row.queued_at) })
const toChip = (row: Row): Omit<Chip, 'online' | 'gateError'> => ({
  board: String(row.board), die: String(row.die), serialPath: str(row.serial_path), baud: Number(row.baud), alias: str(row.alias),
  downloadUsbPath: str(row.download_usb_path), usbId: str(row.usb_id), lastSeenAt: str(row.last_seen_at),
})
const toAction = (row: Row): Action => ({
  id: Number(row.id), at: String(row.at), actor: String(row.actor), board: str(row.board), kind: String(row.kind),
  detail: str(row.detail), ok: row.ok === 1, message: str(row.message),
})
const toProposal = (row: Row): Proposal => ({
  id: String(row.id), scanId: String(row.scan_id), kind: row.kind, board: str(row.board), slot: row.slot === null ? null : Number(row.slot),
  summary: String(row.summary), change: JSON.parse(String(row.change)), status: row.status,
})
