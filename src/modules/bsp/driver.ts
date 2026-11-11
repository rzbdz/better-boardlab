/**
 * bsp board hosts as a lab. boardd drives them only through the `bsp` CLI (`--json --stateless`), never through bsp's
 * files or code: listing, leases, reset, download mode, staging and RAM boot are `bsp dut …` commands, and the console
 * is `bsp dut pipe`, which carries serial-mux's own protocol from the board host to boardd's serial-mux client. Which
 * hosts there are comes from bsp's own configuration (its site and host registry), so new hosts need nothing here.
 */
import { execFile, spawn } from 'node:child_process'
import { Duplex } from 'node:stream'
import { CHANNEL_ACTIONS, type LabConfig, type LabDevice, type LabFinding, type Backend, type LabHolder, type LabNews } from 'boardlab-core/core/backend.ts'
import type { ConsoleSession } from 'boardlab-core/core/console.ts'
import { muxSession } from '../serial-mux/client.ts'

/** Holders boardd gives its bsp leases: `boardlab:<holder of the lock>`. */
export const HOLDER_PREFIX = 'boardlab:'
/** bsp leases end unless renewed; boardd renews at every lab sync (each minute). */
const LEASE_TTL_S = 600
const TIMEOUT_MS = 60_000
/** A reset of a board that needs a person waits for them. */
const RESET_TIMEOUT_MS = 30 * 60_000
const BOOT_TIMEOUT_MS = 30 * 60_000

export interface BspResult { code: number | null, stdout: string, stderr: string }
/** `onStderr` gets the progress lines bsp prints while it works; `signal` stops it (the lock it runs under ended). */
export type BspRunner = (args: string[], options: { env: NodeJS.ProcessEnv, timeoutMs: number, onStderr?: (line: string) => void, signal?: AbortSignal }) => Promise<BspResult>
/** Starts `bsp … dut pipe`; its stdin and stdout are the pipe. */
export type BspSpawner = (args: string[], env: NodeJS.ProcessEnv) => { stream: Duplex, stderr: () => string }

/** `sshKey`: the key boardd logs in to hosts it set up with (bspd+ssh:// labs). */
export interface BspOptions { bin?: string, run?: BspRunner, spawn?: BspSpawner, sshKey?: string }

/** A DUT spec as bsp probe proposes it (`bsp dut add` takes it back). */
interface BspSpec {
  id: string, board?: string, soc?: string | null, console?: { alias?: string, device?: string }, fastboot?: { usb?: string },
  control?: { backend?: string, reset?: { pin?: string } }
}

/** A slot as `bsp --json slot list` reports it: a serial console on a host, with or without a board. */
interface BspSlot { id: string, host: string, ref: string, alias?: string | null, online: boolean, console_up?: boolean, dut?: string | null }

/** An empty slot is addressed as `<host>/s4`; a board by its DUT name. */
const isSlot = (device: string) => device.includes('/')
/** The lease boardd holds on an empty slot: bsp leases boards, and an empty slot has none yet. */
const SLOT_LEASE = 'slot'

/** A header pin as `bsp --json gpio list` reports it (the fields boardd uses). */
interface BspPin { target: string, label?: string, aliases?: string[], state?: string, actions?: string[], channel?: { mode?: string } }

/** A bsp DUT as `bsp --json dut list` reports it (the fields boardd uses). */
interface BspDut {
  id: string, host: string, slot?: string | null, board?: string | null, soc?: string | null, usb?: string | null, console?: string | null,
  stage?: string, console_up?: boolean, slot_online?: boolean | null, sdks?: string[], lease?: { holder: string, purpose?: string, expires_in_s?: number } | null,
  needs_human?: { action: string, message: string, waiting_s: number } | null,
  media_boot?: { method: string | null, available: boolean, why?: string } | null,
}

