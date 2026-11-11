/**
 * The bsp site boardd keeps and ships: its source (here, or a git repository: a local bare one stands in for it),
 * SDK and build server edits that keep the file's comments and are refused when bsp would not load the catalog, its
 * images fetched by the bsp CLI (a fake one) into .blobs/ with what is missing said, and
 * syncing it to a board host (ssh, scp, sudo and systemctl faked over a directory standing in for the host, and a
 * fake bspd on a local port): the right files arrive, the host's hosts/ stays, and bspd is told to read it again.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { parse } from 'yaml'
import { openDatabase } from 'boardlab-core/core/db.ts'
import type { Settings } from 'boardlab-core/core/kernel.ts'
import { BoardLab } from 'boardlab-core/core/lab.ts'
import { Hosts } from '../src/modules/hosts/ssh.ts'
import { bsp } from '../src/modules/bsp/index.ts'
import { installHost, syncHost } from '../src/modules/bsp/provision.ts'
import { Site } from '../src/modules/bsp/site.ts'
import { dir, useTempDir } from './fakes.ts'

useTempDir()

const EXAMPLE = join(import.meta.dirname, '..', 'externals', 'bsp', 'examples', 'site')
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=tester', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8' }).trim()

function memory(): Settings & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return { values, get: key => values.get(key) ?? null, set: (key, value) => { if (value === null) values.delete(key); else values.set(key, value) }, flag: key => values.has(key) ? values.get(key) === '1' : null }
}

/** A bare repository holding the example site's SDK catalog and SoC profiles. */
function remoteSite() {
  const seed = join(dir, 'seed'), remote = join(dir, 'remote.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  mkdirSync(seed)
  cpSync(join(EXAMPLE, 'sdk'), join(seed, 'sdk'), { recursive: true })
  cpSync(join(EXAMPLE, 'socs'), join(seed, 'socs'), { recursive: true })
  git(dir, 'init', '-q', '-b', 'main', seed)
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'site'); git(seed, 'push', '-q', remote, 'main')
  return { remote, other: () => { const other = join(dir, 'other'); git(dir, 'clone', '-q', remote, other); return other } }
}

const SERVER = `# where vendor trees are built
id: build-a
host: build-a.example.test   # reached over ssh
user: dev
description: first build server
`

