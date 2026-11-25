/**
 * The `sftp-images` module: image markets over directories on build servers, reached over ssh from boardd. Which
 * machines, which directories, which files and which SoC a directory's images are for is a market's configuration (a
 * site's), never here. A configured directory is a folder of the market; a file in it that matches the directory's
 * pattern is an image, fetched later as `ssh://<host>/<path>` by the board's backend.
 */
import type { ImageMarket, MarketFound, MarketImage } from 'boardlab-core/core/markets.ts'
import type { Module } from 'boardlab-core/core/module.ts'
import type { MarketEntry } from 'boardlab-core/shared/types.ts'
import type { Access, Executor } from '../hosts/ssh.ts'

/** One directory of a build server, as the market's configuration names it. */
export interface Root { name: string, title: string, host: string, user: string | null, address: string, dir: string, glob: string, soc: string | null }
export interface Ran { code: number | null, stdout: string, stderr: string }
/** Runs a shell command on a root's machine; `signal` stops it when the search that asked is over. */
export type Runner = (root: Root, command: string, signal?: AbortSignal) => Promise<Ran>

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const HOST = /^(?:([A-Za-z0-9_.-]+)@)?([A-Za-z0-9_.:-]+)$/
const DIR = /^[/][A-Za-z0-9_.+@:/-]*$/
const GLOB = /^[A-Za-z0-9_.*?+-]+$/
const FILE = /^[A-Za-z0-9][A-Za-z0-9_.+@-]*$/

/** The market's settings, checked: what is wrong is said, so the page can show it. */
export function sftpConfig(config: Record<string, unknown>): Root[] {
  const list = config.roots
  if (!Array.isArray(list) || !list.length) throw new Error('roots 要写：目录的数组，每个有 name、host、dir')
  const roots: Root[] = []
  for (const item of list as Array<Record<string, unknown>>) {
    if (!item || typeof item !== 'object') throw new Error('roots 的每一项要是一组设置')
    const name = String(item.name ?? '')
    if (!NAME.test(name)) throw new Error(`name 只能用字母、数字、. - _：${name || '（没写）'}`)
    if (roots.some(root => root.name === name)) throw new Error(`name 重复：${name}`)
    const host = HOST.exec(String(item.host ?? ''))
    if (!host) throw new Error(`${name} 的 host 要写 [用户@]主机`)
    const dir = String(item.dir ?? '').replace(/[/]+$/, '')
    if (!DIR.test(dir) || dir.split('/').includes('..')) throw new Error(`${name} 的 dir 要是绝对路径，不带 .. 和特殊字符：${item.dir ?? '（没写）'}`)
    const glob = String(item.glob ?? '*.zip')
    if (!GLOB.test(glob) || glob.includes('/')) throw new Error(`${name} 的 glob 只能用字母、数字、. - _ + 和 * ?：${glob}`)
    if (item.soc !== undefined && item.soc !== null && typeof item.soc !== 'string') throw new Error(`${name} 的 soc 要是字符串`)
    roots.push({ name, title: typeof item.title === 'string' && item.title ? item.title : name, host: host[0], user: host[1] ?? null, address: host[2]!, dir, glob, soc: (item.soc as string | null | undefined) || null })
  }
  return roots
}

/** A file name pattern as a regular expression: `*` and `?` stay inside one name. */
const globExp = (glob: string) => new RegExp(`^${glob.replace(/[.+*?-]/g, c => c === '*' ? '[^/]*' : c === '?' ? '[^/]' : `[${c}]`)}$`)

interface Found { name: string, size: number, modified: string }

/** `find … -exec stat` lines (`path|size|seconds`), the names that are safe to hand on. */
function found(stdout: string): Found[] {
  const files: Found[] = []
  for (const line of stdout.split('\n')) {
    const m = /^(.*)[|]([0-9]+)[|]([0-9]+)$/.exec(line.trim())
    const name = m?.[1]?.split('/').at(-1)
    if (m && name && FILE.test(name)) files.push({ name, size: Number(m[2]), modified: new Date(Number(m[3]) * 1000).toISOString() })
  }
  return files
}

