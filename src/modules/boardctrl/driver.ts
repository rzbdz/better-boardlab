/**
 * bsp board hosts as a lab. boardd drives them only through the `bsp` CLI (`--json --stateless`), never through bsp's
 * files or code: listing, leases, reset, download mode, staging and RAM boot are `boardctrl dut …` commands, and the console
 * is `boardctrl dut pipe`, which carries serial-mux's own protocol from the board host to boardd's serial-mux client. Which
 * hosts there are comes from bsp's own configuration (its site and host registry), so new hosts need nothing here.
 */
import { Duplex } from 'node:stream'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CancelledError } from 'boardlab-core/core/errors.ts'
import { CHANNEL_ACTIONS, type LabConfig, type LabDevice, type LabFinding, type Backend, type LabHolder, type LabNews, type LabSlots, type Notice } from 'boardlab-core/core/backend.ts'
import type { BootMark, DiscoveryContext, DiscoveryMethod, DiscoveryValues, FlashPlan } from 'boardlab-core/shared/types.ts'
import type { ConsoleSession } from 'boardlab-core/core/console.ts'
import { muxSession } from '../serial-mux/client.ts'
import { askedIn } from 'boardlab-core/core/relay.ts'
import { cliEnv } from './cli-env.ts'
import { bspDebug } from './debug.ts'
import { bootMarksOf, logArgs, logRange, newerQuery, OLD_HOST_LINES, oldHostLog, olderHost, type HostLog } from './logs.ts'
import { openRaw } from './console.ts'
import { cancellable, EXIT_CANCELLED, runCli, spawnPipe } from './process.ts'
import { nothingToCancel } from './cancel.ts'
import { followJob, reportingJob } from './follow.ts'
import { debugOf, DEVICE_NAME, isSlot, SLOT_LEASE, type BoardctrlDut, type BoardctrlPin, type BoardctrlSlot, type BoardctrlSpec } from './records.ts'
import type { BoardctrlResult } from './process.ts'
export { EXIT_CANCELLED, jobIn, killGroup, runCli, type BoardctrlResult } from './process.ts'

/** Holders boardd gives its boardctrl leases: `boardlab:<holder of the lock>`. */
export const HOLDER_PREFIX = 'boardlab:'
/** boardctrl leases end unless renewed; boardd renews at every lab sync (each minute). */
const LEASE_TTL_S = 600
const TIMEOUT_MS = 60_000

/** A reset of a board that needs a person waits for them. */
const RESET_TIMEOUT_MS = 30 * 60_000
const BOOT_TIMEOUT_MS = 30 * 60_000

/** The controller CLI on this machine: `boardctrl` when it is installed, else the old `bsp`. */
export function cliName(): string {
  const found = (process.env.PATH ?? '').split(':').filter(Boolean).find(dir => existsSync(join(dir, 'boardctrl')))
  return found ? 'boardctrl' : 'bsp'
}

/**
 * `onStderr` gets the progress lines bsp prints while it works; `signal` kills it, and every process it started (the
 * driver aborts it only when there is nothing on the host left to wait for).
 */
export type BoardctrlRunner = (args: string[], options: { env: NodeJS.ProcessEnv, timeoutMs: number, onStderr?: (line: string) => void, signal?: AbortSignal }) => Promise<BoardctrlResult>
/** Starts `bsp … dut pipe`; its stdin and stdout are the pipe. */
export type BoardctrlSpawner = (args: string[], env: NodeJS.ProcessEnv) => { stream: Duplex, stderr: () => string }

/**
 * `sshKey`: the key boardd logs in to hosts it set up with (bspd+ssh:// labs). `cancelGraceMs`: how long a cancelled
 * job's CLI may take to follow the job to its end before it is killed.
 */
export interface BoardctrlOptions { bin?: string, run?: BoardctrlRunner, spawn?: BoardctrlSpawner, sshKey?: string, stateDir?: string, cancelGraceMs?: number }

/** How a board's bsp record may be changed from boardlab (`boardctrl dut set`); fields left out stay as they are. */
export interface BoardctrlBoardChange {
  board?: string, soc?: string, description?: string, usb?: string,
  resetPin?: string, pulseMs?: number, fdl?: 'strapped' | 'button' | 'unset', fdlPin?: string, sdks?: string[],
}
export const FDL_STRATEGIES = ['strapped', 'button', 'unset'] as const

/** The bsp backend, and what only the bsp module asks of it. */
/** What a host's artifact cache holds against its bounds, as the host's status reports it (bytes, but `entries`, `held`). */
export interface HostCache { path: string, used: number, entries: number, held: number, max_bytes: number, ttl_s: number, min_free_bytes: number, free: number | null }

export interface BoardctrlBackend extends Backend {
  /** Each host of the lab and its artifact cache (null from a host without the policy, an error for one not reached). */
  caches(config: LabConfig): Promise<Array<{ host: string, cache: HostCache | null, error: string | null }>>
  /** Change a board's record in bspd, holding its lease (`token`); says which fields changed. */
  change(config: LabConfig, device: string, token: string | null, change: BoardctrlBoardChange): Promise<string[]>
  /** The board's own record and the actual choices on its host for a dropdown editor. */
  boardConfig(config: LabConfig, device: string, fresh?: boolean): Promise<{
    control: { backend?: string, reset?: { pin?: string }, fdl?: { strategy?: string, pin?: string } }
    usb: string | null, gpios: Array<{ value: string, label: string }>, ports: Array<{ value: string, label: string }>
    soc: string | null, sdks: string[], socs: Array<{ value: string, label: string }>, sdkOptions: Array<{ value: string, label: string }>
  }>
}

