/**
 * Scanning this machine's slots: reset and switch each board to learn which serial port and download port are whose,
 * and read its product, then propose the inventory changes for a person to apply. Applying one names each serial port's
 * serial-mux daemon after its board, which is also how consoles come back after a reboot or a scan.
 */
import { randomUUID } from 'node:crypto'
import type { Proposal, ProposalKind, Scan, ScanRow } from 'boardlab-core/shared/types.ts'
import { socOf } from 'boardlab-core/core/boards.ts'
import { transaction } from 'boardlab-core/core/db.ts'
import { BoardError } from 'boardlab-core/core/errors.ts'
import type { BoardLab } from 'boardlab-core/core/lab.ts'
import { BOARD_NAME, str, stripAnsi } from 'boardlab-core/core/text.ts'
import type { Hardware, Mux } from './backend.ts'
import { adapterPortName, stageAndContinue } from './hardware.ts'
import { runScan, ScanCancelled, type ScanTiming } from './scan.ts'
import { slotKey, type Slots } from './slots.ts'

/** Names a scan gives: the product read plus the slot. */
const boardName = (product: string, slot: number) => `${product}-slot${slot}`
/** The name earlier scans gave boards whose product they could not read. */
const PLACEHOLDER = /^board-slot\d+(-\d+)?$/

export class Scanner {
  private running: { id: string, cancelled: boolean } | null = null

  constructor(private readonly lab: BoardLab, private readonly slots: Slots, private readonly mux: Mux, private readonly hardware: Hardware, private readonly timing?: ScanTiming) {
    lab.kernel.db.prepare(`UPDATE scans SET status='failed', finished_at=?, message='boardd 重启，扫描中断' WHERE status='running'`).run(lab.kernel.iso())
  }

  /** A proposal from one of this machine's scans (a backend's discoveries have their own). */
  owns(proposal: Proposal): boolean { return !!this.lab.kernel.db.prepare('SELECT 1 FROM scans WHERE id=?').get(proposal.scanId) }

  get(id: string): Scan {
    const db = this.lab.kernel.db
    const row = db.prepare('SELECT * FROM scans WHERE id=?').get(id)
    if (!row) throw new BoardError('not-found', `没有这次扫描：${id}`)
    return {
      id: String(row.id), holder: String(row.holder), scope: JSON.parse(String(row.scope)), status: row.status as Scan['status'],
      startedAt: String(row.started_at), finishedAt: str(row.finished_at), message: str(row.message), result: JSON.parse(String(row.result)),
      steps: db.prepare('SELECT * FROM scan_steps WHERE scan_id=? ORDER BY seq').all(id).map(step => ({
        seq: Number(step.seq), at: String(step.at), slot: step.slot === null ? null : Number(step.slot), kind: String(step.kind),
        summary: String(step.summary), data: JSON.parse(String(step.data)),
      })),
    }
  }

  latest(): Scan | null {
    const row = this.lab.kernel.db.prepare('SELECT id FROM scans ORDER BY started_at DESC LIMIT 1').get()
    return row ? this.get(String(row.id)) : null
  }

  recent(): Scan[] { return this.lab.kernel.db.prepare('SELECT id FROM scans ORDER BY started_at DESC LIMIT 20').all().map(row => this.get(String(row.id))) }

  evidence(scanId: string): Array<{ slot: number | null, kind: string, label: string, body: string, at: string }> {
    return this.lab.kernel.db.prepare('SELECT * FROM scan_evidence WHERE scan_id=? ORDER BY id').all(scanId).map(row => ({
      slot: row.slot === null ? null : Number(row.slot), kind: String(row.kind), label: String(row.label), body: String(row.body), at: String(row.at),
    }))
  }

