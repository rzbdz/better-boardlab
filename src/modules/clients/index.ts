/**
 * The `clients` module: the machines that use this boardd through the boardlab CLI (compile servers, laptops). boardd
 * keeps their list, installs the CLI on each over ssh from the release it runs itself and points it at this boardd
 * through an ssh tunnel (see install.ts), updates it the same way, takes it away, and says per machine what is installed
 * there: checked every half hour, after each install, or when asked.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EventStream } from 'boardlab-core/core/api.ts'
import { BoardError } from 'boardlab-core/core/errors.ts'
import type { Module } from 'boardlab-core/core/module.ts'
import type { State } from 'boardlab-core/shared/types.ts'
import { DEFAULT_PORT } from 'boardlab-core/shared/client.ts'
import { hostsFor, type Access, type Hosts } from '../hosts/ssh.ts'
import { checkCli, checkTunnel, deauthorize, installCli, keyBody, localHub, removeCli, tunnelUrl, type Hub, type Release, type Tunnel } from './install.ts'

/** A machine with the CLI, as added on the page. `key`: its public key, as authorized for the tunnel. */
export interface Machine { id: string, address: string, user: string, jump?: string, sshPort?: number, key?: string, addedAt: string, addedBy: string }
/** What boardd last found there. `reachable` null: not checked yet. */
export interface MachineStatus { reachable: boolean | null, version: string | null, revision: string | null, remote: string | null, checkedAt: string | null, error: string | null }
export interface ClientsView {
  /** How the CLIs reach this boardd: `address` null until set (the page offers its own host). */
  hub: { address: string | null, tunnel: string, sshPort: number | null, port: number, url: string | null }
  /** The release this boardd runs, which it installs; null when run from source. */
  release: { version: string, revision: string } | null
  machines: Array<Machine & { status: MachineStatus, busy: boolean }>
}

