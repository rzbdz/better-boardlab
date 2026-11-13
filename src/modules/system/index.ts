/**
 * The `system` module: this boardlab's version, whether a newer release is out, and installing it. An installed
 * boardlab (scripts/install.sh) remembers where its release came from; boardd asks there for `release.json` at most
 * every few hours (or when asked to), and an update runs the installer, which hands over to the new release without
 * stopping boardd (see server/supervisor.ts). The page reloads itself when it sees a new version.
 */
import { execFile, spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { BoardError } from 'boardlab-core/core/errors.ts'
import type { Module } from 'boardlab-core/core/module.ts'

/**
 * Where releases come from, as install.sh takes it: a directory over http(s), a git repository and its branch
 * (`git@host:group/repo.git#release`, `ssh://host/group/repo.git#release`, `https://host/group/repo.git#release`) or a
 * git server's project API (`https://host/api/v4/projects/<id>#release`). Nothing else, so no shell ever sees more.
 */
export const sourcePattern = /^(https?:\/\/[\w.:@-]+(\/[\w.~%+-]*)*|git@[\w.-]+:[\w.~\/-]+\.git|ssh:\/\/[\w.@:-]+(\/[\w.~-]+)+\.git)(#[\w.\/-]+)?$/

/** Whether `latest` is newer than `mine`: a later version, or the same one with another revision. */
export function newerRelease(latest: { version: string, revision: string }, mine: { version: string, revision: string }): boolean {
  const order = compareVersions(latest.version, mine.version)
  return order > 0 || (order === 0 && latest.revision !== mine.revision)
}

/**
 * `0.4.0rc2` against `0.3.29`: the numbers decide, and a pre-release (`rc1`, `rc2`, `beta`) comes before the final
 * release of the same version. A version that cannot be read compares as text, so nothing is offered as newer by
 * accident.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-.]?([0-9A-Za-z.-]+))?$/.exec(value.trim())
    return match ? { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? '' } : null
  }
  const left = parse(a), right = parse(b)
  if (!left || !right) return a === b ? 0 : a < b ? -1 : 1
  for (let i = 0; i < 3; i++) if (left.parts[i] !== right.parts[i]) return left.parts[i]! - right.parts[i]!
  if (!left.pre !== !right.pre) return left.pre ? -1 : 1
  if (left.pre === right.pre) return 0
  const rc = (value: string) => /^rc(\d+)$/i.exec(value)
  const l = rc(left.pre), r = rc(right.pre)
  if (l && r) return Number(l[1]) - Number(r[1])
  return left.pre < right.pre ? -1 : 1
}

/** A token shown without giving it away. */
const mask = (token: string) => token.length > 8 ? `••••${token.slice(-4)}` : '••••'

export interface Version { version: string, revision: string, source: string | null, latest: { version: string, revision: string } | null, checkedAt: string | null, error: string | null, updating: boolean, newer: boolean }

/** `root`: the installed program (…/releases/<v>, `current` links it), found from the CLI's own place. */
export function system(options: { root: string | null, ttlMs?: number, fetch?: (url: string, headers?: Record<string, string>) => Promise<string> }): Module {
  const ttl = options.ttlMs ?? 6 * 3600_000
  const read = (file: string) => { try { return readFileSync(file, 'utf8').trim() } catch { return null } }
  const root = options.root
  // releases/<v>/ in an installed boardlab: its prefix holds release-source and install.sh.
  const prefix = root && existsSync(join(dirname(dirname(root)), 'release-source')) ? dirname(dirname(root)) : null
  const token = () => prefix ? read(join(prefix, 'release-token')) : null
  const get = options.fetch ?? (async (url: string, headers: Record<string, string> = {}) => {
    // A git source (`git@host:group/repo.git#release`): its release branch, fetched shallow.
    const git = /^(git\+)?(git@|ssh:\/\/|.*\.git(#|\/release\.json$))/.test(url)
    if (git) {
      const repo = url.replace(/\/release\.json$/, '').replace(/^git\+/, '').split('#')[0]!, branch = url.replace(/\/release\.json$/, '').split('#')[1] ?? 'release'
      const dir = mkdtempSync(join(tmpdir(), 'boardlab-release-'))
      try {
        await new Promise<void>((resolve, reject) => execFile('git', ['clone', '-q', '--depth', '1', '-b', branch, '--filter=blob:none', '--no-checkout', repo, dir], { timeout: 60_000 }, error => error ? reject(new Error(`${repo}：${error.message}`)) : resolve()))
        return await new Promise<string>((resolve, reject) => execFile('git', ['-C', dir, 'show', `HEAD:release.json`], { timeout: 30_000 }, (error, stdout) => error ? reject(error) : resolve(stdout)))
      } finally { rmSync(dir, { recursive: true, force: true }) }
    }
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`${url}：${response.status}`)
    return response.text()
  })
  return {
    id: 'system',
    title: '系统',
    setup(lab) {
      const version = (root && read(join(root, 'VERSION'))) ?? 'dev'
      const revision = (root && read(join(root, 'REVISION'))) ?? 'dev'
      let source = prefix ? read(join(prefix, 'release-source')) : null
      let latest: Version['latest'] = null, checkedAt: string | null = null, error: string | null = null, updating = false
      const state = (): Version => ({ version, revision, source, latest, checkedAt, error, updating, newer: !!latest && newerRelease(latest, { version, revision }) })
      // release.json of a source, with the token a private project API takes.
      const fetchRelease = async (from: string, tok: string | null) => JSON.parse(await (/\/api\/v4\/projects\//.test(from)
        ? get(`${from.split('#')[0]}/repository/files/release.json/raw?ref=${encodeURIComponent(from.split('#')[1] ?? 'release')}`, tok ? { 'PRIVATE-TOKEN': tok } : {})
        : get(/^(git\+)?(git@|ssh:\/\/)|\.git(#|$)/.test(from) ? from : `${from.replace(/\/$/, '')}/release.json`))) as { version: string, revision: string }
      const check = async (force: boolean) => {
        if (!source) return state()
        if (!force && checkedAt && lab.kernel.now() - Date.parse(checkedAt) < ttl) return state()
        try {
          const release = await fetchRelease(source, token())
          latest = { version: release.version, revision: release.revision }; error = null
        } catch (failure) { error = (failure as Error).message }
        checkedAt = lab.kernel.iso()
        lab.kernel.changed(null)
        return state()
      }
      // Checked a little after start, then every few hours.
      setTimeout(() => void check(false), 20_000).unref()
      setInterval(() => void check(false), ttl).unref()
      lab.api.add('system', [
        { method: 'GET', path: '/api/system/version', about: '这个 boardlab 的版本、有没有新版（缓存几个小时；check=1 现在就问）', handle: ({ query }) => check(query.get('check') === '1') },
        { method: 'GET', path: '/api/system/source', about: '新版从哪里来（令牌只显示末尾几位）', handle: () => { const tok = token(); return { source, token: tok ? mask(tok) : null } } },
        {
          method: 'POST', path: '/api/system/source', about: '换新版的来源：source（https 目录、git 仓库#分支或项目 API#分支）、token（私有项目；空则删掉）；check=true 只看那里的版本不保存', handle: async ({ body }) => {
            if (!prefix) throw new BoardError('invalid', '这个 boardlab 不是用 install.sh 装的（比如从源码跑的）：没有来源可换')
            const from = typeof body.source === 'string' ? body.source.trim() : ''
            if (!sourcePattern.test(from)) throw new BoardError('invalid', `来源不认识：${from || '（空）'}。要 https 目录、git@host:组/仓库.git#分支、ssh://…#分支、https://….git#分支 或 https://host/api/v4/projects/<id>#分支`)
            const given = typeof body.token === 'string' ? body.token.trim() : undefined
            if (given && !/^[\x21-\x7e]+$/.test(given)) throw new BoardError('invalid', '令牌里不能有空白或特殊字符')
            let release: { version: string, revision: string }
            try { release = await fetchRelease(from, given === undefined ? token() : given || null) } catch (failure) { throw new BoardError('invalid', `那里拿不到 release.json：${(failure as Error).message}`) }
            if (body.check === true) return { source: from, version: release.version, revision: release.revision, message: `${from} 上是 ${release.version}（${release.revision}）` }
            writeFileSync(join(prefix, 'release-source'), `${from}\n`, { mode: 0o600 }); chmodSync(join(prefix, 'release-source'), 0o600)
            if (given) { writeFileSync(join(prefix, 'release-token'), `${given}\n`, { mode: 0o600 }); chmodSync(join(prefix, 'release-token'), 0o600) }
            else if (given === '') rmSync(join(prefix, 'release-token'), { force: true })
            source = from
            latest = { version: release.version, revision: release.revision }; error = null; checkedAt = lab.kernel.iso()
            lab.kernel.changed(null)
            return { source: from, version: release.version, revision: release.revision, message: `来源换成 ${from}，那里是 ${release.version}（${release.revision}）` }
          },
        },
        {
          method: 'POST', path: '/api/system/update', about: '升级到新版：新版本接手新连接，旧版本把手上的串口和任务跑完（不停机；force=true 不等没人用的板子）', handle: async ({ body, caller }) => {
            if (!prefix || !source) throw new BoardError('invalid', '这个 boardlab 不是用 install.sh 装的（比如从源码跑的）：在源码里 git pull 再 build')
            if (updating) throw new BoardError('conflict', '已经在升级')
            const now = await check(true)
            if (!now.newer && body.force !== true) return { message: `已经是最新：${version}（${revision}）` }
            updating = true
            lab.kernel.record(caller.holder, null, 'update', `${version} → ${now.latest?.version ?? '?'}`, true, null)
            // Run apart from boardd (it restarts boardd): a transient unit when systemd is there, else detached.
            // A copy of the installer runs, so the update can replace the installed one under it.
            const script = join(tmpdir(), `boardlab-install-${Date.now()}.sh`)
            copyFileSync(join(prefix, 'install.sh'), script)
            const args = ['sh', script, '--from', source, ...(body.force === true ? ['--force'] : [])]
            const child = existsSync('/run/systemd/system')
              ? spawn('systemd-run', ['--unit', `boardlab-update-${Date.now()}`, '--collect', ...args], { stdio: 'ignore', detached: true })
              : spawn(args[0]!, args.slice(1), { stdio: 'ignore', detached: true })
            child.on('error', () => { updating = false })
            child.unref()
            return { message: `开始升级到 ${now.latest?.version}（${now.latest?.revision}）：新版接手新连接，正在用的板子跑完为止，页面会自己刷新` }
          },
        },
      ])
      return {}
    },
  }
}
