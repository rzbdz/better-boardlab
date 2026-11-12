/**
 * The bsp site boardd keeps: one working copy, at `<state>/bsp/site`, of what every bsp board host reads from
 * /etc/bsp/site besides its own `hosts/` file: SoC profiles (`socs/`), the SDK catalog (`sdk/`), hooks and the images
 * the profiles stage (`.blobs/`). Its source is a git repository (cloned, pulled and pushed with boardd's key, then this
 * machine's ssh setup) or boardd itself ("managed here"); the copy is a git repository either way, and every edit made
 * through boardd is a commit by whoever made it. Edits are checked the way bsp loads its SDK catalog, so a site that
 * reaches a host loads there. Images the SoC profiles list but the site keeps out of git are fetched into `.blobs/` by
 * the bsp CLI (`bsp images sync`) after each pull and before each sync, so the hosts get them with the site.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { Document, isMap, parse, parseDocument } from 'yaml'
import { BoardError } from 'boardlab-core/core/errors.ts'
import type { Settings } from 'boardlab-core/core/kernel.ts'

/** The kinds of SDK catalog documents, each a directory of `<id>.yaml` under `sdk/`. */
export const KINDS = ['instances', 'servers', 'workspaces', 'families'] as const
export type Kind = typeof KINDS[number]
/** What goes to the hosts; their `hosts/` stays theirs. */
export const SHIPPED = ['socs', 'sdk', 'hooks', '.blobs'] as const
const BOOT_METHODS = ['load', 'download'] as const
const STEP_KINDS = new Set(['enter-fdl', 'reset', 'wait', 'stage', 'continue', 'oem', 'flash', 'getvar', 'settle', 'hook', 'check', 'boot-media'])
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/

type Data = Record<string, unknown>
interface Loaded { kind: Kind, id: string, file: string, rel: string, text: string, data: Data, layer: string }
type Docs = Record<Kind, Map<string, Loaded>>

export interface SiteDoc { kind: Kind, id: string, file: string, layer: string, text: string, fields: Record<string, string> }
/** An SDK's own instructions, `skills/<id>.md` in the site or a pack. */
export interface SiteSkill { id: string, layer: string, file: string, title: string }
export interface HostSync { revision: string, at: string, ok: boolean, message: string }
/** The last `bsp images sync` on the copy: which images are there, which could not be fetched, which nobody can fetch. */
export interface ImagesState {
  at: string, ok: boolean, message: string
  /** `<soc>/<image>` */
  fetched: string[], present: string[], failed: Array<{ image: string, error: string }>
  /** Listed with no file in any layer and no source to fetch it from, and staged by an SDK's or SoC's boot steps. */
  missing: string[]
  /**
   * Listed with no file and no source, and staged by nothing but discovery (a SoC's probe images): nothing fails
   * without them, a board found is just not told apart by model.
   */
  optional?: string[]
}
export interface SiteStatus {
  source: 'managed' | 'git', url: string, branch: string
  /** The copy is there (a git source not fetched yet is not). */
  ready: boolean
  /** Short commit, `-dirty` when files changed outside boardd; null before the first commit. */
  revision: string | null
  /** That commit's subject and when it was made. */
  commit: { subject: string, at: string } | null
  /** Commits here the source does not have yet (git). */
  ahead: number
  docs: SiteDoc[]
  /** The SDK skills the site and its packs carry, the site's own over a pack's same id. */
  skills: SiteSkill[]
  socs: Array<{ soc: string, layer: string }>
  problems: string[]
  hosts: Record<string, HostSync>
  syncing: boolean
  images: ImagesState | null
}

interface Run { code: number, stdout: string, stderr: string }
const exec = (command: string, args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv = {}) => new Promise<Run>(resolve =>
  execFile(command, args, { cwd, env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', COPYFILE_DISABLE: '1', ...env }, maxBuffer: 32 * 1024 * 1024, timeout: 600_000 },
    (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr || (error ? error.message : '')) })))
/** What git says when a way into the source does not get in: worth trying the next one. */
const NOT_IN = /Permission denied|Could not read from remote repository|Host key verification failed|Could not resolve hostname|Connection (?:refused|timed out|closed|reset)|No route to host|Network is unreachable|kex_exchange_identification|Too many authentication failures|ssh: connect to host/i
const last = (run: Run) =>(run.stderr || run.stdout).trim().split('\n').filter(Boolean).at(-1) ?? `退出码 ${run.code}`
const isData = (value: unknown): value is Data => !!value && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown) => value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
/** A Markdown skill's title: its first `# ` heading, or its id. */
const titleOf = (text: string, id: string) => /^#\s+(.+?)\s*$/m.exec(text)?.[1]?.trim() || id