export function sftpMarket(settings: Record<string, unknown>, run: Runner): ImageMarket {
  const roots = sftpConfig(settings)
  const root = (name: string | undefined) => roots.find(item => item.name === name) ?? (() => { throw new Error(`没有这个目录：${name}`) })()
  // Every value in a command was checked against a safe alphabet above, so single quotes are enough.
  async function files(at: Root, name: string, signal?: AbortSignal): Promise<Found[]> {
    signal?.throwIfAborted()
    const result = await run(at, `find '${at.dir}' -maxdepth 1 -type f -name '${name}' -exec stat -c '%n|%s|%Y' {} +`, signal)
    if (result.code !== 0) throw new Error(`${at.host} 上读不了 ${at.dir}：${result.stderr.trim().split('\n').filter(Boolean).at(-1) ?? `退出码 ${result.code}`}`)
    return found(result.stdout)
  }
  return {
    scheme: 'ssh',
    async list(path) {
      const parts = path.split('/').filter(Boolean)
      // The directories as the configuration lists them, in its order.
      if (!parts.length) return roots.map((item, order): MarketEntry => ({ path: item.name, name: item.title, kind: 'folder', soc: item.soc, note: item.dir, order }))
      if (parts.length > 1) throw new Error('这个市场只有一层目录')
      const at = root(parts[0])
      return (await files(at, at.glob)).map((file): MarketEntry => ({ path: `${at.name}/${file.name}`, name: file.name, kind: 'image', soc: at.soc, size: file.size, modified: file.modified }))
    },
    // A directory is one `find` and a search asks each of them in turn: a few directories, over ssh.
    async search(text, signal) {
      const words = text.toLowerCase()
      const out: MarketEntry[] = []
      let partial = false
      for (const at of roots) {
        // A machine that cannot be read (gone, or the words changed and the search stopped) leaves the answer short.
        if (signal?.aborted) { partial = true; break }
        let all: Found[]
        try { all = await files(at, at.glob, signal) }
        catch (error) {
          if (signal?.aborted) { partial = true; break }
          // One machine down is not the market: the others are still searched, and the answer says it is not whole.
          partial = true
          continue
        }
        const matches = all.filter(file => file.name.toLowerCase().includes(words))
        if (!matches.length) continue
        out.push({ path: at.name, name: at.title, kind: 'folder', soc: at.soc, note: at.dir, order: roots.indexOf(at) })
        for (const file of matches) out.push({ path: `${at.name}/${file.name}`, name: file.name, kind: 'image', soc: at.soc, size: file.size, modified: file.modified })
      }
      return { entries: out, partial }
    },
    async locate(path): Promise<MarketImage> {
      const parts = path.split('/').filter(Boolean)
      if (parts.length !== 2) throw new Error(`${path} 不是一个镜像`)
      const at = root(parts[0]), name = parts[1]!
      if (!FILE.test(name) || !globExp(at.glob).test(name)) throw new Error(`${path} 不是这个市场的镜像`)
      const file = (await files(at, name)).find(item => item.name === name)
      if (!file) throw new Error(`${at.host} 上 ${at.dir} 里没有 ${name}`)
      return { url: `ssh://${at.user ? `${at.user}@` : ''}${at.address}${at.dir}/${name}`, name, size: file.size, sha256: null }
    },
  }
}

/** `reach` is how boardd gets onto a machine (the hosts library); a machine reached is kept for the next listing. */
export function sftpImages(reach: (access: Access) => Promise<Executor>): Module {
  return {
    id: 'sftp-images',
    title: '构建服务器镜像市场',
    setup(lab) {
      const machines = new Map<string, Promise<Executor>>()
      const run: Runner = async (at, command, signal) => {
        signal?.throwIfAborted()
        let machine = machines.get(at.host)
        if (!machine) { machine = reach({ address: at.address, ...(at.user ? { user: at.user } : {}) }); machines.set(at.host, machine) }
        try {
          const result = await (await machine).run(command, { timeoutMs: 30_000, signal })
          // 255 is ssh itself failing: reach the machine again next time.
          if (result.code === 255 || result.code === null) machines.delete(at.host)
          return result
        } catch (error) { machines.delete(at.host); throw error }
      }
      lab.markets.offer({
        kind: 'sftp', title: '构建服务器目录', about: '构建服务器上的目录（ssh 登录）：每个设好的目录是一个文件夹，里面符合 glob 的文件是镜像；机器、目录和 SoC 由市场设置里的 roots 说',
        create: config => sftpMarket(config, run),
      })
    },
  }
}