describe('the bsp site', () => {
  it('follows a git source: cloned, pulled under local commits, pushed; a conflict changes nothing', async () => {
    const { remote, other } = remoteSite()
    const settings = memory()
    const site = new Site(join(dir, 'state', 'bsp', 'site'), settings, { bin: fakeBsp().bin })
    await expect(site.setSource('user:alice', { source: 'git', url: join(dir, 'nowhere.git') })).rejects.toThrow(/取不到/)
    expect(settings.values.get('source')).toBeUndefined()                          // a source that fails is not kept
    // Fetched, then its images (here, the fake CLI's one way in gets none of them).
    expect(await site.setSource('user:alice', { source: 'git', url: remote, branch: 'main' })).toMatch(/^取下了.*；镜像 0 个在，2 个没取到，1 个缺$/)
    let status = await site.status()
    expect(status).toMatchObject({ source: 'git', url: remote, branch: 'main', ready: true, ahead: 0, problems: [] })
    expect(status.docs.filter(doc => doc.kind === 'instances').map(doc => doc.id)).toContain('bsp-a')
    expect(status.socs.map(item => item.soc)).toEqual(['soc-a', 'soc-b'])
    expect(status.revision).toBe(git(remote, 'rev-parse', '--short', 'main'))

    // Someone pushes to the source; an edit is made here; pulling puts the edit after theirs.
    const theirs = other()
    writeFileSync(join(theirs, 'sdk/servers/build-b.yaml'), 'id: build-b\nhost: 192.0.2.11\nuser: dev\ndescription: edited upstream\n')
    git(theirs, 'commit', '-qam', 'describe build-b'); git(theirs, 'push', '-q', 'origin', 'main')
    await site.putServer('user:alice', { id: 'build-c', host: 'build-c.example.test', user: 'dev' })
    expect((await site.status()).ahead).toBe(1)
    const pulled = await site.pull('user:alice')
    expect(pulled.revision).not.toBeNull()
    expect(pulled.message).toMatch(/；镜像/)
    expect(readFileSync(join(site.dir, 'sdk/servers/build-b.yaml'), 'utf8')).toContain('edited upstream')
    expect(existsSync(join(site.dir, 'sdk/servers/build-c.yaml'))).toBe(true)
    expect(await site.push()).toMatch(/推送到了/)
    expect(git(remote, 'log', '-1', '--format=%an|%s', 'main')).toBe('user:alice|Add build server build-c')
    status = await site.status()
    expect(status.ahead).toBe(0)

    // Both sides change one line: the pull is refused and the copy is as it was.
    git(theirs, 'pull', '-q')
    writeFileSync(join(theirs, 'sdk/servers/build-c.yaml'), 'id: build-c\nhost: build-c.example.test\nuser: theirs\n')
    git(theirs, 'commit', '-qam', 'theirs'); git(theirs, 'push', '-q', 'origin', 'main')
    await site.putServer('user:alice', { id: 'build-c', host: 'build-c.example.test', user: 'ours', original: 'build-c' })
    const before = await site.revision()
    await expect(site.pull('user:alice')).rejects.toThrow(/冲突/)
    expect(await site.revision()).toBe(before)
    expect(readFileSync(join(site.dir, 'sdk/servers/build-c.yaml'), 'utf8')).toContain('user: ours')
    await expect(site.push()).rejects.toThrow(/先拉取/)
  })

  it('never loses work of the copy\'s when its source is set again or changed, unless told to', async () => {
    const { remote } = remoteSite()
    const elsewhere = join(dir, 'elsewhere.git')
    execFileSync('git', ['clone', '-q', '--bare', remote, elsewhere])
    const settings = memory()
    const site = new Site(join(dir, 'state', 'bsp', 'site'), settings)
    // A copy left aside by an earlier version, with work in it: never deleted.
    mkdirSync(`${site.dir}.old`, { recursive: true }); writeFileSync(`${site.dir}.old/unpushed`, 'x')
    await site.setSource('user:alice', { source: 'git', url: remote })
    const server = join(site.dir, 'sdk/servers/build-c.yaml')
    await site.putServer('user:alice', { id: 'build-c', host: 'build-c.example.test', user: 'dev' })

    // The same source again: fetched in place, the commit made here kept on top.
    expect(await site.setSource('user:alice', { source: 'git', url: remote })).toMatch(/这里的提交排在它之后/)
    expect(existsSync(server)).toBe(true)
    expect((await site.status()).ahead).toBe(1)

    // Another source that lacks it: refused, nothing changed.
    const head = git(site.dir, 'rev-parse', 'HEAD')
    await expect(site.setSource('user:alice', { source: 'git', url: elsewhere })).rejects.toThrow(/有 .* 里没有的1 个提交：换过去就丢了/)
    expect(settings.values.get('url')).toBe(remote)
    expect(git(site.dir, 'remote', 'get-url', 'origin')).toBe(remote)
    expect(git(site.dir, 'rev-parse', 'HEAD')).toBe(head)
    // Pushed, it is no longer lost; a change not committed still is.
    await site.push()
    writeFileSync(join(site.dir, 'notes.txt'), 'draft\n')
    await expect(site.setSource('user:alice', { source: 'git', url: elsewhere })).rejects.toThrow(/没提交的改动/)
    expect(readFileSync(join(site.dir, 'notes.txt'), 'utf8')).toBe('draft\n')

    // Told to: switched, the copy's work kept in a local branch.
    const done = await site.setSource('user:alice', { source: 'git', url: elsewhere, discard: true })
    const kept = /本地分支 (discarded-\d+)/.exec(done)?.[1]
    expect(kept).toBeTruthy()
    expect(git(site.dir, 'show', `${kept}:notes.txt`)).toBe('draft')
    expect(existsSync(server)).toBe(false)
    expect(existsSync(join(site.dir, 'notes.txt'))).toBe(false)
    expect(git(site.dir, 'rev-parse', 'HEAD')).toBe(git(elsewhere, 'rev-parse', 'main'))
    expect(readFileSync(`${site.dir}.old/unpushed`, 'utf8')).toBe('x')

    // A branch the source does not have, though one ends in its name: the copy becomes it at the first push.
    git(dir, 'clone', '-q', elsewhere, join(dir, 'x')); git(join(dir, 'x'), 'push', '-q', 'origin', 'main:refs/heads/team/dev')
    expect(await site.setSource('user:alice', { source: 'git', url: elsewhere, branch: 'dev' })).toMatch(/还没有分支 dev/)
  })

  it('keeps a site edited here when a git source is chosen that lacks it, unless told to', async () => {
    const { remote } = remoteSite()
    const fresh = new Site(join(dir, 'fresh'), memory())
    await fresh.status()                                                            // started empty here: nothing to lose
    expect(await fresh.setSource('user:alice', { source: 'git', url: remote })).toMatch(/^取下了/)
    expect(existsSync(join(fresh.dir, 'sdk/servers'))).toBe(true)

    const site = new Site(join(dir, 'site'), memory())
    await site.putDoc('user:bob', 'servers', 'build-a', SERVER)
    await expect(site.setSource('user:bob', { source: 'git', url: remote })).rejects.toThrow(/1 个提交/)
    expect(site.source).toBe('managed')
    expect(readFileSync(join(site.dir, 'sdk/servers/build-a.yaml'), 'utf8')).toBe(SERVER)
    expect(await site.setSource('user:bob', { source: 'git', url: remote, discard: true })).toMatch(/本地分支 discarded-/)
    expect(site.source).toBe('git')
  })

  it('never writes over another document\'s file, and lets a pack\'s document take over from the site\'s', async () => {
    const tree = join(dir, 'tree')
    mkdirSync(join(tree, 'packs/base/sdk/servers'), { recursive: true })
    writeFileSync(join(tree, 'packs/base/sdk/servers/build-p.yaml'), 'id: build-p\nhost: build-p.example.test\nuser: dev\n')
    const site = new Site(join(dir, 'site'), memory(), { tree })
    await site.putDoc('user:bob', 'families', 'make-bsp', readFileSync(join(EXAMPLE, 'sdk/families/make-bsp.yaml'), 'utf8'))
    await site.putServer('user:bob', { id: 'build-a', host: 'build-a.example.test', user: 'dev' })
    // A file whose name is not its id.
    writeFileSync(join(site.dir, 'sdk/servers/build-b.yaml'), 'id: lab-b\nhost: build-b.example.test\nuser: dev\n')
    git(site.dir, 'add', '-A'); git(site.dir, 'commit', '-qm', 'lab-b')
    await expect(site.putServer('user:bob', { id: 'build-b', host: 'h.example.test', user: 'u' })).rejects.toThrow(/已经有 sdk\/servers\/build-b.yaml 了（里面是 lab-b）/)
    await expect(site.putServer('user:bob', { id: 'build-b', host: 'h.example.test', user: 'u', original: 'build-a' })).rejects.toThrow(/已经有 sdk\/servers\/build-b.yaml/)
    expect(readFileSync(join(site.dir, 'sdk/servers/build-b.yaml'), 'utf8')).toContain('id: lab-b')
    expect(existsSync(join(site.dir, 'sdk/servers/build-a.yaml'))).toBe(true)

    // The site's own build-p over the pack's, used by an SDK: taking it out leaves the pack's in its place.
    await site.putServer('user:bob', { id: 'build-p', host: 'build-p.lab.example.test', user: 'builder' })
    await site.putSdk('user:bob', { id: 'vendor-p', family: 'make-bsp', server: 'build-p', path: '/p' })
    await expect(site.remove('user:bob', 'servers', 'build-a')).resolves.toMatch(/删掉了 build-a/)
    expect(await site.remove('user:bob', 'servers', 'build-p')).toMatch(/删掉了 build-p.*packs\/base/)
    const status = await site.status()
    expect(status.docs.find(doc => doc.id === 'build-p')).toMatchObject({ layer: 'base', fields: { host: 'build-p.example.test' } })
    expect(status.problems).toEqual([])
    // With nothing under it, still refused while used.
    await expect(site.remove('user:bob', 'families', 'make-bsp')).rejects.toThrow(/还在用：vendor-p/)
  })

  it('tries the next way into the source only when one does not get in, and keeps what the source said', async () => {
    const { remote, other } = remoteSite()
    const bin = join(dir, 'ways'), log = join(dir, 'ways.log')
    mkdirSync(bin)
    // A way in that is refused, and one that gets in (it runs git's command here).
    const way = (name: string, works: boolean) => {
      writeFileSync(join(bin, name), works
        ? `#!/bin/sh\necho "${name}" >> ${log}\nfor a; do last=$a; done\nexec sh -c "$last"\n`
        : `#!/bin/sh\necho "${name}" >> ${log}\necho "${name}: Permission denied (publickey)." >&2\nexit 255\n`, { mode: 0o755 })
      return join(bin, name)
    }
    let ways = [way('refused', false), way('works', true), way('refused-too', false)]
    const site = new Site(join(dir, 'site'), memory(), { sshCommands: async () => ways })
    await site.setSource('user:alice', { source: 'git', url: `ssh://lab-git.example.test${remote}` })
    const theirs = other()
    writeFileSync(join(theirs, 'sdk/servers/build-b.yaml'), 'id: build-b\nhost: 192.0.2.11\nuser: dev\n')
    git(theirs, 'commit', '-qam', 'theirs'); git(theirs, 'push', '-q', 'origin', 'main')
    await site.putServer('user:alice', { id: 'build-c', host: 'build-c.example.test', user: 'dev' })
    writeFileSync(log, '')
    // The way that gets in is told the push is behind: that stands, the next way is not tried.
    await expect(site.push()).rejects.toThrow(/先拉取/)
    expect(readFileSync(log, 'utf8')).toMatch(/^(refused\n)+(works\n)+$/)   // git may call a way twice (to tell what ssh it is)
    // None gets in: each is tried.
    ways = [way('refused', false), way('refused-too', false)]
    writeFileSync(log, '')
    await expect(site.pull('user:alice')).rejects.toThrow(/拉取 .* 失败/)
    expect(readFileSync(log, 'utf8')).toMatch(/^(refused\n)+(refused-too\n)+$/)
  })

  it('adds, edits and removes SDKs and build servers as YAML bsp loads, keeping comments; refuses what would not load', async () => {
    const site = new Site(join(dir, 'site'), memory())
    expect((await site.status()).source).toBe('managed')                          // a site kept here starts empty
    await site.putDoc('user:bob', 'families', 'make-bsp', readFileSync(join(EXAMPLE, 'sdk/families/make-bsp.yaml'), 'utf8'))
    await site.putDoc('user:bob', 'servers', 'build-a', SERVER)
    const sdk = await site.putSdk('user:bob', { id: 'vendor-a', family: 'make-bsp', server: 'build-a', path: '/home/dev/vendor-a', soc: 'soc-a', description: 'vendor tree' })
    const file = join(site.dir, sdk.file)
    expect(parse(readFileSync(file, 'utf8'))).toEqual({
      id: 'vendor-a', family: 'make-bsp', server: 'build-a', path: '/home/dev/vendor-a', soc: 'soc-a', description: 'vendor tree',
      boot: { load: { status: 'todo', notes: 'boot steps not written yet', steps: [] }, download: { status: 'todo', notes: 'boot steps not written yet', steps: [] } },
    })
    // Edited: the boot steps replaced, the rest kept as it was written.
    writeFileSync(file, `# a vendor BSP\n${readFileSync(file, 'utf8')}`)
    git(site.dir, 'commit', '-qam', 'comment')
    const boot = 'load:\n  status: ready\n  steps:\n    - {do: enter-fdl}   # into download mode\n    - {do: stage, artifact: fsbl}\n    - {do: continue}\ndownload: {status: todo, steps: []}\n'
    await site.putSdk('user:bob', { id: 'vendor-a', family: 'make-bsp', server: 'build-a', path: '/home/dev/vendor-a', soc: 'soc-b', boot, original: 'vendor-a' })
    const edited = readFileSync(file, 'utf8')
    expect(edited).toContain('# a vendor BSP')
    expect(edited).toContain('# into download mode')
    expect(parse(edited)).toMatchObject({ soc: 'soc-b', boot: { load: { status: 'ready', steps: [{ do: 'enter-fdl' }, { do: 'stage', artifact: 'fsbl' }, { do: 'continue' }] } } })
    expect(parse(edited).description).toBeUndefined()                               // cleared on the form, gone from the file
    expect((await site.status()).docs.find(doc => doc.id === 'vendor-a')?.fields).toMatchObject({ load: 'ready', download: 'todo', soc: 'soc-b' })
    await site.putServer('user:bob', { id: 'build-a', host: 'build-a.example.test', user: 'builder', description: 'first build server', original: 'build-a' })
    const server = readFileSync(join(site.dir, 'sdk/servers/build-a.yaml'), 'utf8')
    expect(server).toContain('# where vendor trees are built')
    expect(server).toContain('# reached over ssh')
    expect(parse(server).user).toBe('builder')

    // What bsp would refuse to load is refused here, and nothing is written.
    const head = git(site.dir, 'rev-parse', 'HEAD')
    const refused = [
      site.putSdk('user:bob', { id: 'vendor-b', family: 'no-such-family', server: 'build-a', path: '/p' }),
      site.putSdk('user:bob', { id: 'vendor-b', family: 'make-bsp', server: 'nowhere', path: '/p' }),
      site.putSdk('user:bob', { id: 'vendor-b', family: 'make-bsp', server: 'build-a', path: '/p', boot: 'load: {status: ready, steps: []}\ndownload: {status: todo}\n' }),
      site.putSdk('user:bob', { id: 'vendor-b', family: 'make-bsp', server: 'build-a', path: '/p', boot: 'load: {status: ready, steps: [{do: stage, artifact: nope}]}\ndownload: {status: todo}\n' }),
      site.putSdk('user:bob', { id: 'vendor-b', family: 'make-bsp', server: 'build-a', path: '/p', boot: 'load: {status: ready, steps: [{do: dance}]}\ndownload: {status: todo}\n' }),
      site.putSdk('user:bob', { id: 'vendor-b', family: 'make-bsp', server: 'build-a', path: '/p', boot: 'load: {status: todo}\n' }),
      site.putSdk('user:bob', { id: 'bad id', family: 'make-bsp', server: 'build-a', path: '/p' }),
      site.putServer('user:bob', { id: 'build-b', host: '', user: 'dev' }),
      site.putDoc('user:bob', 'workspaces', 'tree', 'id: tree\nserver: nowhere\npath: /p\n'),
      site.putDoc('user:bob', 'servers', 'x', 'id: [broken'),
    ]
    const messages = await Promise.all(refused.map(done => done.then(() => 'written', (error: Error) => error.message)))
    expect(messages).toEqual([
      expect.stringMatching(/没有编译方式 no-such-family/), expect.stringMatching(/没有编译服务器 nowhere/), expect.stringMatching(/ready，却没有步骤/),
      expect.stringMatching(/没有的产物 nope/), expect.stringMatching(/不认识的步骤 dance/), expect.stringMatching(/缺 download/),
      expect.stringMatching(/不合法的名字/), expect.stringMatching(/host/), expect.stringMatching(/没有编译服务器 nowhere/), expect.stringMatching(/YAML 写错了/),
    ])
    await expect(site.putServer('user:bob', { id: 'build-a', host: 'h', user: 'u' })).rejects.toThrow(/已经有 build-a/)
    await expect(site.remove('user:bob', 'servers', 'build-a')).rejects.toThrow(/还在用：vendor-a/)
    expect(git(site.dir, 'rev-parse', 'HEAD')).toBe(head)

    // Taken out in order; every change is a commit by whoever made it.
    expect(await site.remove('user:bob', 'instances', 'vendor-a')).toMatch(/删掉了/)
    await site.remove('user:bob', 'servers', 'build-a')
    expect(existsSync(join(site.dir, 'sdk/servers/build-a.yaml'))).toBe(false)
    expect(git(site.dir, 'log', '--format=%an|%s', '-3').split('\n')).toEqual(['user:bob|Remove server build-a', 'user:bob|Remove instance vendor-a', 'user:bob|Edit build server build-a'])
    expect((await site.status()).problems).toEqual([])
  })
})

