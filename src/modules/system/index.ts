/**
 * The `system` module: this boardlab's version, whether a newer release is out, and installing it. An installed
 * boardlab (scripts/install.sh) remembers where its release came from; boardd asks there for `release.json` at most
 * every few hours (or when asked to), and an update runs the installer, which swaps the program in once no board is
 * locked and restarts boardd. The page reloads itself when it sees a new version.
 */
import { execFile, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { BoardError } from 'boardlab-core/core/errors.ts'
import type { Module } from 'boardlab-core/core/module.ts'

export interface Version { version: string, revision: string, source: string | null, latest: { version: string, revision: string } | null, checkedAt: string | null, error: string | null, updating: boolean, newer: boolean }

/** `root`: the installed program (…/releases/<v>, `current` links it), found from the CLI's own place. */
export function system(options: { root: string | null, ttlMs?: number, fetch?: (url: string) => Promise<string> }): Module {
  const ttl = options.ttlMs ?? 6 * 3600_000
  const read = (file: string) => { try { return readFileSync(file, 'utf8').trim() } catch { return null } }
  const root = options.root
  // releases/<v>/ in an installed boardlab: its prefix holds release-source and install.sh.
  const prefix = root && existsSync(join(dirname(dirname(root)), 'release-source')) ? dirname(dirname(root)) : null
  const get = options.fetch ?? (async (url: string) => {
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
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`${url}：${response.status}`)
    return response.text()
  })
  return {
    id: 'system',
    title: '系统',
    setup(lab) {
      const version = (root && read(join(root, 'VERSION'))) ?? 'dev'
      const revision = (root && read(join(root, 'REVISION'))) ?? 'dev'
      const source = prefix ? read(join(prefix, 'release-source')) : null
      let latest: Version['latest'] = null, checkedAt: string | null = null, error: string | null = null, updating = false
      const state = (): Version => ({ version, revision, source, latest, checkedAt, error, updating, newer: !!latest && latest.revision !== revision })
      const check = async (force: boolean) => {
        if (!source) return state()
        if (!force && checkedAt && lab.kernel.now() - Date.parse(checkedAt) < ttl) return state()
        try {
          const release = JSON.parse(await get(/^(git\+)?(git@|ssh:\/\/)|\.git(#|$)/.test(source) ? source : `${source.replace(/\/$/, '')}/release.json`)) as { version: string, revision: string }
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
        {
          method: 'POST', path: '/api/system/update', about: '升级到新版：等没人拿锁时换上并重启 boardd（force=true 不等）', handle: async ({ body, caller }) => {
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
            return { message: `开始升级到 ${now.latest?.version}（${now.latest?.revision}）：没人拿锁时换上并重启 boardd，页面会自己刷新` }
          },
        },
      ])
      return {}
    },
  }
}