  /**
   * Start a scan. Requires explicit confirmation and every target lock up front; it runs in the background. The slot
   * drivers bring the slot table in step with their controllers first; one that cannot be read keeps the stored slots.
   */
  async start(holder: string, input: { slots?: number[], boards?: string[], confirmed: boolean }): Promise<Scan> {
    if (!input.confirmed) throw new BoardError('forbidden', '扫描会复位并切换板子，需要用户确认')
    if (this.running) throw new BoardError('conflict', '已有扫描在进行')
    for (const driver of this.slots.enabledDrivers()) await driver.refresh?.(holder).catch(() => {})
    const known = this.slots.list()
    let scope = input.slots?.length ? input.slots : known.map(slot => slot.slot)
    if (input.boards?.length) scope = input.boards.map(name => this.slots.of(name).slot.slot)
    scope = [...new Set(scope)].sort((a, b) => a - b)
    for (const slot of scope) {
      const found = known.find(item => item.slot === slot)
      if (!found) throw new BoardError('not-found', `没有槽位 ${slot}`)
      if (!found.canFastboot && !found.canReset) throw new BoardError('invalid', `槽位 ${slot} 既不能复位也不能 fastboot`)
    }
    if (!scope.length) throw new BoardError('invalid', '没有可扫描的槽位')
    for (const kind of new Set(scope.map(slot => known.find(item => item.slot === slot)!.kind))) this.slots.driver(kind)?.check?.()
    const db = this.lab.kernel.db
    const targets = scope.map(slot => {
      const board = db.prepare('SELECT name FROM boards WHERE slot=?').get(slot)
      return { slot, board: board ? String(board.name) : null, target: board ? String(board.name) : slotKey(slot) }
    })
    const id = randomUUID()
    const tokens = transaction(db, () => {
      // A scan stops every serial-mux daemon and switches boards around, so anyone holding any board, the scanner included, rules it out.
      const held = this.lab.locks.holders()[0]
      if (held) throw new BoardError('locked', `${held.board} 正被 ${held.holder} 使用，扫描未开始`)
      db.prepare('INSERT INTO scans(id, holder, scope, status, started_at) VALUES(?,?,?,?,?)').run(id, holder, JSON.stringify(scope), 'running', this.lab.kernel.iso())
      return targets.map(({ target }) => ({ target, token: this.lab.locks.grant(target, holder, `扫描 ${id.slice(0, 8)}`).token }))
    })
    this.running = { id, cancelled: false }
    this.lab.kernel.record(holder, null, 'scan', `槽位 ${scope.join(', ')}`, true)
    this.lab.kernel.changed(null)
    void this.execute(id, holder, targets, tokens)
    return this.get(id)
  }

  cancel(holder: string, id: string) {
    if (this.running?.id !== id) throw new BoardError('conflict', '这次扫描已经结束')
    this.running.cancelled = true
    this.lab.kernel.record(holder, null, 'scan-cancel', id, true)
  }

