/** One-click scan: map control slots to serial adapters, download ports and K3 product names. */
import type { ScanRow } from 'boardlab-core/shared/types.ts'
import { diffUsb, type SerialAdapter, type UsbDevice } from './hardware.ts'

export const K3_ROM_USB_ID = '361c:1001'
const PRODUCT_LINE = /minor-board-info: product_name=(\S+).*crc=ok/

/** `fastboot` is false for a slot that can only reset its board. */
export interface ScanSlot { slot: number, board: string | null, fastboot: boolean }

export interface ScanHardware {
  serialAdapters(): SerialAdapter[]
  /** Stop every serial-mux daemon; returns the names that were stopped. */
  stopMux(): Promise<string[]>
  /** Start a fresh daemon listening on an adapter and return its name. */
  listen(adapter: SerialAdapter): Promise<string>
  watch(alias: string, onData: (text: string) => void): Promise<() => void>
  fastboot(slot: number): Promise<void>
  reset(slot: number): Promise<void>
  usb(): UsbDevice[]
  stage(usbPath: string): Promise<string>
  sleep(ms: number): Promise<void>
  now(): number
}

/** `bootSettleMaxMs` bounds the wait for quiet before a reset round, since a booting board keeps printing for a while. */
export interface ScanTiming { windowMs: number, quietMs: number, settleMaxMs: number, minorMs: number, rounds: number, bootSettleMaxMs?: number }
export const DEFAULT_TIMING: ScanTiming = { windowMs: 4000, quietMs: 1200, settleMaxMs: 15000, minorMs: 4000, rounds: 2, bootSettleMaxMs: 60000 }

export interface ScanReporter {
  step(slot: number | null, kind: string, summary: string, data?: unknown): void
  evidence(slot: number | null, kind: string, label: string, body: string): void
  cancelled(): boolean
}

export class ScanCancelled extends Error { constructor() { super('扫描已取消') } }

interface Port { adapter: SerialAdapter, alias: string, lastOutputAt: number, buffer: string }

/**
 * Every serial-mux daemon is stopped first and each adapter gets a fresh listener, so nothing named before the scan is
 * trusted. For each slot the fastboot button is pressed `rounds` times. A board in boot-ROM download mode prints one banner and
 * then stays quiet, so boards scanned earlier do not disturb later slots. Serial ports that respond in every round belong
 * to the slot; USB devices that appear after the first press are its download ports. K3 ports then load the registered
 * minor-board-info image into RAM and report the product name on the chip's own serial port. Touched slots are reset at the end.
 * A slot that can only reset is pressed with reset instead: the ports that print a boot log every round are its own, and
 * with no download port its product stays unknown. Its board is left booting, so it is not reset again at the end.
 */
export async function runScan(hw: ScanHardware, slots: ScanSlot[], minorImage: string | null, report: ScanReporter, timing = DEFAULT_TIMING): Promise<ScanRow[]> {
  const touched = new Set<number>()
  const ports: Port[] = []
  const unwatch: Array<() => void> = []
  const checkpoint = () => { if (report.cancelled()) throw new ScanCancelled() }
  try {
    const stopped = await hw.stopMux()
    report.step(null, 'prepare', `停止 ${stopped.length} 个 serial-mux 守护进程`, stopped)
    for (const adapter of hw.serialAdapters()) {
      const alias = await hw.listen(adapter)
      const port: Port = { adapter, alias, lastOutputAt: 0, buffer: '' }
      unwatch.push(await hw.watch(alias, text => { port.lastOutputAt = hw.now(); port.buffer += text }))
      ports.push(port)
    }
    report.step(null, 'prepare', `监听 ${ports.length} 个串口`, ports.map(port => ({ link: port.adapter.link, alias: port.alias })))

    const rows: ScanRow[] = []
    for (const { slot, board, fastboot } of slots) {
      checkpoint()
      const flags: string[] = []
      let responders: Port[] | null = null
      let downloads: UsbDevice[] = []
      const press = fastboot ? ' fastboot' : '复位'
      for (let round = 1; round <= timing.rounds; round++) {
        const busy = await settle(hw, ports, timing, fastboot ? timing.settleMaxMs : timing.bootSettleMaxMs ?? timing.settleMaxMs)
        const before = hw.usb()
        const started = hw.now()
        ports.forEach(port => { port.buffer = '' })
        if (fastboot) {
          touched.add(slot)
          await hw.fastboot(slot)
        } else await hw.reset(slot)
        await hw.sleep(timing.windowMs)
        const heard = ports.filter(port => port.lastOutputAt >= started && !busy.includes(port))
        for (const port of heard) report.evidence(slot, 'serial', `第 ${round} 次${press}：${port.alias}`, port.buffer.slice(-4000))
        if (round === 1 && fastboot) {
          downloads = diffUsb(before, hw.usb()).added
          report.evidence(slot, 'usb', 'fastboot 后新增 USB 设备', JSON.stringify(downloads, null, 2))
        }
        if (busy.length) flags.push(`串口持续输出，无法判断：${busy.map(port => port.alias).join(', ')}`)
        responders = responders === null ? heard : responders.filter(port => heard.includes(port))
        report.step(slot, fastboot ? 'fastboot' : 'reset', `第 ${round} 次${fastboot ? '' : press}：${heard.length} 个串口响应${round === 1 && fastboot ? `，${downloads.length} 个新 USB 设备` : round > 1 ? '，确认' : ''}`, {
          round, serial: heard.map(port => port.alias), usb: round === 1 && fastboot ? downloads.map(device => `${device.path} ${device.usbId}`) : undefined,
        })
        checkpoint()
      }
      responders ??= []
      for (const row of rows) {
        for (const chip of row.chips) {
          if (responders.some(port => port.adapter.link === chip.serialPath)) {
            flags.push(`串口 ${chip.serialPath} 同时响应槽位 ${row.slot}，接线可能有问题`)
            row.flags.push(`串口 ${chip.serialPath} 同时响应槽位 ${slot}，接线可能有问题`)
          }
        }
      }
      if (!responders.length) flags.push('无串口响应（可能没上电、没接线或板子坏了）')
      if (!fastboot) flags.push('这个槽位只能复位，没有下载口，读不到型号')
      else if (!downloads.length) flags.push('fastboot 后没有出现下载口')

      const chips = await identifyChips(hw, slot, responders, downloads, minorImage, report, timing, flags)
      rows.push({ slot, board, chips, flags: [...new Set(flags)] })
      report.step(slot, 'slot-done', `槽位 ${slot}：${chips.length} 颗芯片`, rows.at(-1))
    }
    return rows
  } finally {
    for (const slot of touched) {
      try { await hw.reset(slot); report.step(slot, 'restore', `槽位 ${slot} 已复位`) }
      catch (error) { report.step(slot, 'restore', `槽位 ${slot} 复位失败：${(error as Error).message}`) }
    }
    unwatch.forEach(fn => fn())
  }
}

