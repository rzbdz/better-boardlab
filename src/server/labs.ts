/**
 * Remote labs: boards someone else racks and controls. boardd reaches them only through the lab's own web API and a
 * jump host next to the boards; their power, serial ports and download ports never show up on this machine.
 */
import { execFile, spawn } from 'node:child_process'
import { Duplex } from 'node:stream'
import type { MuxSession } from './serial-mux.ts'

export interface LabConfig { url: string, username: string, password: string, jump: string }

/** One board as the lab lists it. */
export interface LabDevice {
  name: string
  model: string | null
  /** The lab sees the board's own system running. */
  online: boolean
  serialPort: string | null
  /** The lab's serial reader has the port open; consoles need it. */
  serialConnected: boolean
  /** Its download port on the jump host, in the `3-2.3` form `fastboot -s usb:` takes. */
  downloadUsbPath: string | null
  ip: string | null
}

export interface LabDriver {
  /** What kind of lab this is, shown on the page. */
  kind: string
  /** The jump host to use when none is set, from the lab's address. */
  defaultJump(url: URL): string
  verify(config: LabConfig): Promise<string>
  devices(config: LabConfig): Promise<LabDevice[]>
  reset(config: LabConfig, device: string): Promise<void>
  /**
   * Restart the board into its boot ROM's download mode. A lab that only learns which download port is the board's by
   * watching it appear returns that port.
   */
  fastboot(config: LabConfig, device: string): Promise<string | void>
  /** `history: false` skips the console's backlog when only new output matters, as for input. */
  console(config: LabConfig, device: string, options?: { history?: boolean }): Promise<MuxSession>
  /** Load a file into RAM through the download port on the jump host and let it run. Never flashes. */
  stage(config: LabConfig, usbPath: string, file: { path: string, sha256: string }, timeoutMs?: number): Promise<string>
  /** Whether the download port is enumerated on the jump host. */
  present(config: LabConfig, usbPath: string): Promise<boolean>
}

/** `user@host` or `user@host:port`. */
export const JUMP = /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+(:\d{1,5})?$/
const USB_PATH = /^\d+-[\d.]+$/
const SHA256 = /^[0-9a-f]{64}$/
/** boardd's directory on a jump host. */
const CACHE = '.cache/troy-boards'
/** Files staged through a jump host, by sha256; ones unused for a few days go, and nothing else there is touched. */
const FILES = `${CACHE}/files`
/** A jump host without fastboot installed can keep one under boardd's directory instead. */
export const FASTBOOT = `"$(command -v fastboot || echo ${CACHE}/bin/fastboot)"`

export interface ShellResult { code: number | null, output: string }
/** Commands, copies and TCP connections through a jump host. */
export interface Shell {
  run(jump: string, command: string, timeoutMs?: number): Promise<ShellResult>
  copy(jump: string, local: string, remote: string, timeoutMs?: number): Promise<ShellResult>
  /** A TCP connection to `host:port` made from the jump host. */
  connect(jump: string, host: string, port: number): Duplex
}

/**
 * ssh and scp as boardd's user, with its own keys and no prompts. Connections are shared for a while, so polling a
 * download port or staging several files does not log in each time.
 */
export function sshShell(controlDir: string): Shell {
  const options = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ControlMaster=auto', '-o', `ControlPath=${controlDir}/%C`, '-o', 'ControlPersist=120']
  const split = (jump: string) => {
    if (!JUMP.test(jump)) throw new Error(`跳板机格式不对：${jump}（要写成 user@host 或 user@host:port）`)
    const [target, port] = jump.split(':')
    return { target: target!, port }
  }
  const exec = (command: string, args: string[], timeoutMs: number) => new Promise<ShellResult>(resolve => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim()
      if (!error) return resolve({ code: 0, output })
      const code = typeof error.code === 'number' ? error.code : null
      resolve({ code, output: output || (error.killed ? `超过 ${timeoutMs / 1000} 秒没有结束` : error.message) })
    })
  })
  return {
    run: (jump, command, timeoutMs = 30_000) => {
      const { target, port } = split(jump)
      return exec('ssh', [...options, ...(port ? ['-p', port] : []), target, command], timeoutMs)
    },
    copy: (jump, local, remote, timeoutMs = 300_000) => {
      const { target, port } = split(jump)
      return exec('scp', ['-q', ...options, ...(port ? ['-P', port] : []), local, `${target}:${remote}`], timeoutMs)
    },
    connect: (jump, host, port) => {
      const { target, port: sshPort } = split(jump)
      const child = spawn('ssh', [...options, ...(sshPort ? ['-p', sshPort] : []), '-W', `${host}:${port}`, target], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-500) })
      const stream = Duplex.from({ readable: child.stdout, writable: child.stdin })
      child.on('error', error => stream.destroy(error))
      child.on('exit', code => { if (code) stream.destroy(new Error(`连不上跳板机 ${jump}：${stderr.trim() || `ssh 退出码 ${code}`}`)) })
      stream.on('close', () => child.kill())
      return stream
    },
  }
}