/** The release in an installed boardlab's program directory (VERSION, REVISION and install.sh beside dist/). */
export function releaseAt(root: string | null): Release | null {
  if (!root || !existsSync(join(root, 'install.sh'))) return null
  const read = (file: string) => { try { return readFileSync(join(root, file), 'utf8').trim() || null } catch { return null } }
  const version = read('VERSION'), revision = read('REVISION')
  return version && revision ? { root, version, revision } : null
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/
const NO_RELEASE = '这个 boardd 是从源码跑的，没有发布包可装：用 install.sh 装的 boardd 才能给别的机器装命令行（或者在那台机器上自己跑 install.sh）'
const UNCHECKED: MachineStatus = { reachable: null, version: null, revision: null, remote: null, checkedAt: null, error: null }

export interface ClientsOptions {
  stateDir: string
  release: Release | null
  /** boardd's TCP port, which the tunnels forward to. */
  port?: number
  /** Defaults for the hub: the address machines ssh to, and the tunnel user. */
  hub?: { address?: string, tunnel?: string }
  /** A Node binary to give machines of that arch (`uname -m`) that have no Node 24. */
  node?: { path: string, arch: string } | null
  hosts?: Hosts
  machine?: Hub
  checkMs?: number
}

export function clients(options: ClientsOptions): Module {
  return {
    id: 'clients',
    title: '客户端配置',
    setup(lab) {
      const hosts = options.hosts ?? hostsFor(options.stateDir)
      // Node builds kept for machines of another architecture with no internet: <state>/clients/node/<uname -m>/node.
      const nodeFor = (arch: string) => {
        if (!/^[A-Za-z0-9_]+$/.test(arch)) return null
        const path = join(options.stateDir, 'clients', 'node', arch, 'node')
        return existsSync(path) ? path : null
      }
      const hub = options.machine ?? localHub()
      const port = options.port ?? DEFAULT_PORT
      const settings = lab.kernel.settings('clients')
      const json = <T>(key: string, fallback: T): T => { try { return JSON.parse(settings.get(key) ?? '') as T } catch { return fallback } }
      const machines = () => json<Machine[]>('machines', [])
      const saveMachines = (list: Machine[]) => settings.set('machines', JSON.stringify(list))
      const statuses = () => json<Record<string, MachineStatus>>('status', {})
      const setStatus = (id: string, status: MachineStatus | null) => {
        const all = statuses()
        if (status) all[id] = status; else delete all[id]
        settings.set('status', JSON.stringify(all))
        lab.kernel.changed(null)
      }
      const busy = new Set<string>()

      const hubSettings = () => json<{ address?: string, tunnel?: string, sshPort?: number }>('hub', {})
      // As root boardd lets machines in as a user of their own; otherwise as boardd's own user, whose keys it may add.
      const tunnelUser = () => hubSettings().tunnel ?? options.hub?.tunnel ?? (hub.root ? 'boardlab' : hub.user)
      const tunnel = (address?: string): Tunnel | null => {
        const at = address || hubSettings().address || options.hub?.address
        return at ? { address: at, user: tunnelUser(), sshPort: hubSettings().sshPort, port } : null
      }
      const view = (): ClientsView => {
        const now = tunnel(), known = statuses()
        return {
          hub: { address: now?.address ?? null, tunnel: tunnelUser(), sshPort: hubSettings().sshPort ?? null, port, url: now ? tunnelUrl(now) : null },
          release: options.release ? { version: options.release.version, revision: options.release.revision } : null,
          machines: machines().map(machine => ({ ...machine, status: known[machine.id] ?? UNCHECKED, busy: busy.has(machine.id) })),
        }
      }
      const find = (id: string) => { const machine = machines().find(item => item.id === id); if (!machine) throw new BoardError('not-found', `没有这台机器：${id}`); return machine }
      const access = (machine: Machine, password?: string): Access => ({ address: machine.address, user: machine.user, port: machine.sshPort, jump: machine.jump, password })

      const check = async (machine: Machine) => {
        if (busy.has(machine.id)) return
        const was = statuses()[machine.id] ?? UNCHECKED
        try {
          // A problem found before (an install not finished, a tunnel that did not work) stays until boardlab status
          // works there.
          const { problem, ...found } = await checkCli(hosts, access(machine), was.error !== null)
          setStatus(machine.id, { reachable: true, ...found, checkedAt: lab.kernel.iso(), error: problem === undefined ? was.error : problem })
        } catch (error) {
          setStatus(machine.id, { ...was, reachable: false, checkedAt: lab.kernel.iso(), error: (error as Error).message })
        }
      }
      let checking: Promise<void> | null = null
      const checkAll = () => checking ??= (async () => { for (const machine of machines()) await check(machine) })().finally(() => { checking = null })

      lab.addState(() => ({ clients: view() }) as Partial<State>)
      lab.addService(() => {
        const first = setTimeout(() => void checkAll(), 30_000)
        const every = setInterval(() => void checkAll(), options.checkMs ?? 30 * 60_000)
        first.unref(); every.unref()
        return () => { clearTimeout(first); clearInterval(every) }
      })

      lab.api.add('clients', [
        { method: 'GET', path: '/api/clients', about: '装了命令行的机器：各装的是哪个版本、连不连得上，和它们怎么连到这台 boardd（缓存的，check 才去看）', handle: () => view() },
        {
          method: 'POST', path: '/api/clients/settings', about: '机器怎么连到这台 boardd：address（它们 ssh 到的地址）、tunnel（隧道用户）、sshPort',
          handle: ({ body }) => {
            const next = { ...hubSettings() }
            if (body.address !== undefined) next.address = String(body.address).trim() || undefined
            if (body.tunnel !== undefined) next.tunnel = String(body.tunnel).trim() || undefined
            if (body.sshPort !== undefined) next.sshPort = Number(body.sshPort) > 0 && Number(body.sshPort) !== 22 ? Number(body.sshPort) : undefined
            const would = { address: next.address ?? 'example.test', user: next.tunnel ?? tunnelUser(), port }
            try { checkTunnel(would) } catch (error) { throw new BoardError('invalid', (error as Error).message) }
            settings.set('hub', JSON.stringify(next))
            lab.kernel.changed(null)
            return view()
          },
        },
        {
          method: 'POST', path: '/api/clients/install', about: '给一台机器装上命令行并连到这台 boardd（id、address、user、password、jump、sshPort；hub：它 ssh 到这台的地址）：已有的就更新，输出边装边推送',
          handle: ({ body, caller }) => {
            if (!options.release) throw new BoardError('invalid', NO_RELEASE)
            const address = String(body.address ?? '').trim()
            const id = String(body.id ?? '').trim() || address
            const was = machines().find(item => item.id === id)
            const machine: Machine = {
              id, address: address || was?.address || '', user: String(body.user ?? '').trim() || was?.user || '',
              jump: body.jump === undefined ? was?.jump : String(body.jump).trim() || undefined,
              sshPort: body.sshPort === undefined ? was?.sshPort : Number(body.sshPort) > 0 ? Number(body.sshPort) : undefined,
              key: was?.key, addedAt: was?.addedAt ?? lab.kernel.iso(), addedBy: was?.addedBy ?? caller.holder,
            }
            if (!ID.test(id)) throw new BoardError('invalid', '机器名只能用字母、数字、点、横线和下划线')
            if (!machine.address) throw new BoardError('invalid', '要填机器地址：IP、域名或 ssh 配置里的名字')
            if (!machine.user) throw new BoardError('invalid', '要填登录用户：用命令行的那个普通用户')
            if (machine.user === 'root') throw new BoardError('invalid', '命令行要装给普通用户，不能是 root')
            if (busy.has(id)) throw new BoardError('conflict', `${id} 正在装`)
            const hubAddress = String(body.hub ?? '').trim()
            const to = tunnel(hubAddress)
            if (!to) throw new BoardError('invalid', '要填这台 boardd 的地址：那台机器 ssh 到这里用的地址')
            try { checkTunnel(to) } catch (error) { throw new BoardError('invalid', (error as Error).message) }
            if (hubAddress && hubAddress !== hubSettings().address) settings.set('hub', JSON.stringify({ ...hubSettings(), address: hubAddress }))
            saveMachines([...machines().filter(item => item.id !== id), machine])
            const password = typeof body.password === 'string' && body.password ? body.password : undefined
            busy.add(id)
            lab.kernel.changed(null)
            return new EventStream(async (emit, end) => {
              const out = (text: string) => emit('out', { text })
              try {
                const done = await installCli(hosts, hub, options.release!, { id, access: access(machine, password), tunnel: to, node: options.node, nodeFor }, out)
                saveMachines(machines().map(item => item.id === id ? { ...item, key: done.key } : item))
                setStatus(id, { reachable: true, version: done.version, revision: done.revision, remote: done.remote, checkedAt: lab.kernel.iso(), error: done.problem })
                lab.kernel.record(caller.holder, null, 'client-install', `${id} ${done.target}`, done.checked, done.problem ?? done.version)
                emit('exit', done.checked
                  ? { ok: true, message: `装好了：${id} 上的 boardlab ${done.version}（${done.revision}）连上了这台 boardd`, version: done.version }
                  : { ok: false, message: done.problem })
              } catch (error) {
                const message = (error as Error).message
                setStatus(id, { ...(statuses()[id] ?? UNCHECKED), checkedAt: lab.kernel.iso(), error: message })
                lab.kernel.record(caller.holder, null, 'client-install', `${id} ${machine.address}`, false, message)
                emit('exit', { ok: false, message })
              } finally {
                busy.delete(id)
                lab.kernel.changed(null)
              }
              end()
            })
          },
        },
        {
          method: 'POST', path: '/api/clients/check', about: '现在去看机器上装的版本（id；不给就全部）',
          handle: async ({ body }) => {
            if (body.id) await check(find(String(body.id)))
            else await checkAll()
            return view()
          },
        },
        {
          method: 'POST', path: '/api/clients/remove', about: '删掉一台机器（id；uninstall=true 连命令行一起卸掉）：清掉它连这台 boardd 的设置，收回它的隧道授权',
          handle: async ({ body, caller }) => {
            const machine = find(String(body.id ?? ''))
            if (busy.has(machine.id)) throw new BoardError('conflict', `${machine.id} 正在装`)
            busy.add(machine.id)
            const notes: string[] = []
            try {
              await removeCli(hosts, access(machine), body.uninstall === true, () => {})
              notes.push(body.uninstall === true ? '卸掉了那台机器上的命令行' : '那台机器上的命令行不再连这台 boardd')
            } catch (error) { notes.push(`那台机器上的没清掉（${(error as Error).message}）`) }
            finally { busy.delete(machine.id) }
            if (machine.key) {
              const body = keyBody(machine.key)
              const shared = machines().filter(other => other.id !== machine.id && other.key && keyBody(other.key) === body).map(other => other.id)
              const { todo, kept } = await deauthorize(hub, tunnelUser(), machine.id, machine.key, shared.length > 0)
                .catch(error => ({ todo: `（${(error as Error).message}）`, kept: false }))
              notes.push(todo ? `它的隧道授权要手动收回：${todo}`
                : kept ? `${shared.join('、')} 也用这个密钥，隧道授权留着`
                : '收回了它的隧道授权')
            }
            saveMachines(machines().filter(item => item.id !== machine.id))
            setStatus(machine.id, null)
            lab.kernel.record(caller.holder, null, 'client-remove', machine.id, true, notes.join('；'))
            return { ok: true, message: `删除了 ${machine.id}：${notes.join('；')}` }
          },
        },
      ])
      return {}
    },
  }
}
