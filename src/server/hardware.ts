/** Local USB, tty and fastboot facts read from sysfs and the fastboot tool. */
import { execFile, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** `devnum` changes on every enumeration, so a device that dropped and came back is told apart from one that stayed. */
export interface UsbDevice { path: string, usbId: string, serial: string | null, product: string | null, devnum?: number | null }
/** `usbInterface` is the tty's USB interface (`1-2.3:1.1`); a multi-port adapter has one per port under one `usbPath`. */
export interface SerialAdapter { link: string, device: string, usbPath: string | null, usbInterface: string | null }

const read = (file: string) => { try { return readFileSync(file, 'utf8').trim() } catch { return null } }

/** USB devices keyed by their port path (`3-2.3`), the same form `fastboot -s usb:` accepts. */
export function listUsb(sysRoot = '/sys'): UsbDevice[] {
  const dir = join(sysRoot, 'bus/usb/devices')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => /^\d+-[\d.]+$/.test(name)).flatMap(name => {
    const vendor = read(join(dir, name, 'idVendor'))
    const product = read(join(dir, name, 'idProduct'))
    if (!vendor || !product) return []
    const devnum = Number(read(join(dir, name, 'devnum')))
    return [{ path: name, usbId: `${vendor}:${product}`, serial: read(join(dir, name, 'serial')), product: read(join(dir, name, 'product')), devnum: Number.isFinite(devnum) ? devnum : null }]
  }).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
}

/** USB port path of a tty, taken from the last `bus-port` segment of its sysfs device link. */
export function ttyUsbPath(device: string, sysRoot = '/sys'): string | null {
  try {
    const real = realpathSync(join(sysRoot, 'class/tty', device.replace(/^\/dev\//, ''), 'device'))
    return real.split('/').filter(part => /^\d+-[\d.]+$/.test(part)).at(-1) ?? null
  } catch { return null }
}

/** USB interface of a tty (`1-2.3:1.1`), the last `bus-port:config.interface` segment of its sysfs device link. */
export function ttyUsbInterface(device: string, sysRoot = '/sys'): string | null {
  try {
    const real = realpathSync(join(sysRoot, 'class/tty', device.replace(/^\/dev\//, ''), 'device'))
    return real.split('/').filter(part => /^\d+-[\d.]+:\d+\.\d+$/.test(part)).at(-1) ?? null
  } catch { return null }
}

/** Name for an adapter's port: its USB port, plus the interface when other ports of the same adapter share that USB port. */
export function adapterPortName(adapter: SerialAdapter, adapters: readonly SerialAdapter[]): string {
  if (!adapter.usbPath) return adapter.device.split('/').at(-1)!
  const shared = adapters.some(other => other.device !== adapter.device && other.usbPath === adapter.usbPath)
  const iface = adapter.usbInterface?.split(':')[1]
  return shared && iface ? `${adapter.usbPath}-${iface}` : adapter.usbPath
}

// Espressif USB-serial units are the reset controllers themselves; opening their port toggles DTR/RTS and resets them.
const CONTROLLER_VENDORS = new Set(['303a'])

/**
 * USB serial adapters named by their `/dev/serial/by-path` link. Cheap adapters without a serial number share one
 * by-id name, so only the physical USB port tells them apart.
 */
export function listSerialAdapters(devRoot = '/dev', sysRoot = '/sys'): SerialAdapter[] {
  const ttyDir = join(sysRoot, 'class/tty')
  if (!existsSync(ttyDir)) return []
  const byPath = join(devRoot, 'serial/by-path')
  const links = new Map<string, string>()
  if (existsSync(byPath)) {
    for (const name of readdirSync(byPath).sort()) {
      if (name.includes('-usbv2-')) continue
      try { links.set(realpathSync(join(byPath, name)), join(byPath, name)) } catch {}
    }
  }
  return readdirSync(ttyDir).filter(name => /^tty(USB|ACM)\d+$/.test(name)).flatMap(name => {
    const usbPath = ttyUsbPath(name, sysRoot)
    const vendor = usbPath ? read(join(sysRoot, 'bus/usb/devices', usbPath, 'idVendor')) : null
    if (vendor && CONTROLLER_VENDORS.has(vendor)) return []
    const device = join(devRoot, name)
    let real = device
    try { real = realpathSync(device) } catch {}
    return [{ link: links.get(real) ?? device, device, usbPath, usbInterface: ttyUsbInterface(name, sysRoot) }]
  }).sort((a, b) => (a.usbInterface ?? a.usbPath ?? a.device).localeCompare(b.usbInterface ?? b.usbPath ?? b.device, undefined, { numeric: true }))
}

export function diffUsb(before: UsbDevice[], after: UsbDevice[]): { added: UsbDevice[], removed: UsbDevice[] } {
  const key = (device: UsbDevice) => `${device.path}|${device.usbId}|${device.devnum ?? ''}`
  const old = new Set(before.map(key))
  const now = new Set(after.map(key))
  return { added: after.filter(device => !old.has(key(device))), removed: before.filter(device => !now.has(key(device))) }
}

export interface FastbootRunner { run(args: string[], timeoutMs?: number): Promise<string> }

export const fastbootTool: FastbootRunner = {
  run(args, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      execFile('fastboot', args, { timeout: timeoutMs }, (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim()
        if (error) reject(new Error(`fastboot ${args.join(' ')} 失败：${output || error.message}`))
        else resolve(output)
      })
    })
  },
}

export interface ScriptResult { code: number | null, output: string, timedOut: boolean }
export interface ScriptRunner { run(script: string, env: Record<string, string>, timeoutMs: number): Promise<ScriptResult> }

const SCRIPT_OUTPUT_LIMIT = 16_000

/**
 * Run a slot script as boardd's user: with the interpreter its `#!` line names, otherwise bash. It runs in its own process
 * group so a timeout stops everything it started; output keeps its last 16 kB.
 */
export const scriptRunner: ScriptRunner = {
  run(script, env, timeoutMs) {
    const dir = mkdtempSync(join(tmpdir(), 'boards-script-'))
    const file = join(dir, 'run')
    writeFileSync(file, script.endsWith('\n') ? script : `${script}\n`, { mode: 0o700 })
    chmodSync(file, 0o700)
    const child = script.startsWith('#!')
      ? spawn(file, [], { env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('bash', [file], { env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const collect = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-SCRIPT_OUTPUT_LIMIT) }
    child.stdout!.on('data', collect)
    child.stderr!.on('data', collect)
    return new Promise(resolve => {
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, 'SIGKILL') } catch {} }, timeoutMs)
      let finished = false
      const done = (code: number | null) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        rmSync(dir, { recursive: true, force: true })
        resolve({ code, output: output.trim(), timedOut })
      }
      child.on('error', error => { output += error.message; done(null) })
      child.on('close', code => done(code))
    })
  },
}

/** Load an image into RAM through the boot ROM and let it run. Never flashes. */
export async function stageAndContinue(runner: FastbootRunner, usbPath: string, image: string, timeoutMs?: number): Promise<string> {
  const selector = `usb:${usbPath}`
  const staged = await runner.run(['-s', selector, 'stage', image], timeoutMs)
  const resumed = await runner.run(['-s', selector, 'continue'])
  return `${staged}\n${resumed}`
}