  private async execute(id: string, holder: string, targets: Array<{ slot: number, board: string | null, target: string }>, tokens: Array<{ target: string, token: string }>) {
    const { kernel, relay, locks, download } = this.lab
    let seq = 0
    const caller = (target: string) => ({ holder, token: tokens.find(item => item.target === target)?.token ?? null })
    const targetOf = (slot: number) => targets.find(item => item.slot === slot)!.target
    const publish = () => kernel.emit({ type: 'scan', scan: this.get(id) })
    const report = {
      step: (slot: number | null, kind: string, summary: string, data: unknown = null) => {
        kernel.db.prepare('INSERT INTO scan_steps(scan_id, seq, at, slot, kind, summary, data) VALUES(?,?,?,?,?,?,?)').run(id, ++seq, kernel.iso(), slot, kind, summary, JSON.stringify(data ?? null))
        publish()
      },
      evidence: (slot: number | null, kind: string, label: string, body: string) => {
        kernel.db.prepare('INSERT INTO scan_evidence(scan_id, slot, kind, label, body, at) VALUES(?,?,?,?,?,?)').run(id, slot, kind, label, stripAnsi(body), kernel.iso())
      },
      cancelled: () => this.running?.cancelled ?? false,
    }
    let minorPath: string | null = null
    if (download.firmware().some(item => item.soc === 'k3' && item.purpose === 'minor-board-info')) {
      try { minorPath = download.verifiedFirmware('minor-board-info', 'k3').path }
      catch (error) { report.step(null, 'prepare', (error as Error).message) }
    }
    const hw = this.hardware
    let status: Scan['status'] = 'done', message: string | null = null, rows: ScanRow[] = []
    const listeners = new Set<string>()
    try {
      rows = await runScan({
        serialAdapters: () => hw.serialAdapters(),
        stopMux: () => this.mux.stopAll(),
        listen: async adapter => { const alias = await this.mux.start(adapter, `port-${adapterPortName(adapter, hw.serialAdapters())}`); listeners.add(alias); return alias },
        watch: async (alias, onData) => {
          const session = await this.mux.open(alias)
          session.onOutput(data => onData(data.toString('utf8')))
          return () => session.close()
        },
        fastboot: slot => relay.control(targetOf(slot), caller(targetOf(slot)), 'fastboot'),
        reset: slot => relay.control(targetOf(slot), caller(targetOf(slot)), 'reset'),
        usb: () => hw.usb(),
        stage: usbPath => stageAndContinue(hw.fastboot, usbPath, minorPath!),
        sleep: kernel.sleep,
        now: kernel.now,
      }, targets.map(({ slot, board }) => ({ slot, board, fastboot: this.slots.list().find(item => item.slot === slot)!.canFastboot })), minorPath, report, this.timing)
      this.propose(id, rows)
    } catch (error) {
      status = error instanceof ScanCancelled ? 'cancelled' : 'failed'
      message = (error as Error).message
    } finally {
      this.running = null
      for (const failure of await this.restoreConsoles()) report.step(null, 'console', failure)
      // Listeners no registered board took over go away; applying a proposal starts its board's own daemon.
      const claimed = new Set(this.lab.boards.list().flatMap(board => board.chips.map(chip => chip.alias)))
      for (const alias of listeners) {
        if (claimed.has(alias)) continue
        try { await this.mux.stop(alias) } catch (error) { report.step(null, 'console', `没能停掉临时监听 ${alias}：${(error as Error).message}`) }
      }
      kernel.db.prepare('UPDATE scans SET status=?, finished_at=?, message=?, result=? WHERE id=?').run(status, kernel.iso(), message, JSON.stringify(rows), id)
      for (const { target, token } of tokens) {
        try { locks.unlock(target, { holder, token }) } catch {}
      }
      kernel.record(holder, null, 'scan-end', id, status === 'done', message)
      publish()
      kernel.changed(null)
    }
  }

  /** This machine's boards, as the local backend has them. */
  private localBoards() { return this.lab.boards.list().filter(board => board.backend === 'local') }

  /**
   * Run each registered serial port's daemon under its board's name again, then gate it as its lock says. A scan listens
   * on every port under `port-*` names, and daemons do not outlive a reboot or keep their gate across a restart.
   */
  async restoreConsoles(): Promise<string[]> {
    const adapters = this.hardware.serialAdapters()
    const failures: string[] = []
    for (const board of this.localBoards()) failures.push(...await this.bindConsoles(board.name, adapters))
    return failures
  }

  /**
   * Run each of a board's serial ports under the name it should have — the board's name, or `<board>-<die>` once it has
   * several chips — and record that name. Names the board no longer uses are stopped, and the ports are gated as the lock
   * says. Returns what could not be started.
   */
  private async bindConsoles(name: string, adapters = this.hardware.serialAdapters()): Promise<string[]> {
    const board = this.localBoards().find(item => item.name === name)
    if (!board) return []
    const failures: string[] = []
    const wanted = new Set<string>()
    for (const chip of board.chips) {
      if (!chip.serialPath) continue
      const alias = board.chips.length > 1 ? `${name}-${chip.die}` : name
      wanted.add(alias)
      if (chip.alias !== alias) this.lab.boards.upsertChip(name, chip.die, { alias })
      const adapter = adapters.find(item => item.link === chip.serialPath)
      if (!adapter) continue
      try { await this.mux.start(adapter, alias) }
      catch (error) {
        const message = `${name}.${chip.die} 的串口 ${alias} 没能启动：${(error as Error).message}`
        failures.push(message)
        this.lab.kernel.record('boardd', name, 'console-restore', alias, false, message)
      }
    }
    for (const chip of board.chips) {
      if (!chip.alias || wanted.has(chip.alias)) continue
      try { await this.mux.stop(chip.alias) } catch {}
    }
    await this.lab.locks.settle(name)
    return failures
  }