export function boardctrlLab(options: BoardctrlOptions = {}): BoardctrlBackend {
  // The board controller CLI; `bsp` is its old name, still installed on machines set up before the rename.
  const bin = options.bin ?? process.env.BOARDS_BOARDCTRL ?? cliName()
  const run: BoardctrlRunner = options.run ?? ((args, options) => runCli(bin, args, options))
  const cancelGraceMs = options.cancelGraceMs
  const start: BoardctrlSpawner = options.spawn ?? ((args, env) => spawnPipe(bin, args, env))

  /**
   * `url` names a boardctrl host registry, `username` the hosts to use (`-r`), `password` the hosts' API token. Commands on a
   * host's own hardware (its relay controller) go to that host alone.
   */
  // `url` is either one bspd reached directly (`bspd+http://127.0.0.1:8765`, this machine's on a board host), or a bsp
  // registry that lists several hosts (a plain URL, or empty for bsp's own site).
  const direct = (config: LabConfig) => config.url.startsWith('bspd+')
  // `bspd+ssh://root@host:8765` (a host boardlab set up): the boardctrl CLI's `ssh://`, through boardd's own key.
  const bspdUrl = (config: LabConfig) => config.url.slice('bspd+'.length)
  const registryUrl = (config: LabConfig) => config.url
  const global = (config: LabConfig, host?: string) => ['--json', '--stateless', ...(direct(config) ? ['--url', bspdUrl(config)]
    : host ? ['-r', host] : config.username.trim() ? ['-r', config.username.trim()] : [])]
  const site = options.stateDir ? join(options.stateDir, 'boardctrl', 'site') : null
  const env = (config: LabConfig) => cliEnv({ config, site, sshKey: options.sshKey, direct: direct(config), url: registryUrl(config) })
  /** Run a bsp command; `signal` stops it as `cancellable` says (`dut`/`job cancel` under the lease of `on`, the board). */
  const boardctrlCli = async <T>(config: LabConfig, args: string[], timeoutMs = TIMEOUT_MS, onStderr?: (line: string) => void, host?: string, signal?: AbortSignal, on?: { readonly device: string, readonly lease: string | null }): Promise<T> => {
    const result = await cancellable(
      (onLine, kill) => run([...global(config, host), ...args], { env: env(config), timeoutMs, onStderr: onLine, signal: kill }),
      (what, at) => boardctrlCli(config, what, 60_000, undefined, at ?? host),
      { onStderr, signal, stop: on ? () => ['dut', 'cancel', on.device, ...lease(on.lease)] : undefined, jobArgs: on ? () => lease(on.lease) : undefined, graceMs: cancelGraceMs })
    let envelope: { ok: boolean, result?: T, warnings?: string[], error?: { code?: string, message?: string, hint?: string, details?: Record<string, unknown> } } | null = null
    try { envelope = JSON.parse(result.stdout) } catch {}
    const what = `bsp ${args.slice(0, 2).join(' ')}`
    const cancelling = !!signal?.aborted && signal.reason instanceof CancelledError && !signal.reason.refused
    if (result.code === EXIT_CANCELLED || envelope?.error?.code === 'cancelled') {
      throw cancelling ? signal!.reason : new CancelledError(`已取消：${what}：${envelope?.error?.message ?? '主机上的任务被取消了'}`)
    }
    if (signal?.aborted && !(signal.reason instanceof CancelledError && signal.reason.refused)) {
      if (!cancelling) throw new Error(`${what} 停下了：${(signal.reason as Error | undefined)?.message ?? '锁已经结束'}`)
      // Asked to stop, it finished anyway (it was past its last step): what it did stands.
      if (!envelope?.ok) throw signal.reason
    }
    // A host bsp could not reach leaves `ok: true` and the failure only in the warnings (and exit code 3): a stale token
    // then looks like a lab with no boards, and boardd drops every one of them. Any unreachable host is an error, so
    // the listing is never taken as complete and the boards already known stay.
    if (envelope?.ok) {
      const unreachable = (envelope.warnings ?? []).filter(line => /unreachable/i.test(line))
      if (unreachable.length) throw new Error(`bsp ${args.slice(0, 2).join(' ')}：${unreachable.join('；')}`)
      return envelope.result as T
    }
    const error = envelope?.error
    if (error) throw Object.assign(new Error(`bsp ${args.slice(0, 2).join(' ')}：${error.message}${error.hint ? `（${error.hint}）` : ''}`), { boardctrl: error })
    const text = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-4).join('\n')
    throw new Error(`bsp ${args.slice(0, 2).join(' ')} 失败${result.code === null ? '（超时或没能运行）' : `（退出码 ${result.code}）`}${text ? `：${text}` : ''}`)
  }

  /** A `boardctrl probe` run (a discovery or a rebuild): boards bsp registered as it went, and the rest as findings. */
  const probed = async (config: LabConfig, args: string[], progress: (line: string) => void,
    registered: ((device: string) => void) | undefined, host?: string, signal?: AbortSignal): Promise<{ found: LabFinding[], message: string }> => {
    const onLine = (line: string) => {
      progress(line)
      const done = line.match(/\bregistered (\S+)(?: in slot \S+)?$/)
      if (done) registered?.(done[1]!)
    }
    type Result = { proposals?: Array<{ spec: BoardctrlSpec, warnings?: string[], registered?: { dut: string } }>, registered?: Array<{ dut: string }>, reasons?: string[] }
    const out = await boardctrlCli<{ results: Record<string, Result> }>(config, args, BOOT_TIMEOUT_MS, onLine, host, signal)
    const results = Object.entries(out.results ?? {})
    // What bsp could not register (a name taken, say) is left for a person to apply as a proposal.
    const found = results.flatMap(([at, result]) => (result.proposals ?? []).filter(item => !item.registered).map(({ spec, warnings }) => ({
      host: at, name: spec.id, warnings: warnings ?? [], detail: spec,
      summary: `${at} 上的新板子：${spec.board || '型号未知'}${spec.soc ? `（${spec.soc}）` : ''}，串口 ${spec.console?.alias ?? spec.console?.device ?? '?'}，下载口 ${spec.fastboot?.usb ?? '?'}，${spec.control?.backend === 'human' ? '由人复位' : `复位线 ${spec.control?.reset?.pin ?? '?'}`}`,
    })))
    const added = results.flatMap(([at, result]) => (result.registered ?? []).map(item => `${at}/${item.dut}`))
    const reasons = results.flatMap(([at, result]) => (result.reasons ?? []).map(reason => `${at}：${reason}`))
    const where = results.map(([at]) => at).join('、') || '（没有主机完成）'
    const message = [
      ...(added.length ? [`登记了 ${added.length} 块：${added.join('、')}`] : []),
      ...(found.length ? [`${where} 上发现 ${found.length} 块${added.length ? '没能自动登记的' : '新'}板子，到「扫描」确认后登记`] : []),
      ...(!added.length && !found.length ? [`boardctrl probe 在 ${where} 上没有发现新板子`] : []),
      ...reasons,
    ].join('；')
    return { found, message }
  }
  const lease = (token: string | null | undefined) => token && token !== SLOT_LEASE ? ['--lease', token] : []
  /** Break points by catalog target, briefly: `boardctrl sdk show` is slow and the page asks on every dialog change. */
  const BREAKS_TTL_MS = 30_000
  const breaksCache = new Map<string, { at: number, value: { load: string[], download: string[] } }>()
  const breaksAsking = new Map<string, Promise<{ load: string[], download: string[] }>>()
  const bootMarks = bootMarksOf((config, device) => boardctrlCli<{ marks?: BootMark[] }>(config, ['dut', 'boot-marks', device], 30_000))
  /**
   * A person is asked to press something: bspd says what in the DUT's status (`needs_human`), while the reset (or
   * entering download mode) waits. The command's own output only reports it in passing, so it is polled here and the
   * page is told as it comes and goes.
   */
  const watchingHuman = (config: LabConfig, device: string, notice?: Notice, signal?: AbortSignal) => {
    if (!notice) return () => {}
    let stopped = false, last: string | null = null, lastRequest: string | null = null
    const tick = async () => {
      while (!stopped && !signal?.aborted) {
        const status = await boardctrlCli<{ needs_human?: { id?: string, message?: string } | null }>(config, ['dut', 'status', device], 15_000).catch(() => null)
        const message = status?.needs_human?.message ?? null, request = status?.needs_human?.id ?? null
        if (message !== last || request !== lastRequest) { last = message; lastRequest = request; notice(message, request) }
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }
    void tick()
    return () => { stopped = true; notice(null) }
  }

  /** The command's output and the polled status say the same thing: the page is told only when it changes. */
  const once = (notice?: Notice) => {
    let told: string | null = null, toldRequest: string | null = null
    return (message: string | null, request?: string | null) => {
      // A new ask with the same words is a new request: the page must get its id, or a click answers the old one.
      if (message === told && (request ?? null) === toldRequest) return
      told = message; toldRequest = request ?? null; notice?.(message, request ?? null)
    }
  }

  /** Progress lines of a reset: what a person is asked to do (with bsp's request id), and when it is done. */
  const attention = (notice?: Notice) => notice && ((line: string) => {
    const asked = askedIn(line)
    if (asked) notice(asked.message, asked.request)
    else if (/: (confirmed by a person|detected )/.test(line)) notice(null)
  })

  /** The host each DUT is on, as last listed; a DUT not listed yet is looked up. */
  const hostOf = new Map<string, string>()
  const hostsAsking = new Map<string, Promise<void>>()
  const boardOf = new Map<string, BoardctrlDut>()
  /** A registration dialog needs the DUT's saved record, not another fastboot/console/control status read. */
  const recordOfBoard = async (config: LabConfig, device: string): Promise<BoardctrlDut> => {
    if (!boardOf.has(device)) {
      const key = `${config.url}\u0000${config.username}`
      let asking = hostsAsking.get(key)
      if (!asking) {
        asking = boardctrlCli<BoardctrlDut[]>(config, ['dut', 'list']).then(duts => {
          for (const dut of duts) {
            hostOf.set(dut.id, dut.host)
            boardOf.set(dut.id, { ...dut, control: { ...dut.control, reset: { ...dut.control?.reset }, fdl: { ...dut.control?.fdl } } })
          }
        })
        hostsAsking.set(key, asking)
        void asking.finally(() => { if (hostsAsking.get(key) === asking) hostsAsking.delete(key) }).catch(() => {})
      }
      await asking
    }
    const found = boardOf.get(device)
    if (!found) throw new Error(`bsp 里没有板子 ${device}`)
    return found
  }
  const hostOfBoard = async (config: LabConfig, device: string) => (await recordOfBoard(config, device)).host

  // A registration dialog is a read of the host's inventory, not a discovery. Keep each host's GPIO list and watched
  // USB snapshot briefly, and share concurrent board dialogs (and a save's validation) instead of spawning three more
  // bsp processes per board. Cable news invalidates the USB snapshot; the current registration is revalidated on save.
  const CHOICES_TTL_MS = 10_000
  type HostChoices = { gpios: Array<{ value: string, label: string }>, ports: Array<{ value: string, label: string }> }
  const choicesCache = new Map<string, { at: number, value: HostChoices }>()
  const choicesAsking = new Map<string, Promise<HostChoices>>()
  const hostChoices = (config: LabConfig, host: string, fresh = false): Promise<HostChoices> => {
    const key = `${config.url}\u0000${config.username}\u0000${host}`
    const hit = choicesCache.get(key)
    if (!fresh && hit && Date.now() - hit.at < CHOICES_TTL_MS) return Promise.resolve(hit.value)
    const asking = choicesAsking.get(key)
    if (asking) return asking
    const ask = (async () => {
      const [pins, ports] = await Promise.all([
        boardctrlCli<BoardctrlPin[]>(config, ['gpio', 'list'], 15_000, undefined, host).catch(() => [] as BoardctrlPin[]),
        boardctrlCli<Array<{ usb: string, vid?: string, pid?: string }>>(config, ['dut', 'ports'], 15_000, undefined, host),
      ])
      const value = {
        gpios: pins.filter(pin => pin.actions?.length).map(pin => ({ value: pin.target, label: `${pin.target}（${pin.label ?? 'GPIO'}）` })),
        ports: ports.map(port => {
          const note = port.vid && port.pid ? `${port.vid}:${port.pid}` : ''
          return { value: port.usb, label: `${port.usb}${note ? `（${note}）` : ''}` }
        }),
      }
      choicesCache.set(key, { at: Date.now(), value })
      return value
    })()
    choicesAsking.set(key, ask)
    return ask.finally(() => { if (choicesAsking.get(key) === ask) choicesAsking.delete(key) })
  }
  const forgetHost = (config: LabConfig, host: string) => {
    const prefix = `${config.url}\u0000${config.username}\u0000${host}`
    for (const key of choicesCache.keys()) if (key === prefix) choicesCache.delete(key)
  }

  /**
   * Each host's free consoles and unbound download ports: what a person binds a board of, and what a probe plans on.
   * Only offered through `ports`; a discovery method's choices are built from it too.
   */
  const freePorts = async (config: LabConfig): Promise<LabSlots[]> => {
    // A dry-run probe touches nothing: it lists each host's free consoles and the download-mode USB devices on it.
    const [plans, duts] = await Promise.all([
      boardctrlCli<Record<string, { consoles?: Array<{ id: string, kind: string, alias?: string, device?: string }>, usb?: Array<{ usb: string, product?: string }> }>>(config, ['probe', '--dry-run'], 120_000),
      boardctrlCli<BoardctrlDut[]>(config, ['dut', 'list']),
    ])
    const used = new Set((Array.isArray(duts) ? duts : []).map(dut => dut.usb))
    return Object.entries(plans).map(([host, plan]) => ({
      host,
      consoles: (plan.consoles ?? []).map(con => ({ id: con.alias ?? con.device ?? con.id, label: con.alias ? `serial-mux ${con.alias}${con.device ? `（${con.device}）` : ''}` : (con.device ?? con.id) })),
      usb: (plan.usb ?? []).filter(device => !used.has(device.usb)).map(device => ({ id: device.usb, label: `${device.usb}${device.product ? ` ${device.product}` : ''}` })),
    }))
  }
  /** The SDK catalog's instances: a board's SDKs, and the SoCs they are built for. */
  const sdkCatalog = async (config: LabConfig): Promise<Array<{ id: string, soc: string | null }>> => {
    const listed = await boardctrlCli<Array<{ id: string, soc: string | null }>>(config, ['sdk', 'list'], 60_000).catch(() => [] as Array<{ id: string, soc: string | null }>)
    return Array.isArray(listed) ? listed : []
  }
  /** A context's slot as bsp's `--slots` takes it (`/s2` → `s2`). */
  const slotId = (slot?: string | null) => slot?.split('/').at(-1) ?? null

  return {
    kind: 'boardctrl 板卡主机',
    about: 'boardd 经 bsp 操作这台主机上的板子：复位线、下载口、串口、刷机和启动都由主机上的 bspd 做，锁和排队以这台 boardd 为准（拿锁时它同时持有 bspd 的租约）。',
    fields: {
      url: { label: 'bspd 地址', placeholder: '本机的 bspd：bspd+http://127.0.0.1:8765（或 bsp registry 的地址）', required: false },
      username: { label: '只用这些 boardctrl 主机', placeholder: '经 registry 时：逗号分隔的主机名；留空用全部', required: false },
      password: { label: 'bspd token', placeholder: 'bspd 要求 token 时填', required: false },
    },
    defaultJump: () => '',

    inventory: {
      async verify(config) {
        const hosts = await boardctrlCli<Array<{ host: string, duts?: string[], error?: string }>>(config, ['hosts'])
        const up = hosts.filter(host => !host.error)
        const down = hosts.filter(host => host.error)
        if (!up.length) throw new Error(`没有连上任何 boardctrl 主机${down.length ? `：${down.map(host => `${host.host}（${host.error}）`).join('，')}` : ''}`)
        const boards = up.reduce((sum, host) => sum + (host.duts?.length ?? 0), 0)
        return `${up.length} 台 boardctrl 主机（${up.map(host => host.host).join('、')}），${boards} 块板子${down.length ? `；连不上：${down.map(host => host.host).join('、')}` : ''}`
      },

      async devices(config) {
        const duts = await boardctrlCli<BoardctrlDut[]>(config, ['dut', 'list'])
        for (const dut of duts) {
          hostOf.set(dut.id, dut.host)
          boardOf.set(dut.id, { ...dut, control: { ...dut.control, reset: { ...dut.control?.reset }, fdl: { ...dut.control?.fdl } } })
        }
        // Slots with no board yet are listed too, by their console: watchable, discoverable. Hosts without slots have none.
        const slots = await boardctrlCli<BoardctrlSlot[]>(config, ['slot', 'list']).catch(() => [] as BoardctrlSlot[])
        const empty = slots.filter(slot => !slot.dut && slot.online).map((slot): LabDevice => ({
          name: `${slot.host}-${slot.id}`, address: slot.ref, slot: slot.ref, empty: true, host: slot.host, model: null, online: false,
          serialPort: `${slot.host}:${slot.alias ?? slot.id}`, serialConnected: slot.console_up ?? true, downloadUsbPath: null, ip: null,
        }))
        return [...duts.map((dut): LabDevice => ({
          slot: dut.slot ? `${dut.host}/${dut.slot}` : null,
          mediaBoot: dut.media_boot ?? null,
          name: dut.id, host: dut.host, sdks: dut.sdks ?? [], model: dut.board || null, soc: dut.soc || null,
          online: false, serialPort: dut.console ? `${dut.host}:${dut.console}` : null,
          // Hosts without console_up predate `boardctrl dut pipe`; opening the console tells.
          serialConnected: dut.console_up ?? true,
          // Its slot's adapter is unplugged or moved: after re-cabling the host wants a rebuild.
          slotGone: dut.slot_online === false,
          // A board found without a download cable has `usb:UNKNOWN` until its port is known.
          downloadUsbPath: dut.usb && !/UNKNOWN/.test(dut.usb) ? dut.usb.replace(/^usb:/, '') : null, ip: null,
          heldBy: dut.lease && !dut.lease.holder.startsWith(HOLDER_PREFIX) ? dut.lease.holder : null,
          // What can debug it, as its host reports it (a provider name plus what it offers; null: none).
          debug: debugOf(dut.services),
          attention: dut.needs_human?.message ?? null,
          // The host's id for that ask: answering it twice with the same id is answering once, even after a restart.
          attentionRequest: dut.needs_human?.id ?? null,
        })), ...empty]
      },
      async refresh(config, target, options, progress, signal) {
        const args = ['dut', 'refresh', target.device, ...lease(target.lease), '--timeout', String(RESET_TIMEOUT_MS / 1000),
          ...(options.name ? ['--name', options.name] : options.rename ? ['--rename'] : [])]
        const job = await boardctrlCli<{ status?: string, error?: { message?: string }, result?: { dut: string, changed?: string[], board?: string, usb?: string, identified?: boolean } }>(config, args, RESET_TIMEOUT_MS + 60_000, progress, undefined, signal, target)
        if (job.status === 'cancelled') throw new CancelledError(`已取消：${target.device} 的重新读取`)
        if (job.status && job.status !== 'succeeded') throw new Error(job.error?.message ?? `boardctrl dut refresh ${job.status}`)
        const r = job.result ?? { dut: target.device }
        return {
          device: r.dut,
          message: `${r.dut}：${r.identified ? `读到 ${r.board ?? '型号未知'}` : '没有读到型号（没有下载口或 SoC 不支持识别）'}${r.changed?.length ? `，改了 ${r.changed.join('、')}` : '，没有变化'}`,
        }
      },
      remove: async (config, device) => { await boardctrlCli(config, ['dut', 'remove', device]) },
    },

    // The DUT's name in bspd changes too, its console alias and reset/fdl aliases with it. bsp drops the lease on a
    // rename, so boardd takes it again for the new name afterwards.
    rename: {
      async rename(config, { device, lease: token }, to) {
        try {
          const result = await boardctrlCli<{ note?: string }>(config, ['dut', 'rename', device, to, '--console', ...lease(token)], 180_000)
          return { device: to, alias: to, message: `${device} → ${to}${result.note ? `（${result.note}）` : ''}` }
        } catch (error) {
          // A retry after an answer that did not arrive: the host may already have renamed it.
          const duts = await boardctrlCli<BoardctrlDut[]>(config, ['dut', 'list']).catch(() => [] as BoardctrlDut[])
          if (duts.some(dut => dut.id === to)) return { device: to, alias: to, message: `${device} → ${to}（主机上已经改好了）` }
          throw error
        }
      },
    },

    relay: {
      // A board reset by a person makes bsp print what to do (`ACTION NEEDED: …`) and wait for `boardctrl dut confirm`, until
      // the lock it runs under ends.
      reset: async (config, at, notice, signal) => {
        const { device, lease: token } = at
        const tell = once(notice)
        const watching = watchingHuman(config, device, tell, signal)
        try { await boardctrlCli(config, ['dut', 'reset', device, '--no-fdl', ...lease(token), '--timeout', '1800'], RESET_TIMEOUT_MS, attention(tell), undefined, signal, at) } finally { watching() }
      },
      enterDownload: async (config, at, notice, signal) => {
        const { device, lease: token } = at
        const tell = once(notice)
        const watching = watchingHuman(config, device, tell, signal)
        try { await boardctrlCli(config, ['dut', 'reset', device, ...lease(token), '--timeout', '1800'], RESET_TIMEOUT_MS, attention(tell), undefined, signal, at) } finally { watching() }
      },
      confirm: async (config, { device }, note, request) => {
        // The request id makes it idempotent: answered already (the board showed it on its own), bsp says so.
        const result = await boardctrlCli<{ confirmed: string, waited_s: number, request?: string, repeat?: boolean, how?: string }>(
          config, ['dut', 'confirm', device, ...(note ? [note] : []), ...(request ? ['--request', request] : [])])
        if (result.repeat) {
          const how = result.how === 'detected' ? '板子自己到位了，已经自动确认'
            : result.how === 'expired' ? '那次等人已经超时结束'
            : result.how === 'superseded' ? '后来实验室又问了一次，这次已经作废' : '之前已经确认过了'
          return `${how}（请求 ${result.request ?? request}，不用再点）`
        }
        return `已确认「${result.confirmed}」（等了 ${result.waited_s} 秒）`
      },
    },

    /**
     * The DUT's lines on its host's relay controller (bsp gpio_relay): every pin with an alias under `<dut>/` — the
     * `reset` and `fdl` lines bsp registers for it, and any others the site aliases there (`<dut>/power`, …).
     */
    channels: {
      async list(config, { device }) {
        const pins = await boardctrlCli<BoardctrlPin[]>(config, ['gpio', 'list'], TIMEOUT_MS, undefined, await hostOfBoard(config, device))
        return pins.flatMap(pin => (pin.aliases ?? []).filter(alias => alias.startsWith(`${device}/`)).map(alias => ({
          id: alias, label: alias.slice(device.length + 1), kind: pin.channel?.mode ?? 'gpio', state: pin.state ?? null,
          actions: CHANNEL_ACTIONS.filter(action => (pin.actions ?? []).includes(action) || (action === 'pulse' && pin.channel?.mode === 'relay') || (action === 'click' && pin.channel?.mode === 'button')),
        })))
      },
      async set(config, { device }, channel, action, ms) {
        if (!channel.startsWith(`${device}/`)) throw new Error(`${channel} 不是 ${device} 的线（要以 ${device}/ 开头）`)
        // bsp groups the actions by channel kind: relays switch and pulse, buttons are pressed and clicked.
        const [group, verb] = ({ on: ['relay', 'on'], off: ['relay', 'off'], toggle: ['relay', 'toggle'], pulse: ['relay', 'pulse'], press: ['button', 'press'], release: ['button', 'release'], click: ['button', 'click'] } as const)[action]
        const timed = verb === 'pulse' || verb === 'click'
        const result = await boardctrlCli<{ target?: string, state?: string }>(config, [group, verb, channel, ...(timed && ms ? ['--ms', String(ms)] : [])], TIMEOUT_MS + (ms ?? 0), undefined, await hostOfBoard(config, device))
        return `${channel}：${verb}${timed && ms ? ` ${ms}ms` : ''}${result.state ? `，现在 ${result.state}` : ''}`
      },
    },

    serial: {
      // What the board's SoC prints as it boots (its boot ROM's lines, and any the site adds): the host's SoC facts.
      bootMarks: (config, { device }) => bootMarks(config, device),
      // The board host keeps each console's log by day; bsp reads a range of it there and searches it, or reads a
      // window of it around a line, each line numbered and named by its place in the day's file.
      async logs(config, { device }, query) {
        try { return logRange(await boardctrlCli<HostLog>(config, logArgs(device, query), 120_000), query.at != null) }
        catch (error) {
          // A host installed before it indexed its logs refuses the new flags: its last lines, numbered here.
          if (!olderHost(error) || !newerQuery(query)) throw error
          return oldHostLog(await boardctrlCli<HostLog>(config, ['dut', 'logs', device, '--limit', String(OLD_HOST_LINES)], 120_000), query)
        }
      },
      async open(config, { device }) {
        // A console that is not serial-mux (a trace channel over a debug adapter) serves plain bytes: the pipe's
        // output is the console, from the moment it is open. serial-mux consoles handshake their protocol.
        const record = await recordOfBoard(config, device).catch(() => null)
        const child = start([...global(config), 'dut', 'pipe', device], env(config))
        if (record?.console_provider && record.console_provider !== 'serial-mux') {
          return openRaw(child, device, record.console_provider)
        }
        // A pipe that could not start prints bsp's error envelope instead of protocol frames.
        let first = ''
        const peek = (chunk: Buffer) => { first += chunk.toString('utf8'); if (first.length > 4096) child.stream.off('data', peek) }
        child.stream.on('data', peek)
        try {
          const session: ConsoleSession = await muxSession(child.stream, device, { timeoutMs: 20_000 })
          child.stream.off('data', peek)
          return session
        } catch (error) {
          let message = (error as Error).message
          try { const envelope = JSON.parse(first); if (envelope?.error?.message) message = `${envelope.error.message}${envelope.error.hint ? `（${envelope.error.hint}）` : ''}` } catch {}
          const stderr = child.stderr().trim()
          throw new Error(`打不开 ${device} 的串口：${message}${stderr && !first ? `：${stderr.split('\n').slice(-3).join(' ')}` : ''}`)
        }
      },
    },

    download: {
      backendFiles: true,
      async stage(config, target, file, timeoutMs = 300_000, signal) {
        // One call on the host, not a job: a cancel stops the upload, or waits for the load already under way.
        const result = await boardctrlCli<{ output: string, file: string, size: number }>(config,
          ['dut', 'stage', target.device, file.path, ...lease(target.lease), '--timeout', String(Math.ceil(timeoutMs / 1000))], timeoutMs + 120_000, undefined, undefined, signal)
        return result.output
      },
      async present(config, target) {
        return (await boardctrlCli<{ present: boolean }>(config, ['dut', 'present', target.device])).present
      },

      async boot(config, at, files, timing, signal) {
        const { device, lease: token } = at
        // `boardlab boot` starts with the board already in download mode, as boardd's own boot does.
        const refs = files.map(file => file.source === 'backend' && !/^https?:\/\//.test(file.path) ? `host:${file.path}` : file.path)
        const job = await boardctrlCli<{ lines?: string[], elapsed_s?: number }>(config, ['dut', 'boot', device, '--files', ...refs, '--no-reset',
          '--first-wait', String(timing.firstMs / 1000), '--later-wait', String(timing.laterMs / 1000), '--port-timeout', String(timing.waitMs / 1000),
          ...lease(token), '--timeout', '1800'], BOOT_TIMEOUT_MS, undefined, undefined, signal, at)
        return (job.lines ?? []).join('\n')
      },
    },

    discovery: {
      // What bsp can do here, in bsp's own terms: probe the host's free reset lines itself, or take a board a person
      // already put in download mode. boardd only shows these; it knows neither the titles nor the fields.
      async methods(config, context) {
        const host = context.host ?? (context.slot ? context.slot.split('/')[0]! : null)
        const methods: DiscoveryMethod[] = []
        methods.push({
          id: 'probe',
          title: '自动刷机',
          about: context.slot
            ? '复位这个槽位的复位线，看哪个串口有反应、哪个下载口出现，把板子配成一对并登记。只动这一个槽位。'
            : host
              ? '实验室逐个拉这台主机上还没用过的复位线，看哪个串口有反应、哪个下载口出现，把板子配成一对并登记。接在这些线上的板子会被复位。已经在用的板子不受影响。'
              : '实验室逐个拉每台主机上还没用过的复位线，看哪个串口有反应、哪个下载口出现，把板子配成一对并登记。接在这些线上的板子会被复位。已经在用的板子不受影响。',
          fields: [
            { id: 'prefer', label: '先试这些复位线', kind: 'text' as const, required: false, placeholder: '例如 12,13、GPIO12、P15',
              note: '知道这批板子接在哪些排针上时填上，先试这些；不填就按主机原来的顺序。' },
          ],
        })
        if (host) {
          const [free, sdkList] = await Promise.all([freePorts(config).then(list => list.find(item => item.host === host)), sdkCatalog(config)])
          const usbs = free?.usb ?? [], consoles = free?.consoles ?? []
          const socs = [...new Set(sdkList.map(item => item.soc).filter((soc): soc is string => !!soc))]
          const wanted = slotId(context.slot)
          const consoleForSlot = wanted ? consoles.find(item => item.id === wanted || item.label.endsWith(`/${wanted}`)) : undefined
          methods.push({
            id: 'bind',
            title: '人工刷机',
            about: '板子没有复位线或按钮：你按住 BOOT 再按 RESET，让它进下载模式，再按新出现的下载口和它的串口登记，选上它的 SoC（SDK 按 SoC 给出来）。请保证此时只有一块还没登记的板子处于下载模式。',
            fields: [
              { id: 'usb', label: '下载口', kind: 'choice', required: true, initial: usbs.length === 1 ? usbs[0]!.id : null,
                options: usbs.map(item => ({ value: item.id, label: item.label })), note: usbs.length ? null : '没有看到未绑定的下载口：让板子进下载模式后刷新；已经登记的下载口不算。' },
              { id: 'console', label: '串口', kind: 'choice', required: true, initial: consoleForSlot?.id ?? (consoles.length === 1 ? consoles[0]!.id : null),
                options: consoles.map(item => ({ value: item.id, label: item.label })), note: consoles.length ? null : '没有空闲串口：接上串口适配器后刷新。' },
              ...(socs.length
                ? [{ id: 'soc', label: 'SoC', kind: 'choice' as const, required: true, initial: socs.length === 1 ? socs[0]! : null,
                  options: socs.map(soc => ({ value: soc, label: soc.toUpperCase() })), note: '登记后这块板子的 SDK 从它和 boardctrl 的 SDK 目录来。' }]
                : [{ id: 'soc', label: 'SoC', kind: 'text' as const, required: false, placeholder: '例如 k1、k3', note: 'boardctrl 的 SDK 目录里还没有 SoC；登记后可以再补。' }]),
              ...(sdkList.length
                ? [{ id: 'sdk', label: 'SDK（可选）', kind: 'choice' as const, required: false, initial: null,
                  options: sdkList.map(item => ({ value: item.id, label: `${item.id}${item.soc ? `（${item.soc.toUpperCase()}）` : ''}` })), note: '留空：用这个 SoC 的全部 SDK。' }]
                : []),
              { id: 'board', label: '型号（可选）', kind: 'text', required: false, placeholder: '例如 k3_com260',
                note: '自动发现会从板子上读型号；人工方式读不到，知道就填上，登记后也能改。' },
              { id: 'name', label: '板名（可选）', kind: 'text', required: false, placeholder: '留空用 tmp-<主机>-<串口>' },
            ],
          })
        }
        // A board a probe cannot find, because what it has is not USB or a cabled console: a person says what it is and
        // gets a DUT record, which the next sync lists like any other board. The host is the one the caller is asking
        // about (the lab knows its hosts), and the SoC list is the catalog's; `services` is bsp's own record, passed
        // through unchanged.
        const knownHost = context.host ?? context.slot?.split('/')[0] ?? (config.username ? config.username.split(',')[0]!.trim() : '')
        const catalog = await sdkCatalog(config)
        const socs = [...new Set(catalog.map(item => item.soc).filter((soc): soc is string => !!soc))]
        methods.push({
          id: 'manual',
          title: '手工登记',
          about: '扫不到的板子（比如全靠两根排针上的 GPIO 调试、没有 USB 的板子）：说出它在哪台主机上、各个角色由什么提供，登记成一块板子。',
          compose: true,
          fields: [
            { id: 'host', label: '主机', kind: 'text' as const, required: true, initial: knownHost || null,
              placeholder: '板子接在哪台 boardctrl 主机上（设置里那台的名字）' },
            { id: 'name', label: '板名', kind: 'text' as const, required: true, placeholder: '例：my-board' },
            { id: 'services', label: '各角色的提供者（JSON）', kind: 'text' as const, required: false,
              placeholder: '{ "debug": { "provider": "<provider>", "target": "<target>" } }',
              note: '这块板子怎么被调试、看串口、刷写：每个角色一个 provider（relay / console / download / flash / debug）。只有调试口也要写在这里。' },
            ...(socs.length
              ? [{ id: 'soc', label: 'SoC（可选）', kind: 'choice' as const, required: false,
                options: socs.map(soc => ({ value: soc, label: soc.toUpperCase() })), note: 'SDK 按 SoC 给出来。' }]
              : [{ id: 'soc', label: 'SoC（可选）', kind: 'text' as const, required: false, placeholder: '例如 k3' }]),
            { id: 'board', label: '型号（可选）', kind: 'text' as const, required: false, placeholder: '例如 k3_com260', note: '板上读不到型号时，知道就填。' },
            { id: 'console_alias', label: '串口（可选）', kind: 'text' as const, required: false, placeholder: '主机上的 serial-mux 别名', note: '有串口控制台时填；全靠调试口的话留空。' },
            { id: 'usb', label: '下载口（可选）', kind: 'text' as const, required: false, placeholder: 'usb:2-1.4', note: '有 USB 下载口时填。' },
            { id: 'reset_pin', label: '复位线（可选）', kind: 'text' as const, required: false, placeholder: '例如 P15', note: '接到 GPIO 复位线时填；靠人按复位就留空。' },
          ],
        })
        return methods
      },
      async run(config, method, values, context, progress, registered, signal) {
        const host = context.host ?? (context.slot ? context.slot.split('/')[0]! : null)
        if (method === 'probe') {
          // boardctrl probe pulses free reset lines on the selected host (or every selected slot of it), watches consoles
          // and USB, and registers each board the moment it is found.
          const slots = slotId(context.slot)
          const prefer = (values.prefer ?? '').split(/[\s,]+/).filter(Boolean)
          const args = ['probe', '--register', ...(slots ? ['--slots', slots] : []), ...(prefer.length ? ['--prefer', prefer.join(',')] : [])]
          return probed(config, args, progress, registered, host ?? undefined, signal)
        }
        if (method === 'bind') {
          // The board is in download mode already: bsp makes a DUT of the console and the port it appeared on. Its SoC
          // (and optionally one SDK) is what gives it a boot recipe; without it the board has no SDK at all.
          if (!host) throw new Error('人工刷机要知道板子在哪台主机上：选一台主机')
          const usb = values.usb?.trim() ?? '', consoleId = values.console?.trim() ?? ''
          if (!usb) throw new Error('人工刷机要选下载口')
          if (!consoleId) throw new Error('人工刷机要选串口')
          const soc = values.soc?.trim() ?? '', sdk = values.sdk?.trim() ?? '', model = values.board?.trim() ?? ''
          // The catalog is the authority for both: a SoC it does not know, or an SDK built for another SoC, would give
          // the board no working recipe. It is only a check when the catalog answered at all.
          const catalog = (soc || sdk) ? await sdkCatalog(config) : []
          const knownSocs = new Set(catalog.map(item => item.soc).filter((item): item is string => !!item))
          if (soc && knownSocs.size && !knownSocs.has(soc)) throw new Error(`boardctrl 的 SDK 目录里没有 SoC ${soc}`)
          const sdkSoc = catalog.find(item => item.id === sdk)?.soc
          if (sdk && sdkSoc && soc && sdkSoc !== soc) throw new Error(`SDK ${sdk} 是给 ${sdkSoc} 的，不是 ${soc}`)
          const name = values.name?.trim() || `tmp-${host}-${consoleId.replace(/[^A-Za-z0-9_.-]+/g, '-')}`
          await boardctrlCli(config, ['dut', 'bind', name, '--console', consoleId, '--usb', usb, '--host', host,
            ...(soc ? ['--soc', soc] : []), ...(model ? ['--board', model] : []), ...(sdk ? ['--sdks', sdk] : [])], 180_000)
          registered?.(name)
          return { message: `登记了 ${name}（${host}：串口 ${consoleId}，下载口 ${usb}${soc ? `，SoC ${soc}` : ''}${sdk ? `，SDK ${sdk}` : ''}；由人复位）`, found: [] }
        }
        throw new Error(`bsp 后端没有发现方法 ${method}`)
      },
      // bsp starts the host over itself: it forgets the boards it probed there and their slots, makes a slot of each
      // console plugged in now, and probes them all, registering each board as found. With --keep-used it keeps the
      // boards that are leased or busy and redoes only what moved.
      async rebuild(config, host, progress, registered, options, signal) {
        return probed(config, ['probe', '--rebuild', ...(options?.keepInUse ? ['--keep-used'] : []), '--yes'], progress, registered, host, signal)
      },
      keepsInUse: true,
      async register(config, finding, name) {
        const spec = { ...(finding.detail as BoardctrlSpec), id: name }
        if (!finding.host) throw new Error('不知道这块板子在哪台 boardctrl 主机上')
        await boardctrlCli(config, ['dut', 'add', finding.host, '--spec', JSON.stringify(spec)], 180_000)
      },
      /**
       * A board no probe can see: its console, download port and debug path are not USB things, so a person says what
       * they are. The method is `manual` below, and every field is one a DUT record has (the same ones `boardctrl dut set`
       * takes), so the record bsp gets is the one a site file would carry — boardlab writes no bsp vocabulary of its
       * own, it passes the person's answers through.
       */
      async compose(config, method, values, context) {
        if (method !== 'manual') throw new Error(`bsp 后端没有手工登记方法 ${method}`)
        const host = values.host?.trim() || context.host?.trim()
        if (!host) throw new Error('手工登记要知道板子在哪台主机上')
        const name = values.name?.trim() ?? ''
        if (!name) throw new Error('手工登记要给板子起个名字')
        if (!DEVICE_NAME.test(name)) throw new Error('板名只能用字母、数字和 . _ -')
        const services = (values.services ?? '').trim()
        if (services) {
          let parsed: unknown
          try { parsed = JSON.parse(services) } catch { throw new Error('各角色的提供者要写成 JSON（{ "debug": { "provider": "<provider>" } }）') }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('各角色的提供者要写成一个 JSON 对象')
        }
        const spec = {
          id: name,
          ...(values.board?.trim() ? { board: values.board.trim() } : {}),
          ...(values.soc?.trim() ? { soc: values.soc.trim() } : {}),
          ...(values.console_alias?.trim() ? { console: { alias: values.console_alias.trim() } } : {}),
          ...(values.usb?.trim() ? { fastboot: { usb: values.usb.trim() } } : {}),
          ...(values.reset_pin?.trim() ? { control: { backend: 'gpio-relay', reset: { pin: values.reset_pin.trim(), mode: 'button' } } } : {}),
          ...(services ? { services: JSON.parse(services) } : {}),
        }
        await boardctrlCli(config, ['dut', 'add', host, '--spec', JSON.stringify(spec)], 180_000)
        const what = Object.keys(spec).filter(key => !['id'].includes(key))
        return { name, message: `登记了 ${name}（${host}${what.length ? `：${what.join('、')}` : ''}）` }
      },
    },

    ports: { list: freePorts },

    // What it stops by telling the host: the host's job ends before its next step, and boardd follows it to its end.
    cancels: ['reset', 'download', 'stage', 'boot', 'build', 'flash', 'refresh', 'discover'],
    // A run boardd lost (it restarted) is followed by the host job its progress named.
    follow: (config, at, handle, progress, signal) =>
      followJob(handle, progress, (args, timeoutMs, host) => boardctrlCli(config, args, timeoutMs, undefined, host, signal, at), { signal }),
    async cancel(config, { device, lease: token }) {
      let done: { cancelled?: string[] }
      try { done = await boardctrlCli<{ cancelled?: string[] }>(config, ['dut', 'cancel', device, ...lease(token)], 60_000) }
      catch (error) { throw nothingToCancel(device, error) ?? error }
      return `让 ${done.cancelled?.join('、') ?? '它'} 停下`
    },

    builds: {
      async boot(config, at, sdk, progress, signal, report) {
        const { device, lease: token } = at
        // The board host pulls the SDK's build from its build server and runs the SDK's boot recipe.
        const job = await boardctrlCli<{ lines?: string[] }>(config, ['dut', 'boot', device, '--sdk', sdk.sdk, '--method', sdk.method,
          ...(sdk.variant ? ['--variant', sdk.variant] : []), ...(sdk.brk ? ['--break', sdk.brk] : []),
          ...lease(token), '--timeout', '3600'], 3_600_000 + 60_000, reportingJob(progress, report), undefined, signal, at)
        return (job.lines ?? []).join('\n')
      },
      async breaks(config, sdk) {
        // The recipe's `breaker:` steps, from the CATALOG (not the host): bsp sdk show lists them. The page asks as
        // soon as the boot dialog opens and again on every change, and the catalog changes at most when it syncs:
        // a short cache keeps the dialog instant, and concurrent asks share one call.
        const key = `${config.url}\u0000${sdk}`
        const hit = breaksCache.get(key)
        if (hit && Date.now() - hit.at < BREAKS_TTL_MS) return hit.value
        const asking = breaksAsking.get(key)
        if (asking) return asking
        const ask = (async () => {
          const shown = await boardctrlCli<{ breakers?: { load?: string[], download?: string[] } }>(config, ['sdk', 'show', sdk], 60_000)
          const value = { load: shown.breakers?.load ?? [], download: shown.breakers?.download ?? [] }
          breaksCache.set(key, { at: Date.now(), value })
          return value
        })()
        breaksAsking.set(key, ask)
        try { return await ask } finally { breaksAsking.delete(key) }
      },
      // What a board host unpacks and flashes: a package at a link, or one pulled from a build server over ssh.
      accepts: { schemes: ['http', 'https', 'ssh'], suffixes: ['.zip', '.tar.gz', '.tgz', '.tar'] },
      async flash(config, at, pkg, progress, signal, report) {
        const { device, lease: token } = at
        // A link is downloaded by the board host itself; a file here is uploaded by bsp, checked against its sha256.
        const job = await boardctrlCli<{ job?: string, lines?: string[], flasher?: string, elapsed_s?: number }>(config, ['dut', 'flash', device,
          '--package', pkg.url ?? pkg.path!, ...(pkg.sha256 ? ['--sha256', pkg.sha256] : []), ...(pkg.flasher ? ['--flasher', pkg.flasher] : []), ...(pkg.refresh && pkg.url ? ['--refresh'] : []),
          ...(pkg.partitions?.length ? ['--partitions', pkg.partitions.join(',')] : []),
          ...lease(token), '--timeout', '3600'], 3_600_000 + 60_000, reportingJob(progress, report), undefined, signal, at)
        const lines = job.lines ?? []
        return [...lines, ...(job.flasher ? [`刷机工具：${job.flasher}${job.elapsed_s ? `，用时 ${Math.round(job.elapsed_s)} 秒` : ''}`] : [])].join('\n')
      },
      async plan(config, at, pkg, progress, signal) {
        const { device, lease: token } = at
        // The host fetches and unpacks the package and reads its partition tables, then says what flashing it would write: no board is touched.
        const answer = await boardctrlCli<{ plan?: FlashPlan }>(config, ['dut', 'flash', device,
          '--package', pkg.url ?? pkg.path!, ...(pkg.sha256 ? ['--sha256', pkg.sha256] : []), ...(pkg.refresh && pkg.url ? ['--refresh'] : []),
          '--plan', ...lease(token), '--timeout', '900'], 900_000 + 60_000, progress, undefined, signal, at)
        if (!answer.plan) throw new Error('板卡主机没有给出刷机包的内容（它的 boardctrl 太旧，不认 --plan？）')
        return answer.plan
      },
    },

    news: {
      watch(config, onNews, ended) {
        // One bspd: its own events. Several hosts: they tell the registry when their cables change, one stream for all.
        const child = start([...global(config), 'watch', ...(direct(config) ? [] : ['--registry'])], env(config))
        let buffer = '', stopped = false
        child.stream.setEncoding('utf8')
        child.stream.on('data', (chunk: string) => {
          buffer += chunk
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            let event: { host?: string, topic?: string, data?: Record<string, any> }
            try { event = JSON.parse(line) } catch { continue }
            const data = event.data ?? {}
            const host = String(data.host ?? '')
            const flat = (side: Record<string, string[]> | undefined) => [...(side?.tty ?? []), ...(side?.usb ?? []).map(item => item.split(' ')[0]!)]
            const at = host || String(event.host ?? '')
            if (event.topic === 'registry.ports' && host) { forgetHost(config, host); onNews({ kind: 'ports', host, added: flat(data.added), removed: flat(data.removed) } satisfies LabNews) }
            else if (event.topic === 'registry.announced' && host) onNews({ kind: 'hosts', host })
            else if (event.topic === 'dut.ports' && at) { forgetHost(config, at); onNews({ kind: 'ports', host: at, added: flat(data.added), removed: flat(data.removed) } satisfies LabNews) }
            // A board registered, removed, renamed, leased elsewhere, or a slot came and went: list the boards again.
            else if (at && /^dut\.(added|removed|renamed|slots|leased|released|attention|rebuilt)/.test(event.topic ?? '')) onNews({ kind: 'hosts', host: at })
          }
        })
        // The stream is half bsp's stdin, which never ends: its output ending (or the stream failing) is the end.
        let over = false
        const finish = () => { if (over) return; over = true; if (!stopped) ended(child.stderr().trim().split('\n').at(-1) || 'bsp watch 结束了') }
        child.stream.on('end', finish)
        child.stream.on('close', finish)
        child.stream.on('error', finish)
        return () => { stopped = true; child.stream.destroy() }
      },
    },

    // The board's debug path, whatever its host provides: ask what it offers, run its actions, stream its trace.
    debug: bspDebug({
      run: <T>(config: LabConfig, args: string[]) => boardctrlCli<T>(config, args, 120_000),
      spawnStream: (config, args) => start([...global(config), ...args], env(config)),
    }),

    lease: {
      async take(config, device, holder: LabHolder) {
        if (isSlot(device)) return SLOT_LEASE
        const result = await boardctrlCli<{ token: string }>(config, ['dut', 'acquire', device, '--holder', holder.holder, '--purpose', holder.purpose,
          '--ttl', String(LEASE_TTL_S), ...lease(holder.token)])
        return result.token
      },
      give: async (config, device, token) => { if (!isSlot(device) && token !== SLOT_LEASE) await boardctrlCli(config, ['dut', 'release', device, ...lease(token)]) },
    },
    async caches(config) {
      const hosts = await boardctrlCli<Array<{ host: string, cache?: HostCache | null, error?: string }>>(config, ['hosts'], 30_000).catch(error => { throw new Error(`读不到主机：${(error as Error).message}`) })
      return (hosts ?? []).map(item => ({ host: item.host, cache: item.cache ?? null, error: item.error ?? null }))
    },
    async boardConfig(config, device, fresh = false) {
      // `dut status` carries the effective SDKs and whether the board's own list is explicit (an empty list means every
      // SDK of its SoC); `dut list` does not, so the editor reads the board once.
      const [record, choices, sdkList] = await Promise.all([
        boardctrlCli<BoardctrlDut>(config, ['dut', 'status', device], 15_000),
        hostChoices(config, await hostOfBoard(config, device), fresh),
        sdkCatalog(config),
      ])
      // The SoCs the catalog has SDKs for; the board's own stays a choice even when nothing is built for it.
      const socs = [...new Set(sdkList.map(item => item.soc).filter((soc): soc is string => !!soc))]
      if (record.soc && !socs.includes(record.soc)) socs.unshift(record.soc)
      // An SDK registered here but gone from the catalog stays choosable, so an untouched save does not drop it.
      const sdkOptions = sdkList.map(item => ({ value: item.id, label: `${item.id}${item.soc ? `（${item.soc.toUpperCase()}）` : ''}` }))
      for (const id of record.sdks_explicit ? (record.sdks ?? []) : []) if (!sdkOptions.some(item => item.value === id)) sdkOptions.unshift({ value: id, label: `${id}（当前登记，不在目录中）` })
      return {
        control: record.control ?? {}, usb: record.usb ?? null, ...choices,
        soc: record.soc ?? null, sdks: record.sdks_explicit ? (record.sdks ?? []) : [],
        socs: socs.map(soc => ({ value: soc, label: soc.toUpperCase() })),
        sdkOptions,
      }
    },

    async change(config, device, token, change) {
      const flags: Array<[string, string | number | undefined]> = [['--board', change.board], ['--soc', change.soc], ['--description', change.description], ['--usb', change.usb],
        ['--reset-pin', change.resetPin], ['--pulse-ms', change.pulseMs], ['--fdl', change.fdl], ['--fdl-pin', change.fdlPin]]
      const given = flags.filter(([, value]) => value !== undefined && value !== '').flatMap(([flag, value]) => [flag, String(value)])
      // An empty SDK list is a value of its own (`dut set --sdks ''`): use every SDK of the SoC.
      if (change.sdks !== undefined) given.push('--sdks', change.sdks.join(','))
      if (!given.length) throw new Error('没有要改的')
      const done = await boardctrlCli<{ changed: string[] }>(config, ['dut', 'set', device, ...lease(token), ...given], 120_000)
      return done.changed ?? []
    },
  }
}