/** How a board's bsp record may be changed from boardlab (`bsp dut set`); fields left out stay as they are. */
export interface BspBoardChange {
  board?: string, soc?: string, description?: string, usb?: string,
  resetPin?: string, pulseMs?: number, fdl?: 'strapped' | 'button' | 'unset', fdlPin?: string, sdks?: string[],
}
export const FDL_STRATEGIES = ['strapped', 'button', 'unset'] as const

/** The bsp backend, and what only the bsp module asks of it. */
export interface BspBackend extends Backend {
  /** Change a board's record in bspd, holding its lease (`token`); says which fields changed. */
  change(config: LabConfig, device: string, token: string | null, change: BspBoardChange): Promise<string[]>
}

export function bspLab(options: BspOptions = {}): BspBackend {
  const bin = options.bin ?? process.env.BOARDS_BSP ?? 'bsp'
  const run: BspRunner = options.run ?? ((args, { env, timeoutMs, onStderr, signal }) => new Promise(resolve => {
    const child = execFile(bin, args, { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, signal }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout, stderr: stderr || (error && !stdout ? error.message : '') })
    })
    if (onStderr) {
      let partial = ''
      child.stderr?.on('data', chunk => {
        const lines = (partial + chunk).split('\n')
        partial = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) onStderr(line.trim())
      })
    }
  }))
  const start: BspSpawner = options.spawn ?? ((args, env) => {
    const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000) })
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin })
    child.on('error', error => stream.destroy(error))
    stream.on('close', () => child.kill())
    return { stream, stderr: () => stderr }
  })

  /**
   * `url` names a bsp host registry, `username` the hosts to use (`-r`), `password` the hosts' API token. Commands on a
   * host's own hardware (its relay controller) go to that host alone.
   */
  // `url` is either one bspd reached directly (`bspd+http://127.0.0.1:8765`, this machine's on a board host), or a bsp
  // registry that lists several hosts (a plain URL, or empty for bsp's own site).
  const direct = (config: LabConfig) => config.url.startsWith('bspd+')
  // `bspd+ssh://root@host:8765` (a host boardlab set up): the bsp CLI's `ssh://`, through boardd's own key.
  const bspdUrl = (config: LabConfig) => config.url.slice('bspd+'.length)
  const registryUrl = (config: LabConfig) => config.url
  const global = (config: LabConfig, host?: string) => ['--json', '--stateless', ...(direct(config) ? ['--url', bspdUrl(config)]
    : host ? ['-r', host] : config.username.trim() ? ['-r', config.username.trim()] : [])]
  const env = (config: LabConfig): NodeJS.ProcessEnv => ({
    ...process.env, ...(config.url && !direct(config) ? { BSP_REGISTRY: registryUrl(config) } : {}), ...(config.password ? { BSP_TOKEN: config.password } : {}),
    ...(options.sshKey && bspdUrl(config).startsWith('ssh://') ? { BSP_SSH_OPTIONS: `-i ${options.sshKey} -o IdentitiesOnly=yes` } : {}),
  })
  const bsp = async <T>(config: LabConfig, args: string[], timeoutMs = TIMEOUT_MS, onStderr?: (line: string) => void, host?: string, signal?: AbortSignal): Promise<T> => {
    const result = await run([...global(config, host), ...args], { env: env(config), timeoutMs, onStderr, signal })
    if (signal?.aborted) throw new Error(`bsp ${args.slice(0, 2).join(' ')} 停下了：${(signal.reason as Error | undefined)?.message ?? '锁已经结束'}`)
    let envelope: { ok: boolean, result?: T, error?: { code?: string, message?: string, hint?: string } } | null = null
    try { envelope = JSON.parse(result.stdout) } catch {}
    if (envelope?.ok) return envelope.result as T
    const error = envelope?.error
    if (error) throw new Error(`bsp ${args.slice(0, 2).join(' ')}：${error.message}${error.hint ? `（${error.hint}）` : ''}`)
    const text = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-4).join('\n')
    throw new Error(`bsp ${args.slice(0, 2).join(' ')} 失败${result.code === null ? '（超时或没能运行）' : `（退出码 ${result.code}）`}${text ? `：${text}` : ''}`)
  }

  /** A `bsp probe` run (a discovery or a rebuild): boards bsp registered as it went, and the rest as findings. */
  const probed = async (config: LabConfig, args: string[], progress: (line: string) => void,
    registered: ((device: string) => void) | undefined, host?: string): Promise<{ found: LabFinding[], message: string }> => {
    const onLine = (line: string) => {
      progress(line)
      const done = line.match(/\bregistered (\S+)(?: in slot \S+)?$/)
      if (done) registered?.(done[1]!)
    }
    type Result = { proposals?: Array<{ spec: BspSpec, warnings?: string[], registered?: { dut: string } }>, registered?: Array<{ dut: string }>, reasons?: string[] }
    const out = await bsp<{ results: Record<string, Result> }>(config, args, BOOT_TIMEOUT_MS, onLine, host)
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
      ...(!added.length && !found.length ? [`bsp probe 在 ${where} 上没有发现新板子`] : []),
      ...reasons,
    ].join('；')
    return { found, message }
  }
  const lease = (token: string | null | undefined) => token && token !== SLOT_LEASE ? ['--lease', token] : []
  /** Progress lines of a reset: what a person is asked to do, and when it is done. */
  const attention = (notice?: (message: string | null) => void) => notice && ((line: string) => {
    const asked = line.match(/ACTION NEEDED: (.*)$/)
    if (asked) notice(asked[1]!)
    else if (/: (confirmed by a person|detected )/.test(line)) notice(null)
  })

  /** The host each DUT is on, as last listed; a DUT not listed yet is looked up. */
  const hostOf = new Map<string, string>()
  const host = async (config: LabConfig, device: string) => {
    if (!hostOf.has(device)) for (const dut of await bsp<BspDut[]>(config, ['dut', 'list'])) hostOf.set(dut.id, dut.host)
    const found = hostOf.get(device)
    if (!found) throw new Error(`bsp 里没有板子 ${device}`)
    return found
  }

  return {
    kind: 'bsp 板卡主机',
    about: 'boardd 经 bsp 操作这台主机上的板子：复位线、下载口、串口、刷机和启动都由主机上的 bspd 做，锁和排队以这台 boardd 为准（拿锁时它同时持有 bspd 的租约）。',
    fields: {
      url: { label: 'bspd 地址', placeholder: '本机的 bspd：bspd+http://127.0.0.1:8765（或 bsp registry 的地址）', required: false },
      username: { label: '只用这些 bsp 主机', placeholder: '经 registry 时：逗号分隔的主机名；留空用全部', required: false },
      password: { label: 'bspd token', placeholder: 'bspd 要求 token 时填', required: false },
    },
    defaultJump: () => '',

    inventory: {
      async verify(config) {
        const hosts = await bsp<Array<{ host: string, duts?: string[], error?: string }>>(config, ['hosts'])
        const up = hosts.filter(host => !host.error)
        const down = hosts.filter(host => host.error)
        if (!up.length) throw new Error(`没有连上任何 bsp 主机${down.length ? `：${down.map(host => `${host.host}（${host.error}）`).join('，')}` : ''}`)
        const boards = up.reduce((sum, host) => sum + (host.duts?.length ?? 0), 0)
        return `${up.length} 台 bsp 主机（${up.map(host => host.host).join('、')}），${boards} 块板子${down.length ? `；连不上：${down.map(host => host.host).join('、')}` : ''}`
      },

      async devices(config) {
        const duts = await bsp<BspDut[]>(config, ['dut', 'list'])
        for (const dut of duts) hostOf.set(dut.id, dut.host)
        // Slots with no board yet are listed too, by their console: watchable, discoverable. Hosts without slots have none.
        const slots = await bsp<BspSlot[]>(config, ['slot', 'list']).catch(() => [] as BspSlot[])
        const empty = slots.filter(slot => !slot.dut && slot.online).map((slot): LabDevice => ({
          name: `${slot.host}-${slot.id}`, address: slot.ref, slot: slot.ref, empty: true, host: slot.host, model: null, online: false,
          serialPort: `${slot.host}:${slot.alias ?? slot.id}`, serialConnected: slot.console_up ?? true, downloadUsbPath: null, ip: null,
        }))
        return [...duts.map((dut): LabDevice => ({
          slot: dut.slot ? `${dut.host}/${dut.slot}` : null,
          mediaBoot: dut.media_boot ?? null,
          name: dut.id, host: dut.host, sdks: dut.sdks ?? [], model: dut.board || null, soc: dut.soc || null,
          online: false, serialPort: dut.console ? `${dut.host}:${dut.console}` : null,
          // Hosts without console_up predate `bsp dut pipe`; opening the console tells.
          serialConnected: dut.console_up ?? true,
          // Its slot's adapter is unplugged or moved: after re-cabling the host wants a rebuild.
          slotGone: dut.slot_online === false,
          // A board found without a download cable has `usb:UNKNOWN` until its port is known.
          downloadUsbPath: dut.usb && !/UNKNOWN/.test(dut.usb) ? dut.usb.replace(/^usb:/, '') : null, ip: null,
          heldBy: dut.lease && !dut.lease.holder.startsWith(HOLDER_PREFIX) ? dut.lease.holder : null,
          attention: dut.needs_human?.message ?? null,
        })), ...empty]
      },
      async refresh(config, target, options, progress, signal) {
        const args = ['dut', 'refresh', target.device, ...lease(target.lease), '--timeout', String(RESET_TIMEOUT_MS / 1000),
          ...(options.name ? ['--name', options.name] : options.rename ? ['--rename'] : [])]
        const job = await bsp<{ status?: string, error?: { message?: string }, result?: { dut: string, changed?: string[], board?: string, usb?: string, identified?: boolean } }>(config, args, RESET_TIMEOUT_MS + 60_000, progress, undefined, signal)
        if (job.status && job.status !== 'succeeded') throw new Error(job.error?.message ?? `bsp dut refresh ${job.status}`)
        const r = job.result ?? { dut: target.device }
        return {
          device: r.dut,
          message: `${r.dut}：${r.identified ? `读到 ${r.board ?? '型号未知'}` : '没有读到型号（没有下载口或 SoC 不支持识别）'}${r.changed?.length ? `，改了 ${r.changed.join('、')}` : '，没有变化'}`,
        }
      },
      remove: async (config, device) => { await bsp(config, ['dut', 'remove', device]) },
    },

    relay: {
      // A board reset by a person makes bsp print what to do (`ACTION NEEDED: …`) and wait for `bsp dut confirm`, until
      // the lock it runs under ends.
      reset: async (config, { device, lease: token }, notice, signal) => { await bsp(config, ['dut', 'reset', device, '--no-fdl', ...lease(token), '--timeout', '1800'], RESET_TIMEOUT_MS, attention(notice), undefined, signal) },
      enterDownload: async (config, { device, lease: token }, notice, signal) => { await bsp(config, ['dut', 'reset', device, ...lease(token), '--timeout', '1800'], RESET_TIMEOUT_MS, attention(notice), undefined, signal) },
      confirm: async (config, { device }, note) => {
        const result = await bsp<{ confirmed: string, waited_s: number }>(config, ['dut', 'confirm', device, ...(note ? [note] : [])])
        return `已确认「${result.confirmed}」（等了 ${result.waited_s} 秒）`
      },
    },

    /**
     * The DUT's lines on its host's relay controller (bsp gpio_relay): every pin with an alias under `<dut>/` — the
     * `reset` and `fdl` lines bsp registers for it, and any others the site aliases there (`<dut>/power`, …).
     */
    channels: {
      async list(config, { device }) {
        const pins = await bsp<BspPin[]>(config, ['gpio', 'list'], TIMEOUT_MS, undefined, await host(config, device))
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
        const result = await bsp<{ target?: string, state?: string }>(config, [group, verb, channel, ...(timed && ms ? ['--ms', String(ms)] : [])], TIMEOUT_MS + (ms ?? 0), undefined, await host(config, device))
        return `${channel}：${verb}${timed && ms ? ` ${ms}ms` : ''}${result.state ? `，现在 ${result.state}` : ''}`
      },
    },

    serial: {
      // The board host keeps each console's log by day; bsp reads a range of it there and searches it.
      async logs(config, { device }, query) {
        return bsp<{ lines: string[], matched: number, truncated: boolean }>(config, ['dut', 'logs', device,
          ...(query.since ? ['--since', query.since] : []), ...(query.until ? ['--until', query.until] : []),
          ...(query.grep ? ['--grep', query.grep] : []), ...(query.regex ? ['--regex'] : []),
          '--limit', String(query.limit ?? 20000), ...(query.first ? ['--first'] : [])], 120_000)
      },
      async open(config, { device }) {
        const child = start([...global(config), 'dut', 'pipe', device], env(config))
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
      async stage(config, target, file, timeoutMs = 300_000) {
        const result = await bsp<{ output: string, file: string, size: number }>(config,
          ['dut', 'stage', target.device, file.path, ...lease(target.lease), '--timeout', String(Math.ceil(timeoutMs / 1000))], timeoutMs + 120_000)
        return result.output
      },
      async present(config, target) {
        return (await bsp<{ present: boolean }>(config, ['dut', 'present', target.device])).present
      },

      async boot(config, { device, lease: token }, files, timing) {
        // `boardlab boot` starts with the board already in download mode, as boardd's own boot does.
        const job = await bsp<{ lines?: string[], elapsed_s?: number }>(config, ['dut', 'boot', device, '--files', ...files.map(file => file.path), '--no-reset',
          '--first-wait', String(timing.firstMs / 1000), '--later-wait', String(timing.laterMs / 1000), '--port-timeout', String(timing.waitMs / 1000),
          ...lease(token), '--timeout', '1800'], BOOT_TIMEOUT_MS)
        return (job.lines ?? []).join('\n')
      },
    },

    discovery: {
      async discover(config, discovery, progress, registered) {
        // bsp probe pulses free reset lines on the free slots of every selected host (or, with a person resetting the
        // boards, works on one host), watches consoles and USB, and registers each board the moment it is found.
        const slots = discovery.slots ?? []
        const hosts = [...new Set(slots.map(slot => slot.split('/')[0]!))]
        if (hosts.length > 1) throw new Error(`一次只能发现一台主机上的槽位（这里有 ${hosts.join('、')}）`)
        const host = hosts[0] ?? (discovery.human ? discovery.host ?? undefined : undefined)
        const args = ['probe', '--register', ...(discovery.human ? ['--human'] : []), ...(slots.length ? ['--slots', slots.map(slot => slot.split('/')[1]).join(',')] : [])]
        return probed(config, args, progress, registered, host)
      },
      // bsp starts the host over itself: it forgets the boards it probed there and their slots, makes a slot of each
      // console plugged in now, and probes them all, registering each board as found. With --keep-used it keeps the
      // boards that are leased or busy and redoes only what moved.
      async rebuild(config, host, progress, registered, options) {
        return probed(config, ['probe', '--rebuild', ...(options?.keepInUse ? ['--keep-used'] : []), '--yes'], progress, registered, host)
      },
      keepsInUse: true,
      async register(config, finding, name) {
        const spec = { ...(finding.detail as BspSpec), id: name }
        if (!finding.host) throw new Error('不知道这块板子在哪台 bsp 主机上')
        await bsp(config, ['dut', 'add', finding.host, '--spec', JSON.stringify(spec)], 180_000)
      },
    },

    ports: {
      async list(config) {
        // A dry-run probe touches nothing: it lists each host's free consoles and the download-mode USB devices on it.
        const [plans, duts] = await Promise.all([
          bsp<Record<string, { consoles?: Array<{ id: string, kind: string, alias?: string, device?: string }>, usb?: Array<{ usb: string, product?: string }> }>>(config, ['probe', '--dry-run'], 120_000),
          bsp<BspDut[]>(config, ['dut', 'list']),
        ])
        const used = new Set(duts.map(dut => dut.usb))
        return Object.entries(plans).map(([host, plan]) => ({
          host,
          consoles: (plan.consoles ?? []).map(con => ({ id: con.alias ?? con.device ?? con.id, label: con.alias ? `serial-mux ${con.alias}${con.device ? `（${con.device}）` : ''}` : (con.device ?? con.id) })),
          usb: (plan.usb ?? []).filter(device => !used.has(device.usb)).map(device => ({ id: device.usb, label: `${device.usb}${device.product ? ` ${device.product}` : ''}` })),
        }))
      },
      async bind(config, host, ports, name) {
        await bsp(config, ['dut', 'bind', name, '--console', ports.console, '--usb', ports.usb, '--host', host], 180_000)
      },
    },

    builds: {
      async boot(config, { device, lease: token }, sdk, progress) {
        // The board host pulls the SDK's build from its build server and runs the SDK's boot recipe.
        const job = await bsp<{ lines?: string[] }>(config, ['dut', 'boot', device, '--sdk', sdk.sdk, '--method', sdk.method,
          ...(sdk.variant ? ['--variant', sdk.variant] : []), ...lease(token), '--timeout', '3600'], 3_600_000 + 60_000, progress)
        return (job.lines ?? []).join('\n')
      },
      async flash(config, { device, lease: token }, pkg, progress, signal) {
        // A link is downloaded by the board host itself; a file here is uploaded by bsp, checked against its sha256.
        const job = await bsp<{ job?: string, lines?: string[], flasher?: string, elapsed_s?: number }>(config, ['dut', 'flash', device,
          '--package', pkg.url ?? pkg.path!, ...(pkg.sha256 ? ['--sha256', pkg.sha256] : []), ...(pkg.flasher ? ['--flasher', pkg.flasher] : []),
          ...lease(token), '--timeout', '3600'], 3_600_000 + 60_000, progress, undefined, signal)
        const lines = job.lines ?? []
        return [...lines, ...(job.flasher ? [`刷机工具：${job.flasher}${job.elapsed_s ? `，用时 ${Math.round(job.elapsed_s)} 秒` : ''}`] : [])].join('\n')
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
            if (event.topic === 'registry.ports' && host) onNews({ kind: 'ports', host, added: flat(data.added), removed: flat(data.removed) } satisfies LabNews)
            else if (event.topic === 'registry.announced' && host) onNews({ kind: 'hosts', host })
            else if (event.topic === 'dut.ports' && at) onNews({ kind: 'ports', host: at, added: flat(data.added), removed: flat(data.removed) } satisfies LabNews)
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

    lease: {
      async take(config, device, holder: LabHolder) {
        if (isSlot(device)) return SLOT_LEASE
        const result = await bsp<{ token: string }>(config, ['dut', 'acquire', device, '--holder', holder.holder, '--purpose', holder.purpose,
          '--ttl', String(LEASE_TTL_S), ...lease(holder.token)])
        return result.token
      },
      give: async (config, device, token) => { if (!isSlot(device) && token !== SLOT_LEASE) await bsp(config, ['dut', 'release', device, ...lease(token)]) },
    },
    async change(config, device, token, change) {
      const flags: Array<[string, string | number | undefined]> = [['--board', change.board], ['--soc', change.soc], ['--description', change.description], ['--usb', change.usb],
        ['--reset-pin', change.resetPin], ['--pulse-ms', change.pulseMs], ['--fdl', change.fdl], ['--fdl-pin', change.fdlPin], ['--sdks', change.sdks?.join(',')]]
      const given = flags.filter(([, value]) => value !== undefined && value !== '').flatMap(([flag, value]) => [flag, String(value)])
      if (!given.length) throw new Error('没有要改的')
      const done = await bsp<{ changed: string[] }>(config, ['dut', 'set', device, ...lease(token), ...given], 120_000)
      return done.changed ?? []
    },
  }
}