const tail = (text: string) => text.split('\n').slice(-6).join('\n').slice(-600)

/**
 * Stage a file through fastboot on the jump host. The file is copied once, checked against its sha256 and kept by it,
 * so booting the same kernel again copies nothing.
 */
export async function jumpStage(shell: Shell, jump: string, usbPath: string, file: { path: string, sha256: string }, timeoutMs = 30_000): Promise<string> {
  if (!USB_PATH.test(usbPath)) throw new Error(`下载口路径不对：${usbPath}`)
  if (!SHA256.test(file.sha256)) throw new Error(`sha256 不对：${file.sha256}`)
  const remote = `${FILES}/${file.sha256}`
  const cached = await shell.run(jump, `test -s ${remote} && touch ${remote}`)
  if (cached.code !== 0) {
    const prepared = await shell.run(jump, `mkdir -p ${FILES} && find ${FILES} -type f -mtime +3 -delete`)
    if (prepared.code !== 0) throw new Error(`跳板机 ${jump} 上准备目录失败：${tail(prepared.output)}`)
    const copied = await shell.copy(jump, file.path, `${remote}.part`)
    if (copied.code !== 0) throw new Error(`传到跳板机 ${jump} 失败：${tail(copied.output)}`)
    const checked = await shell.run(jump, `echo '${file.sha256}  ${remote}.part' | sha256sum -c --quiet && mv ${remote}.part ${remote}`)
    if (checked.code !== 0) throw new Error(`传到跳板机的文件 sha256 不对：${tail(checked.output)}`)
  }
  const selector = `usb:${usbPath}`
  const result = await shell.run(jump, `f=${FASTBOOT}; "$f" -s ${selector} stage ${remote} && "$f" -s ${selector} continue`, timeoutMs + 30_000)
  if (result.code === 0) return result.output
  if (/no permissions/.test(result.output)) {
    throw new Error(`跳板机 ${jump} 的账号打不开下载口 ${usbPath}（没有 USB 权限）。要在跳板机上加一条 udev 规则，例如 SUBSYSTEM=="usb", ATTR{idVendor}=="361c", MODE="0660", GROUP="plugdev"，账号要在 plugdev 组里`)
  }
  throw new Error(`跳板机上 fastboot 失败：${tail(result.output)}`)
}

export async function jumpPresent(shell: Shell, jump: string, usbPath: string): Promise<boolean> {
  if (!USB_PATH.test(usbPath)) throw new Error(`下载口路径不对：${usbPath}`)
  const result = await shell.run(jump, `test -e /sys/bus/usb/devices/${usbPath}/idVendor`, 15_000)
  if (result.code === 0) return true
  if (result.code === 1) return false
  throw new Error(`连不上跳板机 ${jump}：${tail(result.output)}`)
}

/** A device range such as `sub0-* sub1-3`: names or `*` patterns separated by spaces or commas. Empty takes every board. */
export function deviceFilter(text: string | null): (name: string) => boolean {
  const patterns = (text ?? '').split(/[\s,]+/).filter(Boolean)
  if (!patterns.length) return () => true
  const tests = patterns.map(pattern => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\-]/g, '\\$&').replace(/\*/g, '.*')}$`))
  return name => tests.some(test => test.test(name))
}
export const DEVICE_PATTERN = /^[A-Za-z0-9_.*-]+$/
