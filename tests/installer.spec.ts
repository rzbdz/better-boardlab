/**
 * scripts/install.sh, run for real as a CLI-only install into a temporary home: from a git server's project API with a
 * token (sent only there, kept for updates), and refusing a tarball whose sha256 does not match release.json; and the
 * service install's boardd.json step on its own.
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

/** A release tarball holding a CLI that prints its version. */
function release(version: string) {
  const stage = join(dir, 'stage', `boardlab-${version}`)
  mkdirSync(join(stage, 'dist'), { recursive: true })
  writeFileSync(join(stage, 'dist/cli.js'), `console.log('cli ${version}', process.argv.slice(2).join(' '))\n`)
  writeFileSync(join(stage, 'VERSION'), `${version}\n`); writeFileSync(join(stage, 'REVISION'), 'abc1234\n')
  writeFileSync(join(stage, 'install.sh'), readFileSync(installer))
  const file = join(dir, `boardlab-${version}.tar.gz`)
  return new Promise<{ file: string, json: string }>((resolve, reject) => execFile('tar', ['-czf', file, '-C', join(dir, 'stage'), `boardlab-${version}`], error => {
    if (error) return reject(error)
    const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex')
    resolve({ file, json: JSON.stringify({ version, revision: 'abc1234', file: `boardlab-${version}.tar.gz`, sha256 }) })
  }))
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
    const step = /^OFFER=.*\n^offer_modules\(\) \{\n[\s\S]*?^\}\n/m.exec(readFileSync(installer, 'utf8'))![0]
    const state = join(dir, 'state'), config = join(state, 'boardd.json')
    mkdirSync(state, { recursive: true })
    const offer = (offered: string) => execFileSync('sh', ['-c', `say() { echo "==> $*"; }\n${step}\nOFFERED="${offered}"; offer_modules; echo "OFFERED=$OFFERED"`],
      { env: { ...process.env, STATE: state, NODE: process.execPath, FLAGS: '' }, encoding: 'utf8' }).trim()
    // First install: the default config, everything offered.
    expect(offer('')).toBe('OFFERED=system clients')
    expect(Object.keys(JSON.parse(readFileSync(config, 'utf8')).modules)).toEqual(['bsp', 'system', 'clients', 'terminal'])
    // An update from a release that had none of them, to a config with no modules at all.
    writeFileSync(config, '{ "modules": {}, "port": 1 }\n'); chmodSync(config, 0o600)
    expect(offer('')).toBe('OFFERED=system clients')
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({ modules: { system: {}, clients: {} }, port: 1 })
    expect(statSync(config).mode & 0o777).toBe(0o600)
    // Taken out afterwards: stays out.
    writeFileSync(config, '{ "modules": { "bsp": { "x": 1 } } }\n')
    expect(offer('system clients')).toBe('OFFERED=system clients')
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({ modules: { bsp: { x: 1 } } })
    // Offered before one of them existed: only the new one is added.
    expect(offer('system')).toBe('OFFERED=system clients')
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({ modules: { bsp: { x: 1 }, clients: {} } })
    // A config it cannot read is left alone, and offered again next time.
    writeFileSync(config, '{ modules: oops')
    expect(offer('')).toMatch(/could not add the system module[\s\S]*OFFERED=$/)
    expect(readFileSync(config, 'utf8')).toBe('{ modules: oops')
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
