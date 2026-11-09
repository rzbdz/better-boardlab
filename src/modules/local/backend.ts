/**
 * The local backend: boards wired to this machine. Its relay is the board's control slot, its serial ports are
 * serial-mux daemons named after the boards (gated by the lock), and its download path is the fastboot here.
 */
import type { Backend } from 'boardlab-core/core/backend.ts'
import type { ConsoleSession } from 'boardlab-core/core/console.ts'
import { BoardError } from 'boardlab-core/core/errors.ts'
import { stageAndContinue, type FastbootRunner, type SerialAdapter, type UsbDevice } from './hardware.ts'
import type { Slots } from './slots.ts'

/** serial-mux on this machine. */
export interface Mux {
  /** `token` is the lock's gate token, so boardd's own input passes the port's serial-mux gate. */
  open(alias: string, token?: string | null): Promise<ConsoleSession>
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

/** USB and serial adapters on this machine, and its fastboot. */
export interface Hardware {
  usb(): UsbDevice[]
  serialAdapters(): SerialAdapter[]
  fastboot: FastbootRunner
}

export function localBackend(slots: Slots, mux: Mux, hardware: Hardware): Backend {
  const slotAction = (action: 'reset' | 'download') => action === 'reset' ? 'reset' as const : 'fastboot' as const
  /** A slot target (`slot:N`) has no board to tell the driver about. */
  const press = async (target: { board: string }, action: 'reset' | 'fastboot') => {
    const { slot, driver } = slots.of(target.board)
    return (await driver.press(slot, action, target.board.startsWith('slot:') ? null : target.board)) ?? undefined
  }
  return {
    kind: '本机',
    lockTarget: name => slots.lockTarget(name),
    relay: {
      describe: (target, action) => {
        const { slot, driver } = slots.of(target.board)
        const kind = slotAction(action)
        if (!driver.can(slot, kind)) throw new BoardError('invalid', driver.cannot(slot, kind))
        return driver.describe(slot, kind)
      },
      reset: (_config, target) => press(target, 'reset'),
      enterDownload: async (_config, target) => { await press(target, 'fastboot') },
    },
    serial: {
      gated: true,
      online: target => !!target.port && mux.online(target.port),
      open: async (_config, target) => {
        if (!target.port) throw new BoardError('invalid', `${target.board}.${target.die} 没有登记串口`)
        if (!mux.online(target.port)) throw new BoardError('invalid', `${target.board}.${target.die} 的串口 ${target.port} 没有绑定设备，无法使用`)
        return mux.open(target.port, target.gate)
      },
    },
    download: {
      stage: (_config, target, file, timeoutMs) => {
        if (!target.usbPath) throw new BoardError('invalid', `${target.board} 没有登记下载口`)
        return stageAndContinue(hardware.fastboot, target.usbPath, file.path, timeoutMs)
      },
      present: async (_config, target) => hardware.usb().some(device => device.path === target.usbPath),
    },
  }
}
