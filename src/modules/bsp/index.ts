/**
 * The `bsp` module, boardlab's wrapper of bsp: bsp board hosts become a backend (boards, leases, relay, download,
 * consoles, builds, discovery, free ports, news), and bsp's SDK work and its registry's catalog are offered to boardlab's
 * clients (`boardlab sdk`, `boardlab registry`, `boardlab bsp`), all through the bsp CLI on boardd's machine. The site
 * every host reads (SoC facts, the SDK catalog, hooks) is kept here and synced to the hosts (site.ts, site-api.ts).
 */
import { createReadStream, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { EventStream } from 'boardlab-core/core/api.ts'
import { BoardError } from 'boardlab-core/core/errors.ts'
import { sha256File } from 'boardlab-core/core/files.ts'
import type { BoardLab as Lab } from 'boardlab-core/core/lab.ts'
import type { Module } from 'boardlab-core/core/module.ts'
import { bspLab, FDL_STRATEGIES, type BspBackend, type BspBoardChange } from './driver.ts'
import { hostsFor } from '../hosts/ssh.ts'
import { installHost, uninstallHost } from './provision.ts'
import { panelEndpoints } from './panel.ts'
import { Site } from './site.ts'
import { siteEndpoints } from './site-api.ts'
import { bspSdk, CATALOG_ACTIONS, RAW_REFUSED, SDK_ACTIONS, type SdkGroup, type SdkReach, type SdkRunner, type SdkStream } from './sdk.ts'

export interface BspApi {
  /**
   * `boardlab sdk <args>`: run `bsp sdk <args>` for the caller. Arguments `@sha256:<hex>` stand for a file the CLI sent
   * (for `put`); `-o @download` has the output saved here and handed back as a sent file (for `get`), whose sha256 the
   * result carries.
   */
  sdk(holder: string, args: string[], options: { json: boolean, group?: SdkGroup, onOutput: (stream: SdkStream, text: string) => void, signal?: AbortSignal }): Promise<{ code: number, download: string | null }>
}

/** `tree`: the bsp source this distribution carries (externals/bsp), shipped to the hosts it sets up. */
export function bsp(options: { bin?: string, stateDir?: string, sdk?: SdkRunner, instances?: string[], tree?: string | null } = {}): Module<BspApi> {
  return {
    id: 'bsp',
    title: 'bsp 板卡主机',
    setup(lab) {
      const hosts = options.stateDir ? hostsFor(options.stateDir) : null
      const sshKey = hosts?.keyFile
      for (const id of options.instances ?? ['bsp']) lab.backends.register(id, bspLab({ bin: options.bin, sshKey, stateDir: options.stateDir }))
      // A bsp lab is one board host: added on the page, set up there by installing bspd on the host over ssh.
      lab.backends.offer({ kind: 'bsp', title: 'bsp 板卡主机', about: '一台接着板子的 Linux 机器（复位线、串口、下载口）：boardd 用 ssh 给它装上 bspd 并接入', create: () => bspLab({ bin: options.bin, sshKey, stateDir: options.stateDir }) })
      const access = (body: Record<string, unknown>) => {
        const address = String(body.address ?? '').trim()
        if (!address) throw new BoardError('invalid', '要填主机地址：IP、域名或 ssh 配置里的名字')
        return { address, user: String(body.user ?? '').trim() || undefined, port: body.sshPort ? Number(body.sshPort) : undefined, password: typeof body.password === 'string' && body.password ? body.password : undefined, jump: String(body.jump ?? '').trim() || undefined }
      }
      // The site every host gets (SoC facts, the SDK catalog, hooks, images), kept here: see site.ts.
      // Its images are fetched with the same bsp CLI as everything else.
      const site = options.stateDir ? new Site(join(options.stateDir, 'bsp', 'site'), lab.kernel.settings('bsp.site'), {
        tree: options.tree, sshCommands: hosts ? () => hosts.sshCommands() : undefined, bin: options.bin ?? process.env.BOARDS_BSP ?? 'bsp',
      }) : null
      /** The site for a host being installed (its images fetched first), and the revision it is; nothing when there is none. */
      const siteFor = (say: (line: string) => void) => {
        let revision: string | null = null
        const bundle = site ? async (dir: string) => {
          if (!site.shippable()) return null
          const out = join(dir, 'site.tgz')
          revision = (await site.ship(out, say)).revision
          return out
        } : undefined
        return { bundle, revision: () => revision }
      }
      const runner = options.sdk ?? (options.stateDir ? bspSdk({ bin: options.bin, stateDir: options.stateDir }) : null)
      const api: BspApi = {
        async sdk(holder, args, run) {
          if (!runner) throw new BoardError('invalid', '这个 boardd 没有 bsp 命令行，不能做 SDK 操作')
          const group = run.group ?? 'sdk'
          if (group === 'raw') {
            const words = args.filter(arg => !arg.startsWith('-'))
            if (!words.length) throw new BoardError('invalid', '要给 bsp 命令，例如 boardlab bsp hosts')
            if (RAW_REFUSED.has(words[0]!) || (words[0] === 'catalog' && words[1] === 'export')) throw new BoardError('forbidden', `bsp ${words[0]} 会改 boardd 所在机器自己的配置，不能经 boardlab 跑`)
          } else {
            const allowed = group === 'catalog' ? CATALOG_ACTIONS : SDK_ACTIONS
            if (!allowed.has(args[0] ?? '')) throw new BoardError('invalid', `不支持的 ${group === 'catalog' ? 'registry sdk' : 'sdk'} 操作：${args[0] ?? '（空）'}（可用：${[...allowed].join('、')}）`)
          }
          let download: string | null = null
          const mapped = args.map((arg, index) => {
            const sent = arg.match(/^@sha256:([0-9a-f]{64})$/)
            if (sent) return lab.files.resolve(sent[1]!).path
            if (arg === '@download' && ['-o', '--output'].includes(args[index - 1] ?? '')) return (download = lab.files.scratch())
            return arg
          })
          const code = await runner.run(mapped, { holder, ...run, group, reach: group === 'raw' ? reachOf(lab, args) : null })
          lab.kernel.record(holder, null, group === 'catalog' ? 'catalog' : group === 'raw' ? 'bsp' : 'sdk', args.filter(arg => !arg.startsWith('@')).join(' ').slice(0, 200), code === 0, code ? `退出码 ${code}` : null)
          let sha: string | null = null
          if (download) {
            const saved: string = download
            try {
              if (code === 0 && existsSync(saved)) {
                const stored = await lab.files.put(holder, await sha256File(saved), basename(String(args[2] ?? 'file')), createReadStream(saved))
                sha = stored.sha256
              }
            } finally { rmSync(saved, { force: true }) }
          }
          return { code, download: sha }
        },
      }
      lab.api.add('bsp', [{
        method: 'POST', path: '/api/bsp/install', about: '给一个 bsp 实验室装好它的主机（id、address、user、password、jump、board）：ssh 过去装 bspd，接入实验室，输出边装边推送',
        handle: ({ body, caller }) => {
          if (!hosts || !options.tree) throw new BoardError('invalid', '这个 boardd 没带 bsp，不能装主机')
          const id = String(body.id ?? '')
          const lab_ = lab.backends.get(id)
          if (lab_.kind !== 'bsp') throw new BoardError('invalid', `${id} 不是 bsp 实验室`)
          const how = access(body)
          return new EventStream(async (emit, end) => {
            try {
              // Installing starts this host's bspd again, which drops whatever runs on its boards: a board in use (a
              // lease, a console, a boot) is the board's holder's, and the holder lets go of it, not an install. Told
              // through the stream, as every other reason an install cannot start is.
              const inUse = lab.boards.list().find(item => item.lab?.id === id && lab.locks.held(item.name))
              if (inUse) throw new BoardError('locked', `${inUse.name} 正被 ${lab.locks.held(inUse.name)!.holder} 使用，重装会重启那台主机的 bspd；放锁以后再装`)
              // The lab shows it is being installed, with the latest line, to every page until it is done.
              const { done, tested } = await lab.kernel.doing([`lab:${id}`], 'install', '安装中', caller.holder, async line => {
                const say = (text: string) => { emit('out', { text }); line(text) }
                const shipped = siteFor(say)
                // The site may carry this host's config with its providers' own sections (the EC's pins, say): installed
                // with the machine, they reach it as part of the same repository as the provider.
                const hostFile = site && existsSync(join(site.dir, 'hosts', `${id}.yaml`)) ? join(site.dir, 'hosts', `${id}.yaml`) : null
                const done = await installHost(hosts, options.tree!, { id, access: how, board: boardChoice(body.board), ca: lab.kernel.setting('ca.cert') }, null, say, shipped.bundle, undefined, hostFile ? { id, file: hostFile } : null)
                const revision = shipped.revision()
                if (site && revision) site.recordHost(id, { revision, at: new Date().toISOString(), ok: true, message: '安装时放的' })
                say(`bspd ${done.version} 在 ${done.target} 上跑起来了，接入实验室 ${id}…`)
                await lab.backends.configure(caller.holder, id, { enabled: true, url: done.url, username: '', password: done.token, devices: '' })
                const tested = await lab.backends.test(caller.holder, id).catch(error => ({ verifyMessage: (error as Error).message, verifyOk: false }))
                return { done, tested }
              })
              lab.kernel.record(caller.holder, null, 'lab-install', `${id} ${done.target}`, true, done.version)
              emit('exit', { ok: true, message: `装好了：${(tested as { verifyMessage?: string | null }).verifyMessage ?? ''}`, target: done.target, version: done.version })
            } catch (error) {
              lab.kernel.record(caller.holder, null, 'lab-install', `${id} ${how.address}`, false, (error as Error).message)
              emit('exit', { ok: false, message: (error as Error).message })
            }
            end()
          })
        },
      }, {
        method: 'POST', path: '/api/bsp/uninstall', about: '从主机上卸掉 bspd（id；purge=true 连它的数据一起删），并删掉实验室',
        handle: async ({ body, caller }) => {
          if (!hosts) throw new BoardError('invalid', '这个 boardd 不能连主机')
          const id = String(body.id ?? '')
          const settings = lab.backends.labSettings().find(item => item.id === id)
          if (!settings) throw new BoardError('not-found', `没有实验室 ${id}`)
          // What could make removing the lab fail is checked first: uninstalling the host and then refusing to
          // forget the lab would leave a lab whose machine no longer answers.
          const lab_ = lab.backends.get(id)
          if (!lab_.kind) throw new BoardError('invalid', `实验室 ${id} 是在 boardd 的配置里写的，不能在这里删`)
          const board = lab.boards.list().find(item => item.lab?.id === id && lab.locks.held(item.name))
          if (board) throw new BoardError('locked', `${board.name} 正被 ${lab.locks.held(board.name)!.holder} 使用，放锁以后才能卸掉实验室`)
          const url = settings.url?.replace(/^bspd\+/, '') ?? ''
          await lab.kernel.doing([`lab:${id}`], 'remove', '删除中', caller.holder, async line => {
            if (url.startsWith('ssh://')) {
              const parsed = new URL(url)
              await uninstallHost(hosts, { address: parsed.hostname, user: decodeURIComponent(parsed.username) || undefined }, body.purge === true, line)
            } else if (url.startsWith('http://127.0.0.1')) await uninstallHost(hosts, { address: 'localhost' }, body.purge === true, line)
            await lab.backends.removeLab(caller.holder, id)
          })
          site?.recordHost(id, null)
          return { ok: true }
        },
      }, {
        method: 'POST', path: '/api/bsp/board', about: '改一块 bsp 板子的登记（要拿锁）：型号、SoC、下载口、SDK、复位线、怎么进下载模式（fdl：strapped 复位就进，button 按 FDL 线，unset 还不知道）、FDL 线',
        handle: async ({ body, caller }) => {
          const name = lab.boards.resolve(String(body.board ?? ''))
          const route = lab.backends.route(name)
          if (!route.isBoard || !('change' in route.backend)) throw new BoardError('invalid', `${name} 不是 bsp 板子`)
          if (lab.boards.get(name).lab?.empty) throw new BoardError('invalid', `${name} 是空槽位，还没有板子可改`)
          const held = lab.locks.authorize(name, { holder: caller.holder, token: typeof body.token === 'string' ? body.token : null })
          // The dialog submits the whole form; only what changed is validated and sent. An untouched field that is
          // merely unavailable right now (the download port is enumerated in download mode only) must not fail a
          // save that does not touch it.
          const current = await (route.backend as BspBackend).boardConfig(route.config, route.target.device, true)
          const text = (key: string) => typeof body[key] === 'string' && body[key].trim() ? body[key].trim() as string : undefined
          const fdl = text('fdl')
          if (fdl && !(FDL_STRATEGIES as readonly string[]).includes(fdl)) throw new BoardError('invalid', `fdl 只能是 ${FDL_STRATEGIES.join('、')}`)
          const different = <T>(value: T | undefined, before: T | null | undefined) => value !== undefined && value !== (before ?? undefined)
          const resetPin = text('resetPin'), fdlPin = text('fdlPin'), usb = text('usb'), soc = text('soc')
          const resetChanged = different(resetPin, current.control?.reset?.pin)
          const fdlPinChanged = different(fdlPin, current.control?.fdl?.pin)
          const usbChanged = different(usb, current.usb)
          const socChanged = different(soc, current.soc)
          for (const [field, pin, changed] of [['resetPin', resetPin, resetChanged], ['fdlPin', fdlPin, fdlPinChanged]] as const)
            if (changed && pin && !current.gpios.some(item => item.value === pin))
              throw new BoardError('invalid', `${field} 不是这块板所在主机的 GPIO：${pin}`)
          // A download port is only enumerated in download mode: the registered one stays allowed while it is away.
          if (usbChanged && usb && !current.ports.some(item => item.value === usb) && usb !== current.usb)
            throw new BoardError('invalid', `这个下载口不在主机当前检测到的列表里：${usb}`)
          if (socChanged && soc && !current.socs.some(item => item.value === soc))
            throw new BoardError('invalid', `bsp 的 SDK 目录里没有这个 SoC：${soc}`)
          // `sdks`: an array, or the comma list the CLI passes; empty means every SDK of the SoC's board.
          const sdks = Array.isArray(body.sdks) ? body.sdks.map(String).filter(Boolean)
            : typeof body.sdks === 'string' ? String(body.sdks).split(',').map((item: string) => item.trim()).filter(Boolean) : undefined
          const sdksChanged = sdks !== undefined && sdks.join(',') !== (current.sdks ?? []).join(',')
          const unknown = (sdksChanged ? sdks ?? [] : []).filter((id: string) => !current.sdkOptions.some(item => item.value === id))
          if (unknown.length) throw new BoardError('invalid', `bsp 的 SDK 目录里没有这些 SDK：${unknown.join('、')}`)
          const change: BspBoardChange = {
            board: text('model'), soc: socChanged ? soc : undefined, description: text('description'),
            usb: usbChanged ? usb : undefined, resetPin: resetChanged ? resetPin : undefined,
            pulseMs: typeof body.pulseMs === 'number' && body.pulseMs > 0 ? body.pulseMs : undefined,
            fdl: fdl as BspBoardChange['fdl'], fdlPin: fdlPinChanged ? fdlPin : undefined,
            ...(sdksChanged ? { sdks } : {}),
          }
          const changed = await lab.kernel.doing([name], 'configure', '修改中', caller.holder, () =>
            (route.backend as BspBackend).change(route.config, route.target.device, route.target.lease, change), { lease: held.id })
          lab.kernel.record(caller.holder, name, 'bsp-board', changed.join(','), true)
          await lab.backends.sync(route.id, caller.holder).catch(() => {})
          return { message: `改了 ${changed.join('、')}` }
        },
      }, {
        method: 'GET', path: '/api/bsp/board', about: '这块 bsp 板子的登记和改登记可选项：SoC、SDK、所在主机实际的 GPIO 和下载口',
        handle: async ({ query }) => {
          const name = lab.boards.resolve(String(query.get('board') ?? ''))
          const route = lab.backends.route(name)
          if (!('boardConfig' in route.backend)) throw new BoardError('invalid', `${name} 不是 bsp 板子`)
          return (route.backend as BspBackend).boardConfig(route.config, route.target.device)
        },
      }, {
        method: 'GET', path: '/api/bsp/boards', about: 'bsp 认识的板卡主机型号（有 GPIO 排针图的）：装主机时选',
        handle: () => ({ boards: hostBoards(options.tree ?? null) }),
      }, {
        method: 'GET', path: '/api/bsp/key', about: 'boardd 登录主机用的公钥（放到主机的 authorized_keys 里，就不用密码）',
        handle: async () => ({ key: hosts ? await hosts.publicKey() : null }),
      }, {
        method: 'POST', path: '/api/sdk', about: '跑 bsp sdk|catalog|任意 bsp 命令（group），输出边跑边推送',
        handle: ({ body, caller, signal }) => {
          if (!Array.isArray(body.args) || body.args.some((arg: unknown) => typeof arg !== 'string')) throw new BoardError('invalid', 'args 要是字符串数组')
          const group: SdkGroup = body.group === 'catalog' || body.group === 'raw' ? body.group : 'sdk'
          return new EventStream(async (emit, end) => {
            try { emit('exit', await api.sdk(caller.holder, body.args, { json: body.json === true, group, signal, onOutput: (stream, text) => emit('out', { stream, text }) })) }
            catch (error) { emit('error', { message: (error as Error).message }) }
            end()
          })
        },
      }, ...(site ? siteEndpoints(lab, site, hosts) : []), ...panelEndpoints(lab, { sshKey })])
      return api
    },
  }
}

/** `auto` (from the device tree), `none` (no GPIO: reset by a person), or a header map's id; nothing else. */
function boardChoice(value: unknown): string | undefined {
  const board = String(value ?? '').trim()
  if (!board || board === 'auto') return undefined
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(board)) throw new BoardError('invalid', `主机型号不合法：${board}`)
  return board
}

