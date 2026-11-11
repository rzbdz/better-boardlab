/**
 * The `bsp` module, boardlab's wrapper of bsp: bsp board hosts become a backend (boards, leases, relay, download,
 * consoles, builds, discovery, free ports, news), and bsp's SDK work and its registry's catalog are offered to boardlab's
 * clients (`boardlab sdk`, `boardlab registry`, `boardlab bsp`), all through the bsp CLI on boardd's machine.
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, rmSync } from 'node:fs'
import { basename } from 'node:path'
import { EventStream } from 'boardlab-core/core/api.ts'
import { BoardError } from 'boardlab-core/core/errors.ts'
import type { Module } from 'boardlab-core/core/module.ts'
import { bspLab } from './driver.ts'
import { hostsFor } from '../hosts/ssh.ts'
import { installHost, uninstallHost } from './provision.ts'
import { bspSdk, CATALOG_ACTIONS, RAW_REFUSED, SDK_ACTIONS, type SdkGroup, type SdkRunner, type SdkStream } from './sdk.ts'

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
      for (const id of options.instances ?? ['bsp']) lab.backends.register(id, bspLab({ bin: options.bin, sshKey }))
      // A bsp lab is one board host: added on the page, set up there by installing bspd on the host over ssh.
      lab.backends.offer({ kind: 'bsp', title: 'bsp 板卡主机', about: '一台接着板子的 Linux 机器（复位线、串口、下载口）：boardd 用 ssh 给它装上 bspd 并接入', create: () => bspLab({ bin: options.bin, sshKey }) })
      const access = (body: Record<string, unknown>) => {
        const address = String(body.address ?? '').trim()
        if (!address) throw new BoardError('invalid', '要填主机地址：IP、域名或 ssh 配置里的名字')
        return { address, user: String(body.user ?? '').trim() || undefined, port: body.sshPort ? Number(body.sshPort) : undefined, password: typeof body.password === 'string' && body.password ? body.password : undefined, jump: String(body.jump ?? '').trim() || undefined }
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
          const code = await runner.run(mapped, { holder, ...run, group })
          lab.kernel.record(holder, null, group === 'catalog' ? 'catalog' : group === 'raw' ? 'bsp' : 'sdk', args.filter(arg => !arg.startsWith('@')).join(' ').slice(0, 200), code === 0, code ? `退出码 ${code}` : null)
          let sha: string | null = null
          if (download) {
            const saved: string = download
            try {
              if (code === 0 && existsSync(saved)) {
                const stored = await lab.files.put(holder, createHash('sha256').update(readFileSync(saved)).digest('hex'), basename(String(args[2] ?? 'file')), createReadStream(saved))
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
              const done = await installHost(hosts, options.tree!, { id, access: how, board: String(body.board ?? '').trim() || undefined }, null, line => emit('out', { text: line }))
              emit('out', { text: `bspd ${done.version} 在 ${done.target} 上跑起来了，接入实验室 ${id}…` })
              await lab.backends.configure(caller.holder, id, { enabled: true, url: done.url, username: '', password: done.token, devices: '' })
              const tested = await lab.backends.test(caller.holder, id).catch(error => ({ verifyMessage: (error as Error).message, verifyOk: false }))
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
          const url = settings.url?.replace(/^bspd\+/, '') ?? ''
          if (url.startsWith('ssh://')) {
            const parsed = new URL(url)
            await uninstallHost(hosts, { address: parsed.hostname, user: decodeURIComponent(parsed.username) || undefined }, body.purge === true, () => {})
          }
          await lab.backends.removeLab(caller.holder, id)
          return { ok: true }
        },
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
      }])
      return api
    },
  }
}
