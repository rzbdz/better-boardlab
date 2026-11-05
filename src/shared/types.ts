/** Wire types shared by boardd, the CLI, the web UI and the DSH plugin. */

export type LeaseStatus = 'held' | 'released' | 'stolen'
export type BoardMode = 'unknown' | 'normal' | 'resetting' | 'fastboot'
export type BoardSource = 'import' | 'scan' | 'manual' | 'lab'

export interface Lease {
  id: string
  board: string
  holder: string
  purpose: string
  startedAt: string
  status: LeaseStatus
  endedAt: string | null
  endReason: string | null
}

export interface Waiter { id: string, board: string, holder: string, purpose: string, queuedAt: string }

export interface Chip {
  board: string
  die: string
  serialPath: string | null
  baud: number
  alias: string | null
  downloadUsbPath: string | null
  usbId: string | null
  lastSeenAt: string | null
  /** serial-mux has a daemon for the alias with a device bound; consoles and input need it. */
  online: boolean
  /** Why this port's serial-mux input gate does not follow the board's lock, when it does not. */
  gateError: string | null
}

export interface Board {
  name: string
  slot: number | null
  serial: string | null
  product: string | null
  baseMac: string | null
  soc: string | null
  notes: string | null
  source: BoardSource
  mode: BoardMode
  chips: Chip[]
  lease: Lease | null
  waiters: Waiter[]
  lastSeenAt: string | null
  /** Set for a board in a remote lab: which lab, and the lab's own name for it. */
  lab: BoardLab | null
}

export interface BoardLab {
  id: string
  device: string
  /** The lab sees the board's own system running, as of its last listing. */
  online: boolean
  ip: string | null
}

/**
 * A control slot. `ha` slots are buttons on the Home Assistant controller and follow it on their own; `script` slots run
 * shell scripts entered on the page, for anything else that can power-cycle a board (a smart plug, say).
 */
export interface Slot {
  slot: number
  kind: 'ha' | 'script'
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

export interface HaSettings {
  url: string | null
  hasToken: boolean
  verifiedAt: string | null
  verifyOk: boolean | null
  verifyMessage: string | null
}

/**
 * A remote lab boardd can use. Its boards are listed from the lab once it is enabled; the password, like the HA token,
 * is write-only.
 */
export interface LabSettings {
  id: string
  kind: string
  enabled: boolean
  url: string | null
  username: string | null
  hasPassword: boolean
  /** The jump host as set, and the one used when it is not. */
  jump: string | null
  defaultJump: string | null
  /** Which of the lab's boards to list: names or `*` patterns; empty lists them all. */
  devices: string | null
  verifiedAt: string | null
  verifyOk: boolean | null
  verifyMessage: string | null
  syncedAt: string | null
  syncOk: boolean | null
  syncMessage: string | null
}

export interface Action {
  id: number
  at: string
  actor: string
  board: string | null
  kind: string
  detail: string | null
  ok: boolean
  message: string | null
}

/** A firmware file boardd ships in firmware/, listed in its firmware.json. */
export interface Firmware { soc: string, purpose: string, path: string, sha256: string, note: string | null }

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
export interface Proposal {
  id: string
  scanId: string
  kind: ProposalKind
  board: string | null
  slot: number | null
  summary: string
  change: Record<string, unknown>
  status: 'pending' | 'applied' | 'rejected'
}

export interface HaCandidate { slot: number, resetEntity: string | null, fastbootEntity: string | null, device: string | null }
export interface HaDiscovery { devices: Array<{ id: string, name: string }>, slots: HaCandidate[], unassigned: string[] }

export interface State {
  boards: Board[]
  slots: Slot[]
  ha: HaSettings
  labs: LabSettings[]
  firmware: Firmware[]
  proposals: Proposal[]
  scan: Scan | null
  you: string
  now: string
}

export interface BoardDetail { board: Board, actions: Action[], leases: Lease[] }

/** `gateToken` lets the holder type through serial-mux directly (`smtty --token`); boardd uses it for its own input. */
export interface LockResult { lease: Lease | null, token: string | null, gateToken: string | null, queued: { position: number } | null }
export interface SendResult { output: string, matched: boolean }

/** Events pushed on /api/events. Console bytes use /api/console. */
export type BoardEvent =
  | { type: 'changed', board: string | null }
  | { type: 'scan', scan: Scan }
  | { type: 'lease-stolen', board: string, from: string, by: string, reason: string }
  | { type: 'lease-granted', board: string, holder: string }
