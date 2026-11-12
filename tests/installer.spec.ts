/**
 * scripts/install.sh (the bootstrap) and setup.sh (a release's installer), run for real as a CLI-only install into a
 * temporary home: from a git server's project API with a token (sent only there, kept for updates), a release directory
 * and a git branch; an install made by the installer from before setup.sh updated; refusing a tarball whose sha256 does
 * not match release.json; and the service install's boardd.json step on its own.
 */
import { describe, expect, it } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { dir, useTempDir } from './fakes.ts'

useTempDir()

const installer = join(import.meta.dirname, '../scripts/install.sh')
const setup = join(import.meta.dirname, '../scripts/setup.sh')

/** A release tarball holding a CLI that prints its version, with both the bootstrap install.sh and its setup.sh. */
function release(version: string, revision = 'abc1234') {
  const stage = join(dir, 'stage', `boardlab-${version}`)
  mkdirSync(join(stage, 'dist'), { recursive: true })
  writeFileSync(join(stage, 'dist/cli.js'), `console.log('cli ${version}', process.argv.slice(2).join(' '))\n`)
  writeFileSync(join(stage, 'VERSION'), `${version}\n`); writeFileSync(join(stage, 'REVISION'), `${revision}\n`)
  writeFileSync(join(stage, 'install.sh'), readFileSync(installer))
  writeFileSync(join(stage, 'setup.sh'), readFileSync(setup))
  const file = join(dir, `boardlab-${version}.tar.gz`)
  return new Promise<{ file: string, json: string }>((resolve, reject) => execFile('tar', ['-czf', file, '-C', join(dir, 'stage'), `boardlab-${version}`], error => {
    if (error) return reject(error)
    const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex')
    resolve({ file, json: JSON.stringify({ version, revision, file: `boardlab-${version}.tar.gz`, sha256 }) })
  }))
}

/** A release directory source: release.json and the tarball it names, in their own directory. */
async function releaseDir(version: string, revision = 'abc1234') {
  const { file, json } = await release(version, revision)
  const srcDir = join(dir, `src-${version}`)
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'release.json'), json)
  writeFileSync(join(srcDir, `boardlab-${version}.tar.gz`), readFileSync(file))
  return srcDir
}