/**
 * A board host: ssh and scp run commands here with /tmp and /etc mapped into `remote`; sudo runs the command; systemctl
 * logs what it is asked. Its site has a hosts/ file of its own, an SDK the new site no longer has, and an image.
 */
function fakeHost() {
  const remote = join(dir, 'host'), bin = join(dir, 'bin'), log = join(dir, 'host.log')
  mkdirSync(bin, { recursive: true })
  const map = (variable: string) => `${variable}=\${${variable}//\\/tmp\\//${remote}/tmp/}; ${variable}=\${${variable}//\\/etc\\//${remote}/etc/}`
  writeFileSync(join(bin, 'ssh'), `#!/bin/bash
args=(); while [[ $# -gt 0 ]]; do case $1 in -i|-o|-p|-J) shift 2;; -*) shift;; *) args+=("$1"); shift;; esac; done
cmd=\${args[@]:1}; echo "ssh \${args[0]} :: $cmd" >> ${log}
${map('cmd')}
input=$(cat); ${map('input')}
mkdir -p ${remote}/tmp; cd ${remote}; bash -c "$cmd" <<< "$input"
`)
  writeFileSync(join(bin, 'scp'), `#!/bin/bash
args=(); while [[ $# -gt 0 ]]; do case $1 in -i|-o|-P|-J) shift 2;; -*) shift;; *) args+=("$1"); shift;; esac; done
dest=\${args[1]#*:}; ${map('dest')}; mkdir -p "$(dirname "$dest")"; cp "\${args[0]}" "$dest"
`)
  writeFileSync(join(bin, 'sudo'), '#!/bin/bash\n[[ $1 == -n ]] && shift\nexec "$@"\n')
  writeFileSync(join(bin, 'systemctl'), `#!/bin/bash\necho "systemctl $*" >> ${log}\n`)
  for (const name of ['ssh', 'scp', 'sudo', 'systemctl']) chmodSync(join(bin, name), 0o755)
  const s = join(remote, 'etc/bsp/site')
  mkdirSync(join(s, 'hosts'), { recursive: true }); writeFileSync(join(s, 'hosts/lab1.yaml'), 'host: {id: lab1}\n')
  mkdirSync(join(s, 'sdk/instances'), { recursive: true }); writeFileSync(join(s, 'sdk/instances/gone.yaml'), 'id: gone\n')
  mkdirSync(join(s, '.blobs/0123'), { recursive: true }); writeFileSync(join(s, '.blobs/0123/kept.bin'), 'image')
  writeFileSync(join(remote, 'etc/bsp/hostd.env'), 'BSP_TOKEN=host-token\n')
  process.env.PATH = `${bin}:${process.env.PATH}`
  return { site: s, log: () => existsSync(log) ? readFileSync(log, 'utf8') : '' }
}

