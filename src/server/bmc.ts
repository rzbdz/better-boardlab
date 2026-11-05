/**
 * SpacemiT's BMC cluster manager ("SpaceMit BMC 集群管理系统"): an HTTP API with Basic auth for power and download
 * mode, serial consoles over its WebSocket, and fastboot on the cluster host itself, which is the jump host.
 */
import { FASTBOOT, jumpPresent, jumpStage, type LabConfig, type LabDevice, type LabDriver, type Shell } from './labs.ts'
import type { MuxSession } from './serial-mux.ts'

const TIMEOUT_MS = 15_000
const PAGE_SIZE = 100
/** How long the BMC may take to show the download port after it was asked for download mode. */
const DOWNLOAD_WAIT_MS = 20_000
/** The BMC's serial reader stops passing output on once the board loses power; it is reopened after the power cycle. */
const REOPEN_DELAY_MS = 1_000
const OPEN_TIMEOUT_MS = 10_000
/** The BMC sends a port's history as the first frame; a quiet port may send none. */
const HISTORY_WAIT_MS = 2_000
const HISTORY_LINES = 2_000

type Socket = Pick<WebSocket, 'send' | 'close' | 'binaryType' | 'onopen' | 'onmessage' | 'onerror' | 'onclose'>

export interface BmcOptions {
  sleep?: (ms: number) => Promise<void>
  /** Tests replace the WebSocket. */
  socket?: (url: string) => Socket
}

const basic = (config: LabConfig) => Buffer.from(`${config.username}:${config.password}`).toString('base64')
const apiBase = (config: LabConfig) => `${new URL(config.url).origin}/api/v1`
const name = (device: string) => encodeURIComponent(device)

/** `1-2-1` as the BMC writes a download port, `1-2.1` as sysfs and fastboot do. */
export function usbPathOf(port: string | null | undefined): string | null {
  const parts = (port ?? '').split('-')
  if (parts.length < 2 || parts.some(part => !/^\d+$/.test(part))) return null
  return `${parts[0]}-${parts.slice(1).join('.')}`
}

