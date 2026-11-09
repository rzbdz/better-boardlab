/**
 * This machine's control slots: a numbered place a board sits, with a way to reset it and, for most, to put it into
 * download mode. Each slot is driven by a slot driver of its kind (a Home Assistant controller, scripts), which modules
 * plug in; a slot whose driver is missing or switched off is not offered.
 */
import type { Slot } from 'boardlab-core/shared/types.ts'
import { BoardError } from 'boardlab-core/core/errors.ts'
import type { BoardLab } from 'boardlab-core/core/lab.ts'
import { str, type Row } from 'boardlab-core/core/text.ts'

export type SlotAction = 'reset' | 'fastboot'

export interface SlotDriver {
  /** The `kind` of the slots it drives. */
  kind: string
  /** What people call it in messages: 「属于 Home Assistant 控制器」. */
  title: string
  /** Off, its slots are hidden and never pressed (boards on them stay registered). */
  enabled(): boolean
  /** Why one of its slots cannot be used while it is off. */
  disabled(slot: number): string
  can(slot: Slot, action: SlotAction): boolean
  /** Why the slot cannot do it, when `can` says no. */
  cannot(slot: Slot, action: SlotAction): string
  /** What pressing it does, for the action log. */
  describe(slot: Slot, action: SlotAction): string
  press(slot: Slot, action: SlotAction, board: string | null): Promise<string | null | void>
  /** Throws when its slots cannot be pressed now (no access configured, say), so a scan does not start in vain. */
  check?(): void
  /** Bring the slot table in step with the controller; a scan asks first. */
  refresh?(actor: string): Promise<void>
}

export const slotKey = (slot: number) => `slot:${slot}`

export class Slots {
  private readonly drivers = new Map<string, SlotDriver>()

  constructor(private readonly lab: BoardLab) {}

  addDriver(driver: SlotDriver) {
    if (this.drivers.has(driver.kind)) throw new Error(`slot driver ${driver.kind} is registered twice`)
    this.drivers.set(driver.kind, driver)
  }

  driver(kind: string): SlotDriver | null { return this.drivers.get(kind) ?? null }
  enabledDrivers(): SlotDriver[] { return [...this.drivers.values()].filter(driver => driver.enabled()) }

  private toSlot(row: Row, driver: SlotDriver): Slot {
    const slot: Slot = {
      slot: Number(row.slot), kind: String(row.kind), label: str(row.label), resetEntity: str(row.reset_entity), fastbootEntity: str(row.fastboot_entity),
      resetScript: str(row.reset_script), fastbootScript: str(row.fastboot_script), device: str(row.device), confirmedAt: str(row.confirmed_at),
      canReset: false, canFastboot: false,
    }
    slot.canReset = driver.can(slot, 'reset')
    slot.canFastboot = driver.can(slot, 'fastboot')
    return slot
  }

  /** The slots offered: those whose driver is loaded and on. */
  list(): Slot[] {
    return this.lab.kernel.db.prepare('SELECT * FROM slots ORDER BY slot').all().flatMap(row => {
      const driver = this.drivers.get(String(row.kind))
      return driver?.enabled() ? [this.toSlot(row, driver)] : []
    })
  }

  /** The kind of a slot in the table, offered or not. */
  kindOf(slot: number): string | null { return str(this.lab.kernel.db.prepare('SELECT kind FROM slots WHERE slot=?').get(slot)?.kind) }

  /** The slot of a lock target (`slot:N` or a board's), with its driver; it must be offered. */
  of(target: string): { slot: Slot, driver: SlotDriver } {
    const match = target.match(/^slot:(\d+)$/)
    const number = match ? Number(match[1]) : this.lab.boards.get(target).slot
    if (number === null) throw new BoardError('invalid', `${target} 没有对应的控制槽位`)
    const row = this.lab.kernel.db.prepare('SELECT * FROM slots WHERE slot=?').get(number)
    if (!row) throw new BoardError('not-found', `没有槽位 ${number}`)
    const driver = this.drivers.get(String(row.kind))
    if (!driver) throw new BoardError('invalid', `槽位 ${number} 的控制器（${String(row.kind)}）没有装上`)
    if (!driver.enabled()) throw new BoardError('invalid', driver.disabled(number))
    return { slot: this.toSlot(row, driver), driver }
  }

  /** `slot:N` lock targets: a slot with no board yet, as a scan locks it. */
  lockTarget(name: string): boolean {
    const match = name.match(/^slot:(\d+)$/)
    if (!match) return false
    if (!this.lab.kernel.db.prepare('SELECT 1 FROM slots WHERE slot=?').get(Number(match[1]))) throw new BoardError('not-found', `没有槽位 ${match[1]}`)
    return true
  }
}
