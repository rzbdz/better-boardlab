/**
 * A control slot on this machine, driven by its kind's slot driver. `ha` slots are buttons on the Home Assistant
 * controller and follow it on their own; `script` slots run shell scripts entered on the page, for anything else that
 * can power-cycle a board (a smart plug, say).
 */
export interface Slot {
  slot: number
  kind: string
  label: string | null
  resetEntity: string | null
  fastbootEntity: string | null
  resetScript: string | null
  /** Empty for a slot that can only reset its board. */
  fastbootScript: string | null
  device: string | null
  confirmedAt: string | null
  canReset: boolean
  canFastboot: boolean
}

export type ScanStatus = 'running' | 'done' | 'failed' | 'cancelled'
export interface ScanStep { seq: number, at: string, slot: number | null, kind: string, summary: string, data: unknown }
export interface ScanRow {
  slot: number
  board: string | null
  chips: Array<{ die: string, serialPath: string | null, downloadUsbPath: string | null, usbId: string | null, product: string | null, pending: boolean }>
  flags: string[]
}
export interface Scan {
  id: string
  holder: string
  scope: number[]
  status: ScanStatus
  startedAt: string
  finishedAt: string | null
  message: string | null
  steps: ScanStep[]
  result: ScanRow[]
}

export type ProposalKind = 'new-board' | 'replace-board' | 'serial-moved' | 'download-moved' | 'product-changed' | 'slot-empty'
export type ScanEvent = { type: 'scan', scan: Scan }

/** The SoC a local scan's product name says, for the products whose names do. */
export function socFromProduct(product: string): string | null {
  if (/^k3[_-]/i.test(product)) return 'k3'
  if (/^k1[_-]/i.test(product)) return 'k1'
  return null
}
