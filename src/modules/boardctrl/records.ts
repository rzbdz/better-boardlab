/** The records the boardctrl CLI reports (`--json`), as far as boardd reads them, and how it names boards and slots. */
/** A DUT spec as boardctrl probe proposes it (`boardctrl dut add` takes it back). */
export interface BoardctrlSpec {
  id: string, board?: string, soc?: string | null, console?: { alias?: string, device?: string }, fastboot?: { usb?: string },
  control?: { backend?: string, reset?: { pin?: string, mode?: string }, fdl?: { strategy?: string, pin?: string } }
}

/** A slot as `boardctrl --json slot list` reports it: a serial console on a host, with or without a board. */
export interface BoardctrlSlot { id: string, host: string, ref: string, alias?: string | null, online: boolean, console_up?: boolean, dut?: string | null }

/** An empty slot is addressed as `<host>/s4`; a board by its DUT name. */
export const isSlot = (device: string) => device.includes('/')
/** The lease boardd holds on an empty slot: boardctrl leases boards, and an empty slot has none yet. */
export const SLOT_LEASE = 'slot'
/** A board name boardctrl's `dut add` takes: the same rule its CLI enforces. */
export const DEVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/

/** A header pin as `boardctrl --json gpio list` reports it (the fields boardd uses). */
export interface BoardctrlPin { target: string, label?: string, aliases?: string[], state?: string, actions?: string[], channel?: { mode?: string } }

/** The debug role of a DUT as its host reports it in `services` (`{debug: {provider, kinds}}`), or null. */
export function debugOf(services: Record<string, unknown> | undefined): { provider: string, kinds: string[] } | null {
  const debug = services?.debug
  if (!debug || typeof debug !== 'object') return null
  const record = debug as { provider?: string, kinds?: string[] }
  return record.provider && record.provider !== 'none' ? { provider: record.provider, kinds: record.kinds ?? [] } : null
}

/** A boardctrl DUT as `boardctrl --json dut list` reports it (the fields boardd uses). */
export interface BoardctrlDut {
  id: string, host: string, slot?: string | null, board?: string | null, soc?: string | null, usb?: string | null, console?: string | null,
  stage?: string, console_up?: boolean, slot_online?: boolean | null, sdks?: string[], sdks_explicit?: boolean, lease?: { holder: string, purpose?: string, expires_in_s?: number } | null,
  /** Which provider serves the console: `serial-mux` speaks that protocol, another serves plain bytes. */
  console_provider?: string | null,
  needs_human?: { id?: string | null, action: string, message: string, waiting_s: number } | null,
  control?: { backend?: string, reset?: { pin?: string }, fdl?: { strategy?: string, pin?: string } },
  media_boot?: { method: string | null, available: boolean, why?: string } | null,
  services?: Record<string, unknown>,
}