  private propose(scanId: string, rows: ScanRow[]) {
    const { proposals } = this.lab
    const insert = (kind: ProposalKind, board: string | null, slot: number, summary: string, change: Record<string, unknown>) => proposals.add(scanId, kind, board, slot, summary, change)
    proposals.supersede(proposal => proposal.scanId !== scanId && this.owns(proposal))
    const resetOnly = new Set(this.slots.list().filter(slot => !slot.canFastboot).map(slot => slot.slot))
    for (const row of rows) {
      if (!row.chips.length) continue
      const board = row.board ? this.lab.boards.get(row.board) : null
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
   * Apply or reject scan proposals. Applying names each identified serial port's daemon after its board (`<board>-<die>`
   * on multi-chip boards), so serial-mux names follow what the scan proved. Names are worked out from the boards as they
   * stand once every proposal in the batch is applied.
   */
  async resolve(actor: string, pending: Proposal[], decision: 'apply' | 'reject', given: Record<string, string>) {
    const { kernel, boards, proposals } = this.lab
    const names = new Map<string, string>()
    if (decision === 'apply') {
      const taken = new Set(boards.list().map(board => board.name))
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
    transaction(kernel.db, () => {
      for (const proposal of pending) {
        if (decision === 'apply') this.apply(proposal, names.get(proposal.id)!)
        proposals.mark(proposal.id, decision === 'apply' ? 'applied' : 'rejected')
        kernel.record(actor, proposal.board ?? names.get(proposal.id) ?? null, `proposal-${decision}`, proposal.summary, true)
      }
    })
    if (decision === 'reject') return kernel.changed(null)
    const failures: string[] = []
    for (const name of new Set(names.values())) failures.push(...await this.bindConsoles(name))
    kernel.changed(null)
    if (failures.length) throw new BoardError('hardware', `建议已应用，但有串口没能启动：${failures.join('；')}`)
  }

  /** Inventory changes only; serial-mux names are set afterwards for the boards as they end up. */
  private apply(proposal: Proposal, name: string) {
    const { db } = this.lab.kernel
    const change = proposal.change
    const seen = this.lab.kernel.iso()
    const writeChips = (board: string, chips: ScanRow['chips']) => {
      db.prepare('DELETE FROM chips WHERE board=?').run(board)
      for (const chip of chips) {
        db.prepare('INSERT INTO chips(board, die, serial_path, download_usb_path, usb_id, last_seen_at) VALUES(?,?,?,?,?,?)')
          .run(board, chip.die, chip.serialPath, chip.downloadUsbPath, chip.usbId, seen)
      }
    }
    switch (proposal.kind) {
      case 'new-board': {
        const product = (change.product as string | null) ?? null
        db.prepare(`INSERT INTO boards(name, slot, product, soc, source, last_seen_at) VALUES(?,?,?,?,'scan',?)`).run(name, proposal.slot, product, product ? socOf(product) : null, seen)
        writeChips(name, change.chips as ScanRow['chips'])
        break
      }
      case 'replace-board': {
        const product = String(change.product)
        db.prepare(`UPDATE boards SET product=?, soc=?, serial=NULL, base_mac=NULL, source='scan', last_seen_at=?, notes=COALESCE(notes || char(10), '') || ? WHERE name=?`)
          .run(product, socOf(product), seen, `扫描 ${proposal.scanId.slice(0, 8)} 发现换板`, proposal.board)
        writeChips(proposal.board!, change.chips as ScanRow['chips'])
        break
      }
      case 'product-changed':
        db.prepare('UPDATE boards SET product=?, soc=?, last_seen_at=? WHERE name=?').run(String(change.product), socOf(String(change.product)), seen, proposal.board)
        if (change.name && name !== proposal.board) this.lab.boards.rename(proposal.board!, name)
        break
      case 'serial-moved':
        this.lab.boards.upsertChip(proposal.board!, String(change.die), { serial_path: change.serialPath, last_seen_at: seen })
        break
      case 'download-moved':
        this.lab.boards.upsertChip(proposal.board!, String(change.die), { download_usb_path: change.downloadUsbPath, usb_id: change.usbId ?? null, last_seen_at: seen })
        break
    }
    if (proposal.board) db.prepare('UPDATE boards SET last_seen_at=? WHERE name=?').run(seen, proposal.board)
  }
}