/** Whether `docs` loads the way bsp's SdkCatalog loads it; what is wrong, by file, when not. */
export function validate(docs: Docs): string[] {
  const out: string[] = []
  const has = (kind: Kind, id: unknown) => typeof id === 'string' && docs[kind].has(id)
  for (const s of docs.servers.values()) if (!s.data.host || !s.data.user) out.push(`${s.rel}：编译服务器要有 host 和 user`)
  for (const w of docs.workspaces.values()) {
    if (!has('servers', w.data.server)) out.push(`${w.rel}：没有编译服务器 ${str(w.data.server) || '（没写 server）'}`)
    if (!w.data.path) out.push(`${w.rel}：源码树要有 path`)
  }
  for (const i of docs.instances.values()) {
    const d = i.data, at = (text: string) => out.push(`${i.rel}：${text}`)
    const boot = isData(d.boot) ? d.boot : {}
    const missing = BOOT_METHODS.filter(method => !(method in boot))
    if (missing.length) at(`boot 要有 load 和 download（缺 ${missing.join('、')}；还没写的用 status: todo 和 steps: []）`)
    const steps: Data[] = []
    for (const method of BOOT_METHODS) {
      if (!(method in boot)) continue
      const b = isData(boot[method]) ? boot[method] as Data : {}
      const status = b.status ?? 'todo', list = Array.isArray(b.steps) ? b.steps : []
      if (status !== 'ready' && status !== 'todo') at(`boot.${method}.status 只能是 ready 或 todo`)
      if (status === 'ready' && !list.length) at(`boot.${method} 是 ready，却没有步骤`)
      for (const step of list) {
        if (!isData(step) || !STEP_KINDS.has(String(step.do))) at(`boot.${method}：不认识的步骤 ${isData(step) ? str(step.do) : str(step)}`)
        else steps.push(step)
      }
    }
    if (d.workspace) { if (!has('workspaces', d.workspace)) at(`没有源码树 ${str(d.workspace)}`) }
    else if (d.server === undefined || d.path === undefined) at('要么写 workspace，要么写 server 和 path')
    else {
      if (!has('servers', d.server)) at(`没有编译服务器 ${str(d.server)}`)
      if (docs.workspaces.has(i.id)) at(`和源码树 ${i.id} 重名`)
    }
    const family = typeof d.family === 'string' ? docs.families.get(d.family) : undefined
    if (!family) { at(`没有编译方式 ${str(d.family) || '（没写 family）'}`); continue }
    const artifacts = isData(family.data.artifacts) ? family.data.artifacts : {}
    const roles = new Set([...Object.keys(isData(artifacts.roles) ? artifacts.roles : {}), ...Object.keys(isData(d.artifacts) ? d.artifacts : {})])
    for (const step of steps) {
      for (const role of [...(Array.isArray(step.artifacts) ? step.artifacts : []), ...(step.artifact === undefined ? [] : [step.artifact])])
        if (!roles.has(String(role))) at(`步骤用了没有的产物 ${str(role)}（有：${[...roles].join('、') || '无'}）`)
    }
  }
  return out
}

/** What a page lists for a document. */
function fields(doc: Loaded): Record<string, string> {
  const d = doc.data
  const pick = (...keys: string[]) => Object.fromEntries(keys.filter(key => d[key] !== undefined).map(key => [key, str(d[key])]))
  if (doc.kind === 'instances') {
    const boot = isData(d.boot) ? d.boot : {}
    // Its boot methods as the YAML they are written in (comments kept), for editing on their own.
    const node = parseDocument(doc.text).get('boot', true)
    const yaml = new Document(null); yaml.contents = node as never
    return {
      ...pick('family', 'server', 'path', 'workspace', 'soc', 'description'),
      ...Object.fromEntries(BOOT_METHODS.map(method => [method, isData(boot[method]) ? str((boot[method] as Data).status ?? 'todo') : '']).filter(([, value]) => value)),
      ...(node === undefined ? {} : { boot: yaml.toString() }),
    }
  }
  if (doc.kind === 'servers') return pick('host', 'user', 'description')
  if (doc.kind === 'workspaces') return pick('server', 'path', 'description')
  return { ...pick('description'), ...(isData(d.build) && d.build.runner ? { runner: str(d.build.runner) } : {}) }
}

/** A new SDK's boot methods: there, not written yet. */
const TODO_BOOT = { load: { status: 'todo', notes: 'boot steps not written yet', steps: [] }, download: { status: 'todo', notes: 'boot steps not written yet', steps: [] } }

export interface SdkInput { id: string, family: string, server?: string, path?: string, workspace?: string, soc?: string, description?: string, boot?: string, original?: string }
export interface ServerInput { id: string, host: string, user: string, description?: string, original?: string }

export class Site {
  private queue: Promise<unknown> = Promise.resolve()
  syncing = false

  /**
   * `tree`: the bsp tree, whose packs the hosts layer under the site. `sshCommands`: the ways in for git over ssh.
   * `bin`: the bsp CLI that fetches the site's images (none: images are not fetched).
   */
  constructor(readonly dir: string, private readonly settings: Settings, private readonly options: { tree?: string | null, sshCommands?: () => Promise<string[]>, bin?: string } = {}) {}

  get source(): 'managed' | 'git' { return this.settings.get('source') === 'git' ? 'git' : 'managed' }
  get url(): string { return this.settings.get('url') ?? '' }
  get branch(): string { return this.settings.get('branch') || 'main' }
  get ready(): boolean { return existsSync(join(this.dir, '.git')) }