type BspdMode = 'reload' | 'refuse' | 'busy' | 'job' | 'old' | 'old-leased' | 'old-broken'

/**
 * bspd on a local port: its tool list (`site_reload` only when new enough; `job_list` but for `old`), `site_reload`
 * (`refuse`: a catalog it will not load, the first time), `dut_list` with leases and busy boards, `job_list`, and
 * `health` (`old-broken`: only while the host's site is the one it had, as a bspd that cannot start on the new one).
 */
async function fakeBspd(mode: BspdMode, site?: string) {
  const calls: Array<{ path: string, auth: string | undefined }> = []
  const state = { mode, refused: 0 }
  const server: Server = createServer((request, response) => {
    calls.push({ path: request.url ?? '', auth: request.headers.authorization })
    const reply = (status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
    const now = state.mode, old = now.startsWith('old')
    if (request.headers.authorization !== 'Bearer host-token') return reply(403, { ok: false, error: { code: 'forbidden', message: 'token' } })
    if (request.url === '/api/v1/health') return now === 'old-broken' && !existsSync(join(site!, 'sdk/instances/gone.yaml')) ? reply(503, { ok: false }) : reply(200, { ok: true })
    if (request.url === '/api/v1/tools') return reply(200, { ok: true, tools: [...old ? [] : ['site.reload'], 'dut.list', ...now === 'old' ? [] : ['job.list']].map(name => ({ name, tool_name: name.replace('.', '_') })) })
    if (request.url === '/api/v1/tools/site_reload' && !old) {
      if (now === 'refuse' && !state.refused++) return reply(404, { ok: false, error: { code: 'not_found', message: "no build server 'nowhere'" } })
      return reply(200, { ok: true, result: { site: '/etc/bsp/site', sdks: ['bsp-a', 'bsp-b'], socs: ['soc-a'] } })
    }
    if (request.url === '/api/v1/tools/dut_list') return reply(200, { ok: true, result: [{ id: 'dut1', lease: now === 'old-leased' ? { holder: 'user:carol' } : null, busy: now === 'busy' ? 'boot load' : null }] })
    if (request.url === '/api/v1/tools/job_list' && now !== 'old') return reply(200, { ok: true, result: [{ id: 'flash-1', title: 'flash dut2', status: now === 'job' ? 'running' : 'succeeded' }] })
    reply(404, { ok: false, error: { code: 'not_found', message: `unknown command '${request.url}'` } })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, calls, state, close: () => new Promise(resolve => server.close(resolve)) }
}

/** A site with the example's SoC profiles and SDK catalog, a hook and an image. */
async function shippedSite(root: string) {
  const site = new Site(root, memory())
  await site.status()
  cpSync(join(EXAMPLE, 'sdk'), join(root, 'sdk'), { recursive: true })
  cpSync(join(EXAMPLE, 'socs'), join(root, 'socs'), { recursive: true })
  mkdirSync(join(root, 'hooks/boot'), { recursive: true }); writeFileSync(join(root, 'hooks/boot/say'), '#!/bin/sh\necho hi\n')
  mkdirSync(join(root, '.blobs/4567'), { recursive: true }); writeFileSync(join(root, '.blobs/4567/new.bin'), 'new image')
  mkdirSync(join(root, 'hosts'), { recursive: true }); writeFileSync(join(root, 'hosts/lab1.yaml'), 'host: {id: not-this}\n')
  writeFileSync(join(root, 'socs/soc-a/notes.tmp'), 'scratch'); writeFileSync(join(root, '.bspignore'), '*.tmp\n')
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'site')
  return site
}

/**
 * The bsp CLI's `images sync` and `images list` on `$BSP_SITE`: `soc-a/helper` is fetched only over the second way into
 * git (`ssh -F inherit`), `soc-a/rom` never is, and `soc-b/probe` has no source at all.
 */
function fakeBsp() {
  const bin = join(dir, 'fake-bsp'), log = join(dir, 'bsp.log')
  writeFileSync(bin, `#!/bin/bash
echo "$* | site=$BSP_SITE | config=$BSP_CONFIG | ssh=$GIT_SSH_COMMAND" >> ${log}
case "$*" in
  "--json images sync")
    if [[ $GIT_SSH_COMMAND == *inherit* ]]; then
      mkdir -p "$BSP_SITE/.blobs/${'a'.repeat(64)}"; echo helper > "$BSP_SITE/.blobs/${'a'.repeat(64)}/helper.bin"
      echo '{"ok": true, "result": {"fetched": ["soc-a/helper"], "present": [], "failed": [{"image": "soc-a/rom", "error": "no rom.bin at v1"}]}}'
    else
      echo '{"ok": true, "result": {"fetched": [], "present": [], "failed": [{"image": "soc-a/helper", "error": "Permission denied (publickey)"}, {"image": "soc-a/rom", "error": "Permission denied (publickey)"}]}}'
    fi;;
  "--json images list")
    echo '{"ok": true, "result": [{"soc": "soc-a", "image": "helper", "file": "helper.bin", "state": "present"}, {"soc": "soc-a", "image": "rom", "file": "rom.bin", "state": "fetchable"}, {"soc": "soc-b", "image": "probe", "file": "probe.bin", "state": "missing"}]}';;
  *) echo '{"ok": false, "error": {"message": "not faked"}}'; exit 1;;
esac
`)
  chmodSync(bin, 0o755)
  return { bin, sshCommands: async () => ['ssh -i key', 'ssh -F inherit'], log: () => existsSync(log) ? readFileSync(log, 'utf8') : '' }
}

describe('the site\'s images', () => {
  it('are fetched into .blobs/ before the site is bundled; what is not there is said, and does not stop the bundle', async () => {
    const bsp = fakeBsp(), settings = memory(), root = join(dir, 'state', 'bsp', 'site')
    const site = new Site(root, settings, { bin: bsp.bin, sshCommands: bsp.sshCommands })
    expect((await site.status()).images).toBeNull()                                  // not fetched yet
    cpSync(join(EXAMPLE, 'socs'), join(root, 'socs'), { recursive: true })
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'socs')
    const lines: string[] = [], bundle = join(dir, 'site.tgz')
    const { revision, images } = await site.ship(bundle, line => lines.push(line))
    expect(revision).toBe(git(root, 'rev-parse', '--short', 'HEAD'))               // .blobs/ is not part of the revision
    expect(images).toMatchObject({ ok: false, fetched: ['soc-a/helper'], failed: [{ image: 'soc-a/rom', error: 'no rom.bin at v1' }], missing: ['soc-b/probe（probe.bin）'], message: '镜像 1 个在（新取到 1 个），1 个没取到，1 个缺' })
    expect(lines).toEqual(['取到了镜像 soc-a/helper', '镜像 soc-a/rom 没取到：no rom.bin at v1', '镜像 soc-b/probe（probe.bin） 哪儿都没有，也没写从哪取', images!.message])
    expect(execFileSync('tar', ['-tzf', bundle], { encoding: 'utf8' })).toContain(`.blobs/${'a'.repeat(64)}/helper.bin`)
    // The CLI worked on this copy, with no user file of its own; each way into git tried while images failed.
    const calls = bsp.log().trim().split('\n')
    expect(calls).toEqual([
      `--json images sync | site=${root} | config=${join(dir, 'state', 'bsp', 'no-remotes.json')} | ssh=ssh -i key`,
      `--json images sync | site=${root} | config=${join(dir, 'state', 'bsp', 'no-remotes.json')} | ssh=ssh -F inherit`,
      `--json images list | site=${root} | config=${join(dir, 'state', 'bsp', 'no-remotes.json')} | ssh=`,
    ])
    expect((await site.status()).images).toEqual(images)                            // kept for the page

    // No bsp CLI: said, kept, and the site still bundles.
    const without = new Site(root, memory(), { bin: join(dir, 'no-such-bsp') })
    expect((await without.ship(bundle)).images).toMatchObject({ ok: false, message: expect.stringMatching(/^没取成镜像：.*no-such-bsp/) })
  })
})