/** Wait for every port to go quiet; ports that never do are excluded from this round. */
async function settle(hw: ScanHardware, ports: Port[], timing: ScanTiming, maxMs: number): Promise<Port[]> {
  const deadline = hw.now() + maxMs
  for (;;) {
    const busy = ports.filter(port => hw.now() - port.lastOutputAt < timing.quietMs)
    if (!busy.length || hw.now() >= deadline) return busy
    await hw.sleep(Math.min(timing.quietMs, 500))
  }
}

async function identifyChips(hw: ScanHardware, slot: number, responders: Port[], downloads: UsbDevice[], minorImage: string | null, report: ScanReporter, timing: ScanTiming, flags: string[]): Promise<ScanRow['chips']> {
  const ordered = [...downloads].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
  const chips: ScanRow['chips'] = []
  const unmatched = new Set(responders)
  for (const device of ordered) {
    let product: string | null = null
    let serial: Port | null = null
    if (device.usbId !== K3_ROM_USB_ID) flags.push(`下载口 ${device.path}（${device.usbId}）不是 K3，型号未知`)
    else if (!minorImage) flags.push('boardd 没有自带 K3 的 minor-board-info 固件，无法读型号')
    else {
      responders.forEach(port => { port.buffer = '' })
      const output = await hw.stage(device.path)
      report.evidence(slot, 'fastboot', `stage ${device.path}`, output)
      await hw.sleep(timing.minorMs)
      for (const port of responders) {
        const match = port.buffer.match(PRODUCT_LINE)
        if (match) { product = match[1]!; serial = port; break }
      }
      report.step(slot, 'minor', product ? `下载口 ${device.path} → ${serial!.alias} 型号 ${product}` : `下载口 ${device.path} 没有读到型号`, { usb: device.path, product, serial: serial?.alias ?? null })
      if (serial) report.evidence(slot, 'serial', `minor-board-info：${serial.alias}`, serial.buffer.slice(-4000))
    }
    if (serial) unmatched.delete(serial)
    chips.push({ die: '', serialPath: serial?.adapter.link ?? null, downloadUsbPath: device.path, usbId: device.usbId, product, pending: false })
  }
  // Serial ports with no download port of their own (or a single-chip board without minor output) are paired in order.
  for (const chip of chips) {
    if (chip.serialPath) continue
    const next = [...unmatched][0]
    if (next) { chip.serialPath = next.adapter.link; unmatched.delete(next); chip.pending = chips.length > 1 }
  }
  for (const port of unmatched) chips.push({ die: '', serialPath: port.adapter.link, downloadUsbPath: null, usbId: null, product: null, pending: true })
  chips.forEach((chip, index) => {
    chip.die = `die${index}`
    if (chips.length > 1 && !chip.product) chip.pending = true
  })
  return chips
}