/** A project API serving a project's files from its release branch, to the right token only. */
async function projectApi(files: Record<string, Buffer | string>, token: string) {
  const asked: string[] = []
  const server = createServer((req, res) => {
    asked.push(`${req.url} token=${req.headers['private-token'] ?? ''}`)
    const match = /^\/api\/v4\/projects\/7\/repository\/files\/([^/]+)\/raw\?ref=release$/.exec(req.url ?? '')
    if (req.headers['private-token'] !== token) { res.statusCode = 404; return res.end('{"message":"404 Project Not Found"}') }
    const body = match ? files[decodeURIComponent(match[1]!)] : undefined
    if (body === undefined) { res.statusCode = 404; return res.end() }
    res.end(body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v4/projects/7#release`, asked, close: () => server.close() }
}

const run = (args: string[], env: Record<string, string> = {}) => new Promise<{ code: number, out: string }>(resolve =>
  execFile('sh', [installer, '--cli', '--node', process.execPath, ...args], { env: { ...process.env, HOME: join(dir, 'home'), ...env }, timeout: 60_000 },
    (error, stdout, stderr) => resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, out: stdout + stderr })))

describe('install.sh', () => {
  it('installs from a private project API with a token, and keeps the token for updates', async () => {
    const { file, json } = await release('0.9.0')
    const api = await projectApi({ 'release.json': json, 'boardlab-0.9.0.tar.gz': readFileSync(file) }, 'glpat-test')
    try {
      const denied = await run(['--from', api.url])
      expect(denied.code).not.toBe(0)
      expect(denied.out).toMatch(/without a token \(a private project needs --token\)/)
      const done = await run(['--from', api.url], { BOARDLAB_TOKEN: 'glpat-test' })
      expect(done.out).toContain('boardlab 0.9.0 CLI is in')
      const prefix = join(dir, 'home/.local/share/boardlab')
      expect(readFileSync(join(prefix, 'release-source'), 'utf8').trim()).toBe(api.url)
      expect(readFileSync(join(prefix, 'release-token'), 'utf8').trim()).toBe('glpat-test')
      expect(statSync(join(prefix, 'release-token')).mode & 0o077).toBe(0)
      await new Promise<void>(resolve => execFile(join(dir, 'home/.local/bin/boardlab'), ['version'], (_e, stdout) => { expect(stdout).toContain('cli 0.9.0 version'); resolve() }))
      // Again without the token given: the kept one is used, and it finds this version already there.
      expect((await run(['--from', api.url])).out).toContain('already installed')
      expect(api.asked.every(line => line.startsWith('/api/v4/projects/7/'))).toBe(true)
    } finally { api.close() }
  })

  it('adds a module a release brings to boardd.json once, keeping the rest of it, and not again once taken out', () => {
    // The service install's step, run on its own (a service install needs root and systemd).
    const step = /^OFFER=.*\n(?:#[^\n]*\n|\[[^\n]*\n|if [^\n]*\n)*offer_modules\(\) \{\n[\s\S]*?^\}\n/m.exec(readFileSync(setup, 'utf8'))![0]
    const state = join(dir, 'state'), config = join(state, 'boardd.json')
    mkdirSync(state, { recursive: true })
    const offer = (offered: string) => execFileSync('sh', ['-c', `say() { echo "==> $*"; }\n${step}\nOFFERED="${offered}"; offer_modules; echo "OFFERED=$OFFERED"`],
      { env: { ...process.env, STATE: state, NODE: process.execPath, FLAGS: '' }, encoding: 'utf8' }).trim()
    // First install: the default config, everything offered.
    expect(offer('')).toBe('OFFERED=system clients feedback')
    expect(Object.keys(JSON.parse(readFileSync(config, 'utf8')).modules)).toEqual(['bsp', 'system', 'clients', 'terminal', 'feedback'])
    // An update from a release that had none of them, to a config with no modules at all.
    writeFileSync(config, '{ "modules": {}, "port": 1 }\n'); chmodSync(config, 0o600)
    expect(offer('')).toBe('OFFERED=system clients feedback')
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({ modules: { system: {}, clients: {}, feedback: {} }, port: 1 })
    expect(statSync(config).mode & 0o777).toBe(0o600)
    // Taken out afterwards: stays out.
    writeFileSync(config, '{ "modules": { "bsp": { "x": 1 } } }\n')
    expect(offer('system clients feedback')).toBe('OFFERED=system clients feedback')
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({ modules: { bsp: { x: 1 } } })
    // Offered before one of them existed: only the new one is added.
    expect(offer('system')).toBe('OFFERED=system clients feedback')
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({ modules: { bsp: { x: 1 }, clients: {}, feedback: {} } })
    // A config it cannot read is left alone, and offered again next time.
    writeFileSync(config, '{ modules: oops')
    expect(offer('')).toMatch(/could not add the system module[\s\S]*OFFERED=$/)
    expect(readFileSync(config, 'utf8')).toBe('{ modules: oops')
  })

  it('installs from a release directory, keeps itself as the installed install.sh, and updates from there', async () => {
    const prefix = join(dir, 'home/.local/share/boardlab')
    const first = await run(['--from', await releaseDir('0.9.0')])
    expect(first.out).toContain('boardlab 0.9.0 CLI is in')
    expect(first.out).toContain('cli 0.9.0 install -g')                     // the skill, for the AI tools this user has set up
    expect(readFileSync(join(prefix, 'release-source'), 'utf8').trim()).toBe(join(dir, 'src-0.9.0'))
    expect(readFileSync(join(prefix, 'install.sh'), 'utf8')).toBe(readFileSync(installer, 'utf8'))
    expect(existsSync(join(prefix, 'release-token'))).toBe(false)
    // An update: the installed install.sh, given the next release, runs that release's setup.sh.
    const next = await releaseDir('0.9.2', 'def5678')
    const update = await new Promise<string>(resolve => execFile('sh', [join(prefix, 'install.sh'), '--cli', '--from', next], { env: { ...process.env, HOME: join(dir, 'home') } }, (_e, o, e) => resolve(o + e)))
    expect(update).toContain('boardlab 0.9.2 CLI is in')
    expect(readFileSync(join(prefix, 'current/VERSION'), 'utf8').trim()).toBe('0.9.2')
  })

  it('installs from a branch of a git repository', async () => {
    const { file, json } = await release('0.9.0')
    const work = join(dir, 'work'), bare = join(dir, 'releases.git')
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
    mkdirSync(work, { recursive: true })
    git(work, 'init', '-q', '-b', 'release')
    writeFileSync(join(work, 'release.json'), json); writeFileSync(join(work, 'boardlab-0.9.0.tar.gz'), readFileSync(file))
    git(work, 'add', '.'); git(work, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'release')
    git(dir, 'clone', '-q', '--bare', work, bare)
    const source = `${bare}#release`
    const done = await run(['--from', source])
    expect(done.out).toContain('boardlab 0.9.0 CLI is in')
    expect(readFileSync(join(dir, 'home/.local/share/boardlab/release-source'), 'utf8').trim()).toBe(source)
    expect((await run(['--from', `${bare}#nothere`])).out).toContain('could not fetch branch nothere')
  })

  it('updates an install made by an install.sh from before setup.sh, and from then on through the new one', async () => {
    // The whole installer as releases shipped it before setup.sh (kept in tests/fixtures): it installs a new release
    // with its own steps, and keeps the new release's install.sh (the bootstrap) for the next update.
    const old = join(import.meta.dirname, 'fixtures/install-before-setup.sh')
    const prefix = join(dir, 'home/.local/share/boardlab'), env = { ...process.env, HOME: join(dir, 'home') }
    const sh = (script: string, args: string[]) => new Promise<string>(resolve => execFile('sh', [script, '--cli', '--node', process.execPath, ...args], { env }, (_e, o, e) => resolve(o + e)))
    expect(await sh(old, ['--from', await releaseDir('0.9.0')])).toContain('installing boardlab 0.9.0')
    expect(readFileSync(join(prefix, 'install.sh'), 'utf8')).toBe(readFileSync(installer, 'utf8'))
    expect(await sh(join(prefix, 'install.sh'), ['--from', await releaseDir('0.9.2', 'def5678')])).toContain('boardlab 0.9.2 CLI is in')
    expect(readFileSync(join(prefix, 'current/VERSION'), 'utf8').trim()).toBe('0.9.2')
    // And back down to a release from before setup.sh: its own install.sh does it.
    const stage = join(dir, 'stage/boardlab-0.3.0')
    mkdirSync(join(stage, 'dist'), { recursive: true })
    writeFileSync(join(stage, 'dist/cli.js'), "console.log('cli 0.3.0')\n")
    writeFileSync(join(stage, 'VERSION'), '0.3.0\n'); writeFileSync(join(stage, 'REVISION'), '0ld0000\n'); writeFileSync(join(stage, 'install.sh'), readFileSync(old))
    const src = join(dir, 'src-0.3.0'); mkdirSync(src)
    execFileSync('tar', ['-czf', join(src, 'boardlab-0.3.0.tar.gz'), '-C', join(dir, 'stage'), 'boardlab-0.3.0'])
    const sha256 = createHash('sha256').update(readFileSync(join(src, 'boardlab-0.3.0.tar.gz'))).digest('hex')
    writeFileSync(join(src, 'release.json'), JSON.stringify({ version: '0.3.0', revision: '0ld0000', file: 'boardlab-0.3.0.tar.gz', sha256 }))
    expect(await sh(join(prefix, 'install.sh'), ['--from', src])).toContain('installing boardlab 0.3.0')
    expect(readFileSync(join(prefix, 'current/VERSION'), 'utf8').trim()).toBe('0.3.0')
  })

  it('refuses a tarball that does not match release.json', async () => {
    const { json } = await release('0.9.1')
    const api = await projectApi({ 'release.json': json, 'boardlab-0.9.1.tar.gz': 'not the tarball' }, 't')
    try {
      const done = await run(['--from', api.url, '--token', 't'])
      expect(done.code).not.toBe(0)
      expect(done.out).toContain('sha256 does not match')
      expect(existsSync(join(dir, 'home/.local/bin/boardlab'))).toBe(false)
    } finally { api.close() }
  })
})