/** The host a raw bsp command names: `-r`/`--remote` (one name, or none for all of them), or `--url`. */
function namedHost(args: string[]): { host: string | null, url: string | null } {
  let host: string | null = null, url: string | null = null
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!
    if (arg === '-r' || arg === '--remote') host = args[at + 1] ?? null
    else if (arg.startsWith('--remote=')) host = arg.slice('--remote='.length)
    else if (arg.startsWith('-r') && arg.length > 2) host = arg.slice(2)
    else if (arg === '--url') url = args[at + 1] ?? null
    else if (arg.startsWith('--url=')) url = arg.slice('--url='.length)
  }
  return { host, url }
}

/**
 * How a raw bsp command reaches board hosts: every lab boardlab has, as the remotes bsp reads — narrowed to those the
 * command names (`-r`/`--url`), which then keeps its own argument. `null` when there is no lab: `sdk` and `catalog`
 * need none, and a name that is no lab is left to bsp's own remotes rather than refused here.
 */
function reachOf(lab: Lab, args: string[]): SdkReach | null {
  const { host, url } = namedHost(args)
  const labs = lab.backends.list().filter(instance => instance.kind === 'bsp' && instance.configurable)
  const named = url
    ? labs.filter(instance => { try { return lab.backends.config(instance.id).url.endsWith(url) } catch { return false } })
    : host && host.trim().toLowerCase() !== 'all'
      ? labs.filter(instance => [`lab-${instance.id}`, instance.id].includes(host) || (labs.filter(other => other.id.toLowerCase().startsWith(host.toLowerCase())).length === 1 && instance.id.toLowerCase().startsWith(host.toLowerCase())))
      : labs
  const hosts = named.flatMap(instance => {
    // Names must not collide with the backend's own: it matches them case-blind and an exact hit wins, so a lab
    // whose name differs only in case from a host it reaches would lose to that host. `lab-<id>` cannot collide,
    // and `rewritten` below maps the name a person types onto it.
    try { const config = lab.backends.config(instance.id); return [{ name: `lab-${instance.id}`, url: config.url, token: config.password }] }
    catch { return [] }
  })
  // What the command's `-r` may say for each lab: the id a person reads on the page, and the remote's own name.
  const names = Object.fromEntries(hosts.map(host => [host.name.replace(/^lab-/, ''), host.name]))
  return hosts.length ? { hosts, names } : null
}

/** The host models boardctrl has a header map for (each shipped platform's boards/<id>.yaml): its id and `name:`. */
export function hostBoards(tree: string | null): Array<{ id: string, name: string }> {
  if (!tree || !existsSync(join(tree, 'platforms'))) return []
  const found: Array<{ id: string, name: string }> = []
  for (const platform of readdirSync(join(tree, 'platforms'))) {
    const dir = join(tree, 'platforms', platform, 'boards')
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir).filter(name => name.endsWith('.yaml')).sort()) {
      const id = file.slice(0, -'.yaml'.length)
      const name = /^name:\s*(.+?)\s*$/m.exec(readFileSync(join(dir, file), 'utf8'))?.[1]?.replace(/^["']|["']$/g, '') ?? id
      found.push({ id, name })
    }
  }
  return found
}