  /** One change at a time. */
  serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => {})
    return next
  }

  private git(args: string[], cwd = this.dir, env: NodeJS.ProcessEnv = {}) { return exec('git', args, cwd, env) }
  /**
   * A git command that talks to the source: each way in while the last one could not get in (login or connection
   * refused); any other answer, a rejected push say, is the source's and stands. When none gets in, the first one's error.
   */
  private async remote(args: string[], cwd?: string, before?: () => void): Promise<Run> {
    const ways = this.options.sshCommands ? await this.options.sshCommands() : []
    let first: Run | null = null
    for (const ssh of ways.length ? ways : [null]) {
      before?.()
      const result = await this.git(args, cwd, ssh ? { GIT_SSH_COMMAND: ssh } : {})
      if (result.code === 0 || !NOT_IN.test(result.stderr)) return result
      first ??= result
    }
    return first!
  }

  private async commit(holder: string, message: string): Promise<void> {
    await this.git(['add', '-A'])
    if (!(await this.git(['status', '--porcelain'])).stdout.trim()) return
    const done = await this.git(['-c', `user.name=${holder}`, '-c', 'user.email=boardlab@localhost', 'commit', '-q', '--no-verify', '-m', message])
    if (done.code !== 0) throw new Error(`提交站点的改动失败：${last(done)}`)
  }

  /** A fresh repository for a site kept here (or one whose source has nothing yet). */
  private async init(dir: string, holder: string): Promise<void> {
    mkdirSync(dir, { recursive: true })
    const made = await this.git(['init', '-q', '-b', this.branch], dir)
    if (made.code !== 0) throw new Error(`建站点仓库失败：${last(made)}`)
    if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), '# images, fetched by sha256: kept out of git\n.blobs/\n')
    await this.git(['add', '-A'], dir)
    await this.git(['-c', `user.name=${holder}`, '-c', 'user.email=boardlab@localhost', 'commit', '-q', '--no-verify', '-m', 'Start the bsp site'], dir)
  }

  /** Images stay out of git, whatever the source's own .gitignore says. */
  private exclude(dir: string) {
    const file = join(dir, '.git', 'info', 'exclude')
    mkdirSync(dirname(file), { recursive: true })
    const now = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (!/^\/?\.blobs\/?$/m.test(now)) writeFileSync(file, `${now}${now && !now.endsWith('\n') ? '\n' : ''}.blobs/\n`)
  }

  /**
   * Fetch the git source into the copy. A copy that is there becomes the source's branch in place (see `adopt`); with
   * none yet, a clone beside it is put in.
   */
  private async fetchSource(holder: string, discard = false): Promise<string> {
    mkdirSync(dirname(this.dir), { recursive: true })
    const ref = `refs/heads/${this.branch}`
    const heads = await this.remote(['ls-remote', '--', this.url, ref], dirname(this.dir))
    if (heads.code !== 0) throw new BoardError('invalid', `取不到 ${this.url}：${last(heads)}`)
    // That branch exactly (a pattern also matches `refs/heads/<anything>/<branch>`).
    if (!heads.stdout.split('\n').some(line => line.split('\t')[1]?.trim() === ref)) {
      // The source has no such branch yet: this copy (or a new one) becomes it at the first push.
      if (!this.ready) await this.init(this.dir, holder)
      await this.git(['remote', 'remove', 'origin'])
      await this.git(['remote', 'add', 'origin', this.url])
      this.exclude(this.dir)
      return `${this.url} 还没有分支 ${this.branch}：推送时用这里的站点建它`
    }
    if (this.ready) return this.adopt(holder, discard)
    const fresh = `${this.dir}.new`
    const cloned = await this.remote(['clone', '-q', '-b', this.branch, '--', this.url, fresh], dirname(this.dir), () => rmSync(fresh, { recursive: true, force: true }))
    if (cloned.code !== 0) { rmSync(fresh, { recursive: true, force: true }); throw new BoardError('invalid', `克隆 ${this.url} 失败：${last(cloned)}`) }
    this.exclude(fresh)
    // Not a repository: nothing in it is a commit of the site's, but it is not thrown away either.
    let aside: string | null = null
    if (existsSync(this.dir)) {
      if (readdirSync(this.dir).length) { aside = `${this.dir}.old-${Date.now()}`; renameSync(this.dir, aside) }
      else rmSync(this.dir, { recursive: true, force: true })
    }
    renameSync(fresh, this.dir)
    return `取下了 ${this.url} 的 ${this.branch}${aside ? `（原来目录里的东西留在 ${aside}）` : ''}`
  }

  /**
   * Make the copy there the source's branch, in place (its images stay). A copy that already follows that branch keeps
   * its own commits, rebased onto the source's (a conflict changes nothing). Any other copy (another source, or a site
   * kept here) is replaced by the branch only when it has nothing the branch lacks: no commits of its own, no changes
   * not committed. Otherwise it is refused, unless `discard`; then the copy's commits are kept in a local branch.
   */
  private async adopt(holder: string, discard: boolean): Promise<string> {
    const was = (await this.git(['remote', 'get-url', 'origin'])).stdout.trim() || null
    const on = (await this.git(['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim()
    const origin = async (url: string | null) => {
      await this.git(['remote', 'remove', 'origin'])
      if (url) await this.git(['remote', 'add', 'origin', url])
    }
    await origin(this.url)
    this.exclude(this.dir)
    const theirs = `refs/remotes/origin/${this.branch}`
    const fetched = await this.remote(['fetch', '-q', 'origin', `+refs/heads/${this.branch}:${theirs}`])
    if (fetched.code !== 0) { await origin(was); throw new BoardError('invalid', `取 ${this.url} 失败：${last(fetched)}`) }
    const what = `${this.url} 的 ${this.branch}`

    if (was === this.url && on === this.branch) {
      if ((await this.git(['status', '--porcelain'])).stdout.trim()) await this.commit(holder, 'Files changed in the copy')
      const moved = await this.git(['-c', `user.name=${holder}`, '-c', 'user.email=boardlab@localhost', 'rebase', '-q', theirs])
      if (moved.code === 0) return `取下了 ${what}${await this.ahead() ? '，这里的提交排在它之后' : ''}`
      await this.git(['rebase', '--abort'])
      if (!discard) throw new BoardError('conflict', `${what} 和这里的提交冲突，什么都没变：${last(moved)}。要丢掉这里的提交，勾上“丢掉这里的改动”再换`)
    }

    // The copy's own work: changes not committed, and commits that change more than .gitignore (a site started here has
    // one that only adds it) and are not in the branch.
    const dirty = Boolean((await this.git(['status', '--porcelain'])).stdout.trim())
    const hasHead = (await this.git(['rev-parse', '-q', '--verify', 'HEAD'])).code === 0
    const own = hasHead ? await this.git(['rev-list', '--cherry-pick', '--right-only', '--no-merges', `${theirs}...HEAD`, '--', '.', ':(exclude).gitignore']) : null
    if (own && own.code !== 0) { await origin(was); throw new BoardError('invalid', `看不出这里的站点有没有 ${what} 里没有的提交：${last(own)}`) }
    const commits = own ? own.stdout.split('\n').filter(Boolean).length : 0
    let keptIn: string | null = null
    if (commits || dirty) {
      const lost = [commits ? `${commits} 个提交` : '', dirty ? '没提交的改动' : ''].filter(Boolean).join('和')
      if (!discard) {
        await origin(was)
        throw new BoardError('conflict', `这里的站点有 ${what} 里没有的${lost}：换过去就丢了，什么都没变。先把它们推送到原来的来源（或拉取后推送），确定不要了再勾上“丢掉这里的改动”换`)
      }
      if (dirty) await this.commit(holder, 'Files changed in the copy')
      keptIn = `discarded-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`
      await this.git(['branch', '-f', keptIn, 'HEAD'])
    }
    const switched = await this.git(['checkout', '-q', '-f', '-B', this.branch, theirs])
    if (switched.code !== 0) { await origin(was); throw new BoardError('invalid', `换到 ${what} 失败：${last(switched)}`) }
    await this.git(['reset', '-q', '--hard', theirs])
    await this.git(['clean', '-q', '-fd'])
    return `取下了 ${what}${keptIn ? `（丢掉的改动留在这里的本地分支 ${keptIn}）` : ''}`
  }

  /** Make sure there is a copy to edit: a site kept here starts empty. */
  private async ensure(holder: string): Promise<void> {
    if (this.ready) return
    if (this.source === 'git') throw new BoardError('invalid', `站点还没从 ${this.url || '它的来源'} 取下来：先拉取`)
    await this.init(this.dir, holder)
  }

  /**
   * Change where the site comes from. A git source is fetched now, refused when the copy has work it lacks unless
   * `discard` (see `adopt`); going back to "managed here" keeps the copy.
   */
  setSource(holder: string, input: { source: string, url?: string, branch?: string, discard?: boolean }): Promise<string> {
    return this.serial(async () => {
      if (input.source === 'managed') {
        if (this.ready) await this.git(['remote', 'remove', 'origin'])
        else await this.init(this.dir, holder)
        this.settings.set('source', 'managed'); this.settings.set('url', null)
        return '站点就在这里管：编辑后同步到主机'
      }
      if (input.source !== 'git') throw new BoardError('invalid', `来源只能是 managed 或 git，不是 ${input.source}`)
      const url = String(input.url ?? '').trim(), branch = String(input.branch ?? '').trim() || 'main'
      if (!url || /\s/.test(url) || url.startsWith('-')) throw new BoardError('invalid', '要给 git 仓库地址，例如 git@git.example.test:lab/bsp-site.git')
      if (!BRANCH.test(branch) || branch.includes('..')) throw new BoardError('invalid', `不合法的分支名：${branch}`)
      const before = { source: this.settings.get('source'), url: this.settings.get('url'), branch: this.settings.get('branch') }
      this.settings.set('source', 'git'); this.settings.set('url', url); this.settings.set('branch', branch)
      let message: string
      try { message = await this.fetchSource(holder, input.discard === true) }
      catch (error) { for (const [key, value] of Object.entries(before)) this.settings.set(key, value); throw error }
      const images = await this.fetchImages()
      return images ? `${message}；${images.message}` : message
    })
  }

  /** Take the source's new commits (git): rebased under the ones made here; a conflict changes nothing. */
  pull(holder: string): Promise<{ message: string, revision: string | null }> {
    return this.serial(async () => {
      if (this.source !== 'git') throw new BoardError('invalid', '站点就在这里管，没有来源可拉')
      if (!this.ready || !(await this.git(['remote', 'get-url', 'origin'])).stdout.trim()) {
        const message = await this.fetchSource(holder), images = await this.fetchImages()
        return { message: images ? `${message}；${images.message}` : message, revision: await this.revision() }
      }
      const was = await this.revision()
      const fetched = await this.remote(['fetch', '-q', 'origin', `+refs/heads/${this.branch}:refs/remotes/origin/${this.branch}`])
      if (fetched.code !== 0) throw new BoardError('invalid', `拉取 ${this.url} 失败：${last(fetched)}`)
      if ((await this.git(['status', '--porcelain'])).stdout.trim()) await this.commit(holder, 'Files changed in the copy')
      const moved = await this.git(['-c', `user.name=${holder}`, '-c', 'user.email=boardlab@localhost', 'rebase', '-q', `origin/${this.branch}`])
      if (moved.code !== 0) {
        await this.git(['rebase', '--abort'])
        throw new BoardError('conflict', `拉下来的改动和这里的改动冲突，什么都没变：${last(moved)}`)
      }
      const now = await this.revision(), images = await this.fetchImages()
      const message = now === was ? '已经是最新' : `${was ?? '空'} → ${now}`
      return { message: images ? `${message}；${images.message}` : message, revision: now }
    })
  }

  /** Send the commits made here to the source (git). */
  push(): Promise<string> {
    return this.serial(async () => {
      if (this.source !== 'git' || !this.ready) throw new BoardError('invalid', '站点没有 git 来源，不用推送')
      const pushed = await this.remote(['push', '-q', 'origin', `HEAD:refs/heads/${this.branch}`])
      if (pushed.code !== 0) {
        if (/rejected|non-fast-forward|fetch first/.test(pushed.stderr)) throw new BoardError('conflict', '来源上有这里没有的提交：先拉取，再推送')
        throw new BoardError('invalid', `推送到 ${this.url} 失败：${last(pushed)}`)
      }
      await this.remote(['fetch', '-q', 'origin', `+refs/heads/${this.branch}:refs/remotes/origin/${this.branch}`])
      return `推送到了 ${this.url} 的 ${this.branch}`
    })
  }

  async revision(): Promise<string | null> {
    if (!this.ready) return null
    const head = await this.git(['rev-parse', '--short', 'HEAD'])
    if (head.code !== 0) return null
    const dirty = (await this.git(['status', '--porcelain'])).stdout.trim()
    return `${head.stdout.trim()}${dirty ? '-dirty' : ''}`
  }

  /** The subject and time of the commit the copy is at. */
  private async head(): Promise<{ subject: string, at: string } | null> {
    if (!this.ready) return null
    const head = await this.git(['log', '-1', '--format=%cI%x00%s'])
    if (head.code !== 0 || !head.stdout.trim()) return null
    const [at, subject] = head.stdout.trim().split('\0')
    return { subject: subject ?? '', at: at ?? '' }
  }

  private async ahead(): Promise<number> {
    if (this.source !== 'git' || !this.ready) return 0
    const tracked = (await this.git(['rev-parse', '--verify', '-q', `refs/remotes/origin/${this.branch}`])).code === 0
    const count = await this.git(['rev-list', '--count', tracked ? `origin/${this.branch}..HEAD` : 'HEAD'])
    return count.code === 0 ? Number(count.stdout.trim()) || 0 : 0
  }

  /** The layers the hosts read, lowest first: the bsp tree's packs (those the site's bsp.yaml picks), then the site. */
  private layers(): Array<{ name: string, root: string }> {
    const packs = this.options.tree ? join(this.options.tree, 'packs') : null
    const out: Array<{ name: string, root: string }> = []
    if (packs && existsSync(packs)) {
      let wanted: unknown = null
      try { wanted = (parse(readFileSync(join(this.dir, 'bsp.yaml'), 'utf8')) as Data | null)?.packs ?? null } catch {}
      for (const name of readdirSync(packs).sort())
        if (statSync(join(packs, name)).isDirectory() && (!Array.isArray(wanted) || wanted.includes(name))) out.push({ name, root: join(packs, name) })
    }
    out.push({ name: 'site', root: this.dir })
    return out
  }

  /** The catalog as the hosts load it (`skip`: as it would be without that file). */
  private load(skip?: string): { docs: Docs, problems: string[] } {
    const docs = Object.fromEntries(KINDS.map(kind => [kind, new Map<string, Loaded>()])) as Docs, problems: string[] = []
    for (const layer of this.layers()) for (const kind of KINDS) {
      const at = join(layer.root, 'sdk', kind)
      if (!existsSync(at)) continue
      for (const name of readdirSync(at).filter(name => name.endsWith('.yaml')).sort()) {
        const file = join(at, name)
        if (file === skip) continue
        const rel = layer.name === 'site' ? relative(this.dir, file) : `packs/${layer.name}/sdk/${kind}/${name}`
        const text = readFileSync(file, 'utf8')
        const parsed = parseDocument(text)
        if (parsed.errors.length) { problems.push(`${rel}：YAML 写错了：${parsed.errors[0]!.message.split('\n')[0]}`); continue }
        const data = parsed.toJS() as unknown
        if (!isData(data) || data.id === undefined) { problems.push(`${rel}：要是一个带 id 的映射`); continue }
        docs[kind].set(String(data.id), { kind, id: String(data.id), file, rel, text, data, layer: layer.name })
      }
    }
    return { docs, problems }
  }

  /** What is wrong with the site as it is: what a host would refuse to load. */
  problems(): string[] {
    if (!this.ready) return []
    const { docs, problems } = this.load()
    return [...problems, ...validate(docs)]
  }

  /**
   * The skills the site and its packs carry, lowest layer first (`skills/<id>.md`): the site's own over a pack's same
   * id, as with documents. A skill's title is its first `# ` heading, or its id.
   */
  private loadSkills(): Map<string, { id: string, layer: string, file: string, rel: string, text: string }> {
    const skills = new Map<string, { id: string, layer: string, file: string, rel: string, text: string }>()
    for (const layer of this.layers()) {
      const at = join(layer.root, 'skills')
      if (!existsSync(at)) continue
      for (const name of readdirSync(at).filter(name => name.endsWith('.md')).sort()) {
        const id = name.slice(0, -'.md'.length)
        if (!ID.test(id)) continue
        const file = join(at, name)
        skills.set(id, { id, layer: layer.name, file, rel: layer.name === 'site' ? `skills/${name}` : `packs/${layer.name}/skills/${name}`, text: readFileSync(file, 'utf8') })
      }
    }
    return skills
  }

  /** The skills there are, with where each comes from and its title. Pack skills come first, the site's over them. */
  skills(): SiteSkill[] {
    return [...this.loadSkills().values()].map(skill => ({ id: skill.id, layer: skill.layer, file: skill.rel, title: titleOf(skill.text, skill.id) }))
  }

  /** One skill's Markdown, from wherever it is. */
  skill(id: string): { id: string, layer: string, text: string } {
    const found = this.loadSkills().get(String(id ?? '').trim())
    if (!found) throw new BoardError('not-found', `站点里没有 SDK 的 skill：${String(id ?? '').trim() || '（没写 id）'}`)
    return { id: found.id, layer: found.layer, text: found.text }
  }

  /**
   * Write an SDK's skill as `skills/<id>.md` (`original`: the id it had, when editing). Refused when empty or badly
   * named; skills are not part of the catalog bsp loads, so nothing else is checked. Committed like every other edit.
   */
  putSkill(holder: string, id: string, text: string, original?: string): Promise<SiteSkill> {
    return this.serial(async () => {
      await this.ensure(holder)
      const name = String(id ?? '').trim(), was = String(original ?? '').trim() || undefined
      if (!ID.test(name)) throw new BoardError('invalid', `不合法的名字：${name || '（没写）'}（字母、数字、. _ -）`)
      if (!String(text ?? '').trim()) throw new BoardError('invalid', 'skill 的内容不能为空')
      const skills = this.loadSkills()
      const old = was ? skills.get(was) : undefined
      if (was && (!old || old.layer !== 'site')) throw new BoardError('not-found', `站点里没有 skill ${was}`)
      const taken = skills.get(name)
      if (taken?.layer === 'site' && taken.id !== old?.id) throw new BoardError('conflict', `已经有 skill ${name} 了`)
      const file = old && was === name ? old.file : join(this.dir, 'skills', `${name}.md`)
      if (file !== old?.file && existsSync(file)) throw new BoardError('conflict', `已经有 skills/${name}.md 了：换个名字`)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`)
      if (old && old.file !== file) unlinkSync(old.file)
      await this.commit(holder, `${was ? 'Edit' : 'Add'} skill ${name}`)
      return { id: name, layer: 'site', file: relative(this.dir, file), title: titleOf(text, name) }
    })
  }

  /** Take the site's own skill out; a pack's with that id, if any, is what there is afterwards. */
  removeSkill(holder: string, id: string): Promise<string> {
    return this.serial(async () => {
      await this.ensure(holder)
      const name = String(id ?? '').trim()
      if (!ID.test(name)) throw new BoardError('invalid', `不合法的名字：${name || '（没写）'}（字母、数字、. _ -）`)
      const found = this.loadSkills().get(name)
      if (!found || found.layer !== 'site') throw new BoardError('not-found', `站点里没有 skill ${name}`)
      unlinkSync(found.file)
      await this.commit(holder, `Remove skill ${name}`)
      const under = this.loadSkills().get(name)
      return `删掉了 ${name}${under ? `：用回 ${under.rel} 里的` : ''}`
    })
  }

  async status(labs: string[] = []): Promise<SiteStatus> {
    if (!this.ready && this.source === 'managed') await this.serial(() => this.ensure('boardd'))
    const { docs, problems } = this.ready ? this.load() : { docs: null, problems: [] }
    const socs: SiteStatus['socs'] = []
    if (this.ready) for (const layer of this.layers()) {
      const at = join(layer.root, 'socs')
      if (existsSync(at)) for (const soc of readdirSync(at).sort()) if (existsSync(join(at, soc, 'soc.yaml'))) socs.push({ soc, layer: layer.name })
    }
    const hosts: Record<string, HostSync> = {}
    for (const lab of labs) { const record = this.hostSync(lab); if (record) hosts[lab] = record }
    return {
      source: this.source, url: this.url, branch: this.branch, ready: this.ready, revision: await this.revision(), commit: await this.head(), ahead: await this.ahead(),
      docs: docs ? KINDS.flatMap(kind => [...docs[kind].values()].map(doc => ({ kind, id: doc.id, file: doc.rel, layer: doc.layer, text: doc.text, fields: fields(doc) }))) : [],
      skills: this.skills(),
      socs, problems: this.ready ? [...problems, ...validate(docs!)] : [`站点还没从 ${this.url} 取下来：点拉取`],
      hosts, syncing: this.syncing, images: this.lastImages(),
    }
  }

  hostSync(lab: string): HostSync | null {
    try { return JSON.parse(this.settings.get(`host.${lab}`) ?? 'null') as HostSync | null } catch { return null }
  }
  recordHost(lab: string, record: HostSync | null) { this.settings.set(`host.${lab}`, record ? JSON.stringify(record) : null) }

  /**
   * Write one document of the site's own (`original`: the id it had, when editing), refused when the catalog would
   * then not load (problems already there before the change do not count), and committed.
   */
  private write(holder: string, kind: Kind, id: string, original: string | undefined, make: (old: Loaded | null) => string, message: string): Promise<SiteDoc> {
    return this.serial(async () => {
      await this.ensure(holder)
      if (!ID.test(id)) throw new BoardError('invalid', `不合法的名字：${id}（字母、数字、. _ -）`)
      const { docs } = this.load()
      const before = new Set(validate(docs))
      const old = original ? docs[kind].get(original) : undefined
      if (original && (!old || old.layer !== 'site')) throw new BoardError('not-found', `站点里没有 ${original}`)
      const taken = docs[kind].get(id)
      if (taken?.layer === 'site' && taken !== old) throw new BoardError('conflict', `已经有 ${id} 了`)
      const text = make(old ?? null)
      const parsed = parseDocument(text)
      if (parsed.errors.length) throw new BoardError('invalid', `YAML 写错了：${parsed.errors[0]!.message.split('\n')[0]}`)
      const data = parsed.toJS() as unknown
      if (!isData(data) || String(data.id) !== id) throw new BoardError('invalid', `要是一个映射，id 是 ${id}`)
      const file = old && original === id ? old.file : join(this.dir, 'sdk', kind, `${id}.yaml`)
      // Another document's file by that name (its id need not be its file's name): not written over.
      if (file !== old?.file && existsSync(file)) {
        const there = [...docs[kind].values()].find(doc => doc.file === file)
        throw new BoardError('conflict', `已经有 ${relative(this.dir, file)} 了${there ? `（里面是 ${there.id}）` : ''}：换个名字，或者改那个文件`)
      }
      if (old && original !== id) docs[kind].delete(old.id)
      const doc: Loaded = { kind, id, file, rel: relative(this.dir, file), text, data, layer: 'site' }
      docs[kind].set(id, doc)
      const broken = validate(docs).filter(problem => !before.has(problem))
      if (broken.length) throw new BoardError('invalid', `这样改，主机就读不进 SDK 目录了：${broken.join('；')}`)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`)
      if (old && old.file !== file) unlinkSync(old.file)
      await this.commit(holder, message)
      return { kind, id, file: doc.rel, layer: 'site', text, fields: fields(doc) }
    })
  }

  /** Edit `old`'s YAML keeping its comments, or start a new document in `order`. */
  private edited(old: Loaded | null, values: Array<[string, unknown]>): string {
    const doc = old ? parseDocument(old.text) : new Document({})
    if (!isMap(doc.contents)) throw new BoardError('invalid', '原来的文件不是映射，用 YAML 改它')
    for (const [key, value] of values) {
      if (value === undefined || value === '') doc.delete(key)
      else if (value instanceof Document) doc.set(key, value.contents)
      else doc.set(key, value)
    }
    return doc.toString()
  }

  /** Add or edit an SDK instance: where its tree is, its SoC, and (as YAML) its boot methods. */
  async putSdk(holder: string, input: SdkInput): Promise<SiteDoc> {
    const id = String(input.id ?? '').trim(), clean = (value?: string) => String(value ?? '').trim()
    let boot: Document | undefined
    if (clean(input.boot)) {
      boot = parseDocument(input.boot!)
      if (boot.errors.length) throw new BoardError('invalid', `boot 的 YAML 写错了：${boot.errors[0]!.message.split('\n')[0]}`)
      if (!isMap(boot.contents)) throw new BoardError('invalid', 'boot 要是映射：load: …、download: …')
    }
    if (!clean(input.family)) throw new BoardError('invalid', '要选编译方式（family）')
    const workspace = clean(input.workspace)
    if (!workspace && (!clean(input.server) || !clean(input.path))) throw new BoardError('invalid', '要给编译服务器和源码路径（或者一个源码树）')
    return this.write(holder, 'instances', id, clean(input.original) || undefined, old => this.edited(old, [
      ['id', id], ['family', clean(input.family)],
      ['server', workspace ? undefined : clean(input.server)], ['path', workspace ? undefined : clean(input.path)], ['workspace', workspace || undefined],
      ['soc', clean(input.soc)], ['description', clean(input.description)],
      ['boot', boot ?? (old ? (parseDocument(old.text).get('boot', true) === undefined ? TODO_BOOT : null) : TODO_BOOT)],
    ].filter(([, value]) => value !== null) as Array<[string, unknown]>), `${clean(input.original) ? 'Edit' : 'Add'} SDK ${id}`)
  }

  /** Add or edit a build server: how bsp reaches it (`user@host`). */
  async putServer(holder: string, input: ServerInput): Promise<SiteDoc> {
    const id = String(input.id ?? '').trim(), clean = (value?: string) => String(value ?? '').trim()
    if (!clean(input.host) || !clean(input.user)) throw new BoardError('invalid', '编译服务器要有地址（host）和用户（user）')
    return this.write(holder, 'servers', id, clean(input.original) || undefined, old => this.edited(old, [
      ['id', id], ['host', clean(input.host)], ['user', clean(input.user)], ['description', clean(input.description)],
    ]), `${clean(input.original) ? 'Edit' : 'Add'} build server ${id}`)
  }

  /** Any catalog document as YAML text (families and workspaces have no form of their own). */
  async putDoc(holder: string, kind: string, id: string, text: string, original?: string): Promise<SiteDoc> {
    if (!(KINDS as readonly string[]).includes(kind)) throw new BoardError('invalid', `没有这种文档：${kind}（${KINDS.join('、')}）`)
    if (!String(text ?? '').trim()) throw new BoardError('invalid', '要给 YAML')
    return this.write(holder, kind as Kind, String(id ?? '').trim(), original || undefined, () => text, `${original ? 'Edit' : 'Add'} ${kind.replace(/s$/, '')} ${id}`)
  }

  /**
   * Take a document out; refused while others use it, unless one under it (a pack's with that id) takes its place,
   * and when the catalog would not load without it.
   */
  remove(holder: string, kind: string, id: string): Promise<string> {
    return this.serial(async () => {
      await this.ensure(holder)
      if (!(KINDS as readonly string[]).includes(kind)) throw new BoardError('invalid', `没有这种文档：${kind}`)
      const { docs } = this.load()
      const doc = docs[kind as Kind].get(id)
      if (!doc || doc.layer !== 'site') throw new BoardError('not-found', `站点里没有 ${id}`)
      const { docs: without } = this.load(doc.file)
      const under = without[kind as Kind].get(id)
      const ref = kind === 'servers' ? 'server' : kind === 'workspaces' ? 'workspace' : kind === 'families' ? 'family' : null
      const users = ref && !under ? [...docs.instances.values(), ...(ref === 'server' ? docs.workspaces.values() : [])].filter(other => other.data[ref] === id).map(other => other.id) : []
      if (users.length) throw new BoardError('conflict', `${id} 还在用：${users.join('、')}`)
      const before = new Set(validate(docs))
      const broken = validate(without).filter(problem => !before.has(problem))
      if (broken.length) throw new BoardError('invalid', `删了它，主机就读不进 SDK 目录了：${broken.join('；')}`)
      unlinkSync(doc.file)
      await this.commit(holder, `Remove ${kind.replace(/s$/, '')} ${id}`)
      return `删掉了 ${id}${under ? `：用回 ${under.rel} 里的` : ''}`
    })
  }

  /**
   * The images something stages besides discovery, as `<soc>/<image>` (`any/<image>` for an SDK with no SoC): an SDK's
   * boot steps (`image:` of its SoC) and a SoC profile's media boot steps, in any layer.
   */
  private usedImages(): Set<string> {
    const used = new Set<string>()
    const steps = (value: unknown): Data[] => Array.isArray(value) ? value.filter(isData) : []
    for (const doc of this.load().docs.instances.values()) {
      const boot = isData(doc.data.boot) ? doc.data.boot : {}
      for (const method of Object.values(boot)) for (const step of steps(isData(method) ? method.steps : null))
        if (typeof step.image === 'string') used.add(`${typeof doc.data.soc === 'string' ? doc.data.soc : 'any'}/${step.image}`)
    }
    for (const layer of this.layers()) {
      const at = join(layer.root, 'socs')
      if (!existsSync(at)) continue
      for (const soc of readdirSync(at)) {
        let profile: unknown = null
        try { profile = parse(readFileSync(join(at, soc, 'soc.yaml'), 'utf8')) } catch { continue }
        const media = isData(profile) && isData(profile.media_boot) ? profile.media_boot : {}
        for (const step of steps(media.steps)) if (typeof step.image === 'string') used.add(`${soc}/${step.image}`)
      }
    }
    return used
  }

  lastImages(): ImagesState | null {
    try { return JSON.parse(this.settings.get('images') ?? 'null') as ImagesState | null } catch { return null }
  }

  /**
   * Fetch the images the SoC profiles list into the copy's `.blobs/` with the bsp CLI (each way into git over ssh in
   * turn while some fail), and say what is still not there. Never throws: what went wrong is in the result, and kept.
   */
  private async fetchImages(say: (line: string) => void = () => {}): Promise<ImagesState | null> {
    const bin = this.options.bin
    if (!bin || !this.ready) return null
    // This copy is the CLI's site; no user file of the CLI's, so no registry layer the hosts would not have.
    const env = { BSP_SITE: this.dir, BSP_CONFIG: join(dirname(this.dir), 'no-remotes.json') }
    const answer = (run: Run): { ok?: boolean, result?: unknown, error?: { message?: string } } | null => { try { return JSON.parse(run.stdout) } catch { return null } }
    const ways = this.options.sshCommands ? await this.options.sshCommands() : []
    const fetched = new Set<string>()
    let got: { present: string[], failed: ImagesState['failed'] } | null = null, error = ''
    for (const ssh of ways.length ? ways : [null]) {
      const run = await exec(bin, ['--json', 'images', 'sync'], this.dir, { ...env, ...(ssh ? { GIT_SSH_COMMAND: ssh } : {}) })
      const out = answer(run)
      if (!out?.ok || !isData(out.result)) { error = out?.error?.message ?? last(run); break }
      const result = out.result as { fetched?: string[], present?: string[], failed?: ImagesState['failed'] }
      for (const name of result.fetched ?? []) { if (!fetched.has(name)) say(`取到了镜像 ${name}`); fetched.add(name) }
      got = { present: (result.present ?? []).filter(name => !fetched.has(name)), failed: result.failed ?? [] }
      if (!got.failed.length) break
    }
    // Images nobody can fetch: missing when a boot step stages them, optional when only discovery does.
    const missing: string[] = [], optional: string[] = []
    if (got) {
      const listed = answer(await exec(bin, ['--json', 'images', 'list'], this.dir, env))
      const used = this.usedImages()
      if (listed?.ok && Array.isArray(listed.result)) for (const row of (listed.result as Data[]).filter(row => row.state === 'missing')) {
        const name = `${str(row.soc)}/${str(row.image)}（${str(row.file)}）`
        if (used.has(`${str(row.soc)}/${str(row.image)}`) || used.has(`any/${str(row.image)}`)) missing.push(name)
        else optional.push(name)
      }
    }
    const failed = got?.failed ?? [], have = fetched.size + (got?.present.length ?? 0)
    for (const item of failed) say(`镜像 ${item.image} 没取到：${item.error}`)
    for (const name of missing) say(`镜像 ${name} 有启动步骤要用，却哪儿都没有，也没写从哪取`)
    const message = !got ? `没取成镜像：${error}`
      : !have && !failed.length && !missing.length ? '没有要取的镜像'
      : [`镜像 ${have} 个在${fetched.size ? `（新取到 ${fetched.size} 个）` : ''}`, failed.length ? `${failed.length} 个没取到` : '', missing.length ? `${missing.length} 个缺` : ''].filter(Boolean).join('，')
    const state: ImagesState = { at: new Date().toISOString(), ok: !!got && !failed.length && !missing.length, message, fetched: [...fetched], present: got?.present ?? [], failed, missing, optional }
    this.settings.set('images', JSON.stringify(state))
    return state
  }

  /** Fetch the images, then bundle what the hosts get, as one step: the revision bundled, and how the images are. */
  ship(out: string, say: (line: string) => void = () => {}): Promise<{ revision: string, images: ImagesState | null }> {
    return this.serial(async () => {
      const images = await this.fetchImages(say)
      if (images) say(images.message)
      await this.bundle(out)
      return { revision: (await this.revision()) ?? '?', images }
    })
  }

  /** Whether there is something to ship that hosts can load. */
  shippable(): boolean { return this.ready && SHIPPED.some(name => existsSync(join(this.dir, name))) && !this.problems().length }

  /**
   * The parts the hosts get, as a gzipped tar (no .git; not what the site's .bspignore names). Only those: whatever else
   * the site's repository holds (hosts/, docs, notes, deploy scripts) stays here. A site with none of them is an empty
   * bundle, and a host synced with it has an empty site.
   */
  async bundle(out: string): Promise<void> {
    if (!this.ready) throw new BoardError('invalid', '站点还没有：先选来源')
    const present = SHIPPED.filter(name => existsSync(join(this.dir, name)))
    const ignore = join(this.dir, '.bspignore')
    const made = await exec('tar', ['-czf', out, '--exclude=.git', ...(existsSync(ignore) ? ['-X', ignore] : []), ...(present.length ? present : ['-T', '/dev/null'])], this.dir)
    if (made.code !== 0) throw new Error(`打包站点失败：${last(made)}`)
  }
}