async function api(config: LabConfig, method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
  let response: Response
  try {
    response = await fetch(`${apiBase(config)}${path}`, {
      method, signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Authorization: `Basic ${basic(config)}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    throw new Error(`连不上 BMC ${new URL(config.url).origin}：${((error as Error).cause as Error | undefined)?.message ?? (error as Error).message}`)
  }
  const text = await response.text()
  let json: any = null
  try { json = JSON.parse(text) } catch {}
  if (response.status === 401) throw new Error('BMC 拒绝了账号或密码（401）')
  if (!response.ok) throw new Error(`BMC ${method} ${path.split('?')[0]} 返回 ${response.status}：${json?.message ?? text.slice(0, 200)}`)
  // Most answers come in a {code, message, data} envelope; the serial ones are bare.
  if (json && typeof json === 'object' && 'code' in json && 'data' in json) {
    if (json.code !== 0) throw new Error(`BMC ${method} ${path.split('?')[0]} 失败：${json.message ?? json.code}`)
    return json.data
  }
  return json
}

export function spacemitBmc(shell: Shell, options: BmcOptions = {}): LabDriver {
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const socket = options.socket ?? (url => new WebSocket(url))
  // Reopening the reader is what the BMC's own page offers when a console goes quiet; failing it fails nothing else.
  const reopen = async (config: LabConfig, device: string) => {
    await sleep(REOPEN_DELAY_MS)
    await api(config, 'POST', `/serial/${name(device)}/reconnect`).catch(() => {})
  }
  const flashMode = async (config: LabConfig, device: string) => {
    const data = await api(config, 'GET', `/devices/flash-mode?device_names=${name(device)}`)
    return (data?.results ?? []).some((item: any) => item.device_name === device && item.flash_mode === true)
  }

  return {
    kind: 'SpacemiT BMC 集群',
    defaultJump: url => `ubuntu@${url.hostname}`,

    async verify(config) {
      const version = await api(config, 'GET', '/version').catch(() => null)
      await api(config, 'GET', '/user/info')
      const page = await api(config, 'GET', '/devices?page=1&page_size=1')
      const bmc = `BMC${version?.version ? ` ${version.version}` : ''} 登录正常，${Number(page?.total ?? 0)} 台设备`
      const fastboot = await shell.run(config.jump, `f=${FASTBOOT}; [ -x "$f" ] && echo "$f"`, 20_000)
      if (fastboot.code === 0) return `${bmc}；跳板机 ${config.jump} 可登录，fastboot 在 ${fastboot.output.split('\n').at(-1)}`
      if (fastboot.code === 1) throw new Error(`${bmc}；跳板机 ${config.jump} 上没有 fastboot，boot 和 stage 用不了`)
      throw new Error(`${bmc}；跳板机 ${config.jump} 登录不了，boot 和 stage 用不了：${fastboot.output.slice(-300)}`)
    },

    async devices(config) {
      const list: any[] = []
      for (let page = 1; page <= 100; page++) {
        const data = await api(config, 'GET', `/devices?page=${page}&page_size=${PAGE_SIZE}`)
        const items: any[] = Array.isArray(data?.list) ? data.list : []
        list.push(...items)
        if (!items.length || list.length >= Number(data?.total ?? 0)) break
      }
      const serials: any[] = (await api(config, 'GET', '/serial'))?.serials ?? []
      const connected = new Set(serials.filter(item => item.connected).map(item => String(item.port)))
      return list.map((item): LabDevice => ({
        name: String(item.name),
        // A board whose system has not reported yet shows up as "unknow".
        model: typeof item.model === 'string' && !/^(unknown?)?$/i.test(item.model) ? item.model : null,
        online: item.status === 'online',
        serialPort: item.serial_port || null,
        serialConnected: !!item.serial_port && connected.has(String(item.serial_port)),
        downloadUsbPath: usbPathOf(item.fastboot_port),
        ip: item.ip || null,
      }))
    },

    async reset(config, device) {
      await api(config, 'POST', `/openbmc/devices/${name(device)}/reset`, { reset_type: 'ForceRestart' })
      await reopen(config, device)
    },

    async fastboot(config, device) {
      await api(config, 'POST', `/openbmc/devices/${name(device)}/firmware-update`)
      await reopen(config, device)
      for (let waited = REOPEN_DELAY_MS; ; waited += 1_000) {
        if (await flashMode(config, device)) return
        if (waited >= DOWNLOAD_WAIT_MS) throw new Error(`已经让 ${device} 进下载模式，但 ${DOWNLOAD_WAIT_MS / 1000} 秒内 BMC 没有看到它的下载口`)
        await sleep(1_000)
      }
    },

    console(config, device) {
      const url = new URL(`${apiBase(config)}/serial/${name(device)}/ws`)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('auth', basic(config))
      const ws = socket(url.toString())
      ws.binaryType = 'arraybuffer'
      const outputs = new Set<(data: Buffer) => void>()
      const closes = new Set<(reason: string) => void>()
      const session: MuxSession = {
        hello: { alias: device, device: null, baud: 115200, transport: 'bmc' },
        history: [],
        // The BMC's page sends keystrokes as plain text frames; JSON frames are its own control messages.
        send: data => ws.send(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')),
        onOutput: listener => { outputs.add(listener); return () => outputs.delete(listener) },
        onClose: listener => { closes.add(listener) },
        close: () => { outputs.clear(); closes.clear(); ws.close() },
      }
      return new Promise<MuxSession>((resolve, reject) => {
        let ready = false
        let timer = setTimeout(() => { ws.close(); reject(new Error(`${OPEN_TIMEOUT_MS / 1000} 秒内没有连上 ${device} 的 BMC 串口`)) }, OPEN_TIMEOUT_MS)
        const settle = () => { if (ready) return; ready = true; clearTimeout(timer); resolve(session) }
        ws.onopen = () => { clearTimeout(timer); timer = setTimeout(settle, HISTORY_WAIT_MS) }
        ws.onmessage = event => {
          let chunk: Buffer
          if (typeof event.data !== 'string') chunk = Buffer.from(event.data as ArrayBuffer)
          else {
            let message: any = null
            try { message = JSON.parse(event.data) } catch {}
            if (message?.type === 'history' && !ready) {
              session.history = String(message.data ?? '').split(/\r?\n/).slice(-HISTORY_LINES)
              return settle()
            }
            if (message && typeof message === 'object') {
              if (message.type !== 'data' && message.type !== 'history') return
              chunk = Buffer.from(String(message.data ?? ''))
            } else chunk = Buffer.from(event.data)
          }
          settle()
          outputs.forEach(listener => listener(chunk))
        }
        ws.onerror = () => {}
        ws.onclose = event => {
          if (!ready) { ready = true; clearTimeout(timer); reject(new Error(`${device} 的 BMC 串口连接失败（${event.code}${event.reason ? ` ${event.reason}` : ''}）`)); return }
          closes.forEach(listener => listener(`BMC 串口连接关闭（${event.code}）`))
        }
      })
    },

    stage: (config, usbPath, file, timeoutMs) => jumpStage(shell, config.jump, usbPath, file, timeoutMs),
    present: (config, usbPath) => jumpPresent(shell, config.jump, usbPath),
  }
}