describe('syncing the site to board hosts', () => {
  it('ships socs, sdk, hooks and images, leaves the host\'s hosts/ alone, and has bspd read it again', async () => {
    const host = fakeHost(), bspd = await fakeBspd('reload')
    try {
      const site = await shippedSite(join(dir, 'site'))
      const bundle = join(dir, 'site.tgz')
      await site.bundle(bundle)
      const lines: string[] = []
      const message = await syncHost(new Hosts(join(dir, 'state')), `bspd+ssh://root@lab-1:${bspd.port}`, bundle, line => lines.push(line))
      expect(message).toBe('bspd 重新读了站点：2 个 SDK，1 个 SoC')
      expect(readFileSync(join(host.site, 'sdk/instances/bsp-a.yaml'), 'utf8')).toBe(readFileSync(join(EXAMPLE, 'sdk/instances/bsp-a.yaml'), 'utf8'))
      expect(existsSync(join(host.site, 'socs/soc-a/soc.yaml'))).toBe(true)
      expect(existsSync(join(host.site, 'socs/soc-a/notes.tmp'))).toBe(false)                // .bspignore
      expect(readFileSync(join(host.site, 'hooks/boot/say'), 'utf8')).toContain('echo hi')
      expect(existsSync(join(host.site, 'sdk/instances/gone.yaml'))).toBe(false)             // replaced, not merged
      expect(readFileSync(join(host.site, '.blobs/4567/new.bin'), 'utf8')).toBe('new image')
      expect(readFileSync(join(host.site, '.blobs/0123/kept.bin'), 'utf8')).toBe('image')   // images are added to
      expect(readFileSync(join(host.site, 'hosts/lab1.yaml'), 'utf8')).toBe('host: {id: lab1}\n')
      expect(existsSync(join(host.site, '.git')) || existsSync(`${host.site}.incoming`) || existsSync(`${host.site}.previous`)).toBe(false)
      expect(bspd.calls.map(call => call.path)).toEqual(['/api/v1/tools', '/api/v1/tools/dut_list', '/api/v1/tools/job_list', '/api/v1/tools/site_reload'])
      expect(bspd.calls.every(call => call.auth === 'Bearer host-token')).toBe(true)
      expect(host.log()).not.toContain('systemctl')
    } finally { await bspd.close() }
  }, 30_000)

  it('puts back the site the host had when bspd refuses the new one, and changes nothing while a board is busy', async () => {
    const host = fakeHost()
    const site = await shippedSite(join(dir, 'site'))
    const bundle = join(dir, 'site.tgz')
    await site.bundle(bundle)
    const hosts = new Hosts(join(dir, 'state'))
    const unchanged = () => {
      expect(existsSync(join(host.site, 'sdk/instances/gone.yaml'))).toBe(true)
      expect(existsSync(join(host.site, 'sdk/instances/bsp-a.yaml')) || existsSync(join(host.site, 'socs'))).toBe(false)
      expect(existsSync(`${host.site}.incoming`) || existsSync(`${host.site}.previous`)).toBe(false)
    }
    // A new bspd that will not load the catalog: not taken for an old one (no restart), the old site back and read again.
    const refusing = await fakeBspd('refuse')
    try {
      const lines: string[] = []
      await expect(syncHost(hosts, `bspd+ssh://root@lab-1:${refusing.port}`, bundle, line => lines.push(line))).rejects.toThrow(/^bspd 没读进新站点：no build server 'nowhere'；主机上放回了原来的站点$/)
      unchanged()
      expect(refusing.calls.map(call => call.path).filter(path => path.endsWith('site_reload'))).toHaveLength(2)
      expect(host.log()).not.toContain('systemctl')
    } finally { await refusing.close() }
    // A board booting, or a job running: nothing is swapped.
    for (const [mode, said] of [['busy', /dut1：boot load.*没换站点/], ['job', /任务 flash-1：flash dut2.*没换站点/]] as const) {
      const busy = await fakeBspd(mode)
      try {
        await expect(syncHost(hosts, `bspd+ssh://root@lab-1:${busy.port}`, bundle, () => {})).rejects.toThrow(said)
        unchanged()
        expect(busy.calls.map(call => call.path)).not.toContain('/api/v1/tools/site_reload')
      } finally { await busy.close() }
    }
    expect(execFileSync('ls', [join(host.site, '..')], { encoding: 'utf8' }).trim().split('\n')).toEqual(['hostd.env', 'site'])
  }, 30_000)

  it('restarts a bspd too old to reload only when no board on it is leased, and puts the old site back when it does not come up', async () => {
    const host = fakeHost()
    const site = await shippedSite(join(dir, 'site'))
    const bundle = join(dir, 'site.tgz')
    await site.bundle(bundle)
    const hosts = new Hosts(join(dir, 'state'))
    const leased = await fakeBspd('old-leased')
    try {
      await expect(syncHost(hosts, `bspd+ssh://root@lab-1:${leased.port}`, bundle, () => {})).rejects.toThrow(/dut1：user:carol.*没重启 bspd，也没换站点/)
      expect(existsSync(join(host.site, 'sdk/instances/gone.yaml'))).toBe(true)
    } finally { await leased.close() }
    // It does not start on the new site: the old one goes back, and it is started again on that.
    const broken = await fakeBspd('old-broken', host.site)
    try {
      await expect(syncHost(hosts, `bspd+ssh://root@lab-1:${broken.port}`, bundle, () => {}, 1)).rejects.toThrow(/1 秒内没起来；主机上放回了原来的站点，bspd 又起来了$/)
      expect(existsSync(join(host.site, 'sdk/instances/gone.yaml'))).toBe(true)
      expect(existsSync(`${host.site}.previous`)).toBe(false)
      expect(host.log().match(/^systemctl restart bsp-hostd/gm)).toHaveLength(2)
    } finally { await broken.close() }
    const old = await fakeBspd('old')
    try {
      expect(await syncHost(hosts, `bspd+ssh://root@lab-1:${old.port}`, bundle, () => {})).toBe('重启了 bspd，它读了新站点')
      expect(old.calls.map(call => call.path)).toEqual(['/api/v1/tools', '/api/v1/tools/dut_list', '/api/v1/health'])
      expect(host.log().match(/^systemctl restart bsp-hostd/gm)).toHaveLength(3)
      expect(existsSync(join(host.site, 'sdk/instances/bsp-a.yaml'))).toBe(true)
      expect(existsSync(`${host.site}.previous`)).toBe(false)
    } finally { await old.close() }
    await expect(syncHost(hosts, null, bundle, () => {})).rejects.toThrow(/还没装好/)
    await expect(new Site(join(dir, 'empty'), memory()).status().then(() => new Site(join(dir, 'empty'), memory()).bundle(join(dir, 'x.tgz')))).rejects.toThrow(/站点是空的/)
  }, 30_000)

  it('ships the site before an install, and puts the old one back when bspd does not come up on it', async () => {
    const host = fakeHost()
    const site = await shippedSite(join(dir, 'site'))
    const bundle = join(dir, 'site.tgz')
    await site.bundle(bundle)
    const tree = join(dir, 'bsp'); mkdirSync(join(tree, 'deploy'), { recursive: true })
    const installer = (ok: boolean) => writeFileSync(join(tree, 'deploy/bspd-install.sh'), ok ? 'echo "BSPD-READY lab1 8765 f61b6f8"\n' : 'echo "!! bspd did not come up" >&2; exit 1\n')
    const hosts = new Hosts(join(dir, 'state'))
    installer(false)
    await expect(installHost(hosts, tree, { id: 'lab1', access: { address: 'lab-1', user: 'root' } }, 'token', () => {}, async () => bundle)).rejects.toThrow(/^装 bspd 失败：!! bspd did not come up；主机上放回了原来的站点$/)
    expect(existsSync(join(host.site, 'sdk/instances/gone.yaml'))).toBe(true)
    expect(existsSync(join(host.site, 'socs')) || existsSync(`${host.site}.previous`) || existsSync(`${host.site}.incoming`)).toBe(false)
    installer(true)
    expect(await installHost(hosts, tree, { id: 'lab1', access: { address: 'lab-1', user: 'root' } }, 'token', () => {}, async () => bundle)).toMatchObject({ version: 'f61b6f8' })
    expect(existsSync(join(host.site, 'sdk/instances/bsp-a.yaml'))).toBe(true)
    expect(existsSync(join(host.site, 'sdk/instances/gone.yaml')) || existsSync(`${host.site}.previous`)).toBe(false)
  }, 30_000)

  it('is offered by boardd: the site shown, edited, refused while broken, and synced to every bsp host with its revision kept', async () => {
    const host = fakeHost(), bspd = await fakeBspd('reload')
    try {
      const stateDir = join(dir, 'state')
      const lab = new BoardLab({ db: openDatabase(join(dir, 'b.sqlite')), modules: [bsp({ stateDir, bin: fakeBsp().bin, sdk: { run: async () => 0 } as never })] })
      const call = async (method: 'GET' | 'POST', path: string, body: Record<string, unknown> = {}) => {
        const found = lab.api.match(method, path)
        if (!found) throw new Error(`no ${method} ${path}`)
        return found.endpoint.handle({ query: new URLSearchParams(), params: found.params, body, caller: { holder: 'user:alice', local: true }, signal: new AbortController().signal, upload: null }) as Promise<any>
      }
      const events = async (path: string, body: Record<string, unknown> = {}) => {
        const reply = await call('POST', path, body) as { start: (emit: (event: string, data: any) => void, end: () => void, signal: AbortSignal) => Promise<void> }
        const out: Array<[string, any]> = []
        await new Promise<void>(resolve => { void reply.start((event, data) => out.push([event, data]), resolve, new AbortController().signal) })
        return { lines: out.filter(([event]) => event === 'out').map(([, data]) => String(data.text)), exit: out.find(([event]) => event === 'exit')?.[1] }
      }
      expect(await call('GET', '/api/bsp/site')).toMatchObject({ source: 'managed', ready: true, docs: [], hosts: {} })
      expect((await events('/api/bsp/site/sync')).exit).toMatchObject({ ok: false, message: expect.stringMatching(/还没有 bsp 主机/) })
      await lab.backends.add('user:alice', 'lab1', 'bsp')
      await lab.backends.configure('user:alice', 'lab1', { enabled: false, url: `bspd+ssh://root@lab-1:${bspd.port}` })
      expect((await events('/api/bsp/site/sync')).exit).toMatchObject({ ok: false, message: expect.stringMatching(/站点是空的/) })

      const root = join(stateDir, 'bsp', 'site')
      cpSync(join(EXAMPLE, 'sdk'), join(root, 'sdk'), { recursive: true })
      cpSync(join(EXAMPLE, 'socs'), join(root, 'socs'), { recursive: true })
      expect((await call('POST', '/api/bsp/site/server', { id: 'build-c', host: 'build-c.example.test', user: 'dev' })).file).toBe('sdk/servers/build-c.yaml')
      await expect(call('POST', '/api/bsp/site/sdk', { id: 'x', family: 'make-bsp', server: 'nowhere', path: '/p' })).rejects.toThrow(/没有编译服务器 nowhere/)
      // A broken file put there by hand: shown as a problem, and nothing is shipped until it is fixed.
      writeFileSync(join(root, 'sdk/instances/broken.yaml'), 'id: broken\nfamily: make-bsp\nserver: build-a\npath: /p\n')
      expect((await call('GET', '/api/bsp/site')).problems).toEqual([expect.stringMatching(/broken.yaml：boot 要有 load 和 download/)])
      expect((await events('/api/bsp/site/sync')).exit).toMatchObject({ ok: false, message: expect.stringMatching(/站点有问题/) })
      await call('POST', '/api/bsp/site/remove', { kind: 'instances', id: 'broken' })

      const synced = await events('/api/bsp/site/sync')
      const revision = (await call('GET', '/api/bsp/site')).revision
      // Images that are not there are said, and do not stop the sync.
      expect(synced.exit).toMatchObject({ ok: true, revision, results: [{ lab: 'lab1', ok: true }], images: { ok: false }, message: expect.stringMatching(/^1 台主机都是站点 \S+ 了；镜像 .*1 个缺$/) })
      expect(synced.lines).toContain('  bspd 重新读了站点：2 个 SDK，1 个 SoC')
      expect(synced.lines).toContain('镜像 soc-b/probe（probe.bin） 哪儿都没有，也没写从哪取')
      expect(existsSync(join(host.site, 'sdk/servers/build-c.yaml'))).toBe(true)
      const status = await call('GET', '/api/bsp/site')
      expect(status.hosts.lab1).toMatchObject({ revision, ok: true })
      expect(status.docs.find((doc: { id: string }) => doc.id === 'bsp-a')).toMatchObject({ kind: 'instances', layer: 'site', fields: { soc: 'soc-a', server: 'build-a', load: 'ready' } })
      expect(lab.kernel.db.prepare("SELECT detail, ok FROM actions WHERE kind = 'bsp-site' ORDER BY id").all()).toEqual(expect.arrayContaining([{ detail: `sync lab1 ${revision}`, ok: 1 }]))

      // A site the host's bspd refuses: the host keeps the one it had, and so does its record.
      await call('POST', '/api/bsp/site/server', { id: 'build-d', host: 'build-d.example.test', user: 'dev' })
      bspd.state.mode = 'refuse'
      expect((await events('/api/bsp/site/sync')).exit).toMatchObject({ ok: false, results: [{ lab: 'lab1', ok: false, message: expect.stringMatching(/放回了原来的站点/) }] })
      expect(existsSync(join(host.site, 'sdk/servers/build-d.yaml'))).toBe(false)
      expect((await call('GET', '/api/bsp/site')).hosts.lab1).toMatchObject({ revision, ok: false })
    } finally { await bspd.close() }
  }, 30_000)
})
