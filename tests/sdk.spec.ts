import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from 'boardlab-core/core/db.ts'
import { serve } from 'boardlab-core/server/http.ts'
import { BoardsClient } from 'boardlab-core/shared/client.ts'
import { sdkCommand } from '../src/shared/bsp-client.ts'
import { bspSdk, type SdkReach } from '../src/modules/bsp/sdk.ts'
import { Bench, dir, makeLab, sha, useTempDir } from './fakes.ts'

useTempDir()

/** A port nothing is listening on, asked for and given back, so two servers in one file cannot share one. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

describe('SDK work through boardd', () => {
  it('runs bsp sdk for the caller, streams its output, and carries files both ways', async () => {
    const runs: Array<{ args: string[], holder: string, json: boolean }> = []
    const sdk = {
      async run(args: string[], options: { holder: string, json: boolean, group?: string, onOutput: (stream: 'stdout' | 'stderr', text: string) => void }) {
        runs.push({ args, holder: options.holder, json: options.json, ...(options.group && options.group !== 'sdk' ? { group: options.group } : {}) })
        if (args[0] === 'build') { options.onOutput('stderr', 'CC init/main.o\n'); options.onOutput('stdout', 'build ok\n'); return 0 }
        if (args[0] === 'put') { options.onOutput('stdout', readFileSync(args[3]!, 'utf8')); return 0 }
        if (args[0] === 'get') { writeFileSync(args[args.indexOf('-o') + 1]!, 'remote main.c'); return 0 }
        return 2
      },
    }
    const bench = new Bench([])
    const svc = makeLab({ ...bench.options(openDatabase(join(dir, 'sdk.sqlite'))), sdk })
    const port = await freePort()
    const running = await serve(svc, { port, socketPath: join(dir, 'sdk.sock'), uiDir: null })
    try {
      const client = new BoardsClient(join(dir, 'sdk.sock'), 'claude:build-1')
      const sdk = (args: string[], json: boolean, onOutput: (stream: 'stdout' | 'stderr', text: string) => void, group?: 'sdk' | 'catalog' | 'raw') => sdkCommand(client, args, json, onOutput, group)
      const out: string[] = []
      expect(await sdk(['build', 'sdk-a', 'kernel'], false, (stream, text) => out.push(`${stream}:${text}`))).toEqual({ code: 0, download: null })
      expect(out).toEqual(['stderr:CC init/main.o\n', 'stdout:build ok\n'])
      expect(runs[0]).toEqual({ args: ['build', 'sdk-a', 'kernel'], holder: 'claude:build-1', json: false })
      // put: the local file is sent first and stands in as @sha256:<hex>.
      const local = join(dir, 'main.c')
      writeFileSync(local, 'patched main.c')
      const ref = await client.sendFile(local)
      const echoed: string[] = []
      await sdk(['put', 'sdk-a', 'init/main.c', `@${ref}`], false, (_stream, text) => echoed.push(text))
      expect(echoed).toEqual(['patched main.c'])
      // get -o: saved on boardd's side, handed back by sha256 and fetched.
      const got = await sdk(['get', 'sdk-a', 'init/main.c', '-o', '@download'], false, () => {})
      expect(got.download).toBe(sha('remote main.c'))
      await client.fetchFile(got.download!, join(dir, 'fetched.c'))
      expect(readFileSync(join(dir, 'fetched.c'), 'utf8')).toBe('remote main.c')
      await expect(sdk(['probe'], false, () => {})).rejects.toThrow(/不支持的 sdk 操作/)
      // The registry's SDK catalog goes through the same runner as `bsp catalog`.
      await sdk(['recipe', 'k2-asr', 'download', '-f', `@${ref}`], false, () => {}, 'catalog')
      expect(runs.at(-1)).toMatchObject({ args: ['recipe', 'k2-asr', 'download', '-f', svc.files.get(sha('patched main.c'))!.path], group: 'catalog' })
      await expect(sdk(['export', '--dir', '/tmp/x'], false, () => {}, 'catalog')).rejects.toThrow(/不支持的 registry sdk 操作/)
      // Any bsp command goes through, except those that change boardd's own machine.
      await sdk(['-r', 'h1', 'dut', 'status', 'k3-a'], true, () => {}, 'raw')
      expect(runs.at(-1)).toMatchObject({ args: ['-r', 'h1', 'dut', 'status', 'k3-a'], json: true, group: 'raw' })
      await expect(sdk(['remote', 'add', 'x', 'http://x'], false, () => {}, 'raw')).rejects.toThrow(/boardd 所在机器自己的配置/)
      await expect(sdk(['catalog', 'export', '--dir', '/'], false, () => {}, 'raw')).rejects.toThrow(/boardd 所在机器自己的配置/)
      expect((await client.call<{ endpoints: string[] }>('GET', '/api')).endpoints).toContain('POST /api/sdk')
      expect(svc.history().actions.filter(action => action.kind === 'sdk').map(action => action.detail)).toEqual(['get sdk-a init/main.c -o', 'put sdk-a init/main.c', 'build sdk-a kernel'])
    } finally { await running.close() }
  })

  /**
   * A command that asks the host itself (`gpio list`, a site provider's) needs the host's token: boardd holds it for the
   * lab, so the passthrough gives it to bsp the way every other bsp call gets it, instead of leaving bsp to refuse.
   */
  it('a raw command reaches the host of the lab it names, with that lab\'s token', async () => {
    const reaches: Array<{ args: string[], reach?: unknown, env: NodeJS.ProcessEnv }> = []
    const sdk = {
      async run(args: string[], options: { holder: string, json: boolean, group?: string, reach?: unknown, onOutput: (stream: 'stdout' | 'stderr', text: string) => void }) {
        reaches.push({ args, reach: options.reach, env: {} })
        options.onOutput('stdout', 'ok\n')
        return 0
      },
    }
    const bench = new Bench([])
    const svc = makeLab({ ...bench.options(openDatabase(join(dir, 'raw.sqlite'))), sdk })
    await svc.backends.add('user:alice', 'host1', 'bsp')
    await svc.backends.configure('user:alice', 'host1', { enabled: true, url: 'http://registry.test:8765', username: '', password: 'host-secret', devices: '' })
    // A port of its own per test: two tests in one file must not land on the same one.
    const port = await freePort()
    const running = await serve(svc, { port, socketPath: join(dir, 'raw.sock'), uiDir: null })
    try {
      const client = new BoardsClient(join(dir, 'raw.sock'), 'claude:raw-1')
      const raw = (args: string[]) => sdkCommand(client, args, false, () => {}, 'raw')
      // Named: the lab is the host, so its address and token are the reach. `-r` stays the command's own argument.
      await raw(['-r', 'host1', 'gpio', 'list'])
      expect(reaches.at(-1)).toMatchObject({ args: ['-r', 'host1', 'gpio', 'list'], reach: { hosts: [{ name: 'lab-host1', url: 'http://registry.test:8765', token: 'host-secret' }], names: { host1: 'lab-host1' } } })
      // A command that names none (`hosts`, `dut list`) reaches every lab.
      await raw(['hosts'])
      expect(reaches.at(-1)!.reach).toMatchObject({ hosts: [{ name: 'lab-host1' }] })
      // Two labs, none named: both are reached, so a command can be about either.
      await svc.backends.add('user:alice', 'host2', 'bsp')
      await svc.backends.configure('user:alice', 'host2', { enabled: true, url: 'bspd+ssh://root@host2.dc:8765', username: '', password: 'two-secret', devices: '' })
      await raw(['gpio', 'list'])
      expect(reaches.at(-1)!.reach).toMatchObject({ hosts: [{ name: 'lab-host1', url: 'http://registry.test:8765' }, { name: 'lab-host2', url: 'bspd+ssh://root@host2.dc:8765', token: 'two-secret' }] })
      await raw(['-r', 'host2', 'gpio', 'list'])
      expect(reaches.at(-1)!.reach).toMatchObject({ hosts: [{ name: 'lab-host2' }] })
      // A name that is no lab is bsp's own remote, not an error from boardd.
      await raw(['-r', 'some-other-host', 'gpio', 'list'])
      expect(reaches.at(-1)!.reach).toBeNull()
      // `sdk` and `catalog` work on build servers and the registry: they get no reach even when a lab exists.
      await sdkCommand(client, ['list'], false, () => {})
      expect(reaches.at(-1)!.reach).toBeNull()
    } finally { await running.close() }
  })
})

describe('the bsp runner for a command that talks to hosts', () => {
  /** A stand-in `boardctrl` that records what it was given and says ok. */
  function fakeBoardctrl(): { bin: string, seen: Array<{ argv: string[], env: NodeJS.ProcessEnv }> } {
    const bin = join(dir, 'boardctrl')
    const log = join(dir, 'seen.json')
    writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs')
const seen = fs.existsSync(${JSON.stringify(log)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(log)}, 'utf8')) : []
seen.push({ argv: process.argv.slice(2), env: { BSP_CONFIG: process.env.BSP_CONFIG, BSP_TOKEN: process.env.BSP_TOKEN, BSP_HOLDER: process.env.BSP_HOLDER } })
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(seen))
process.stdout.write('ok\\n')
`)
    chmodSync(bin, 0o755)
    return { bin, get seen() { return existsSync(log) ? JSON.parse(readFileSync(log, 'utf8')) as Array<{ argv: string[], env: NodeJS.ProcessEnv }> : [] } }
  }

  it('runs the same CLI as the rest of the bsp driver, not a name this machine may not have', async () => {
    // A machine with only the older name (`bsp`) had no `boardctrl`: the runner spawned `boardctrl`, which fails, and
    // the command never ran. What it spawns is decided the way the driver decides it.
    const bsp = fakeBoardctrl()
    const path = process.env.PATH
    const onlyOld = join(dir, 'bin')
    mkdirSync(onlyOld, { recursive: true })
    symlinkSync(bsp.bin, join(onlyOld, 'bsp'))
    process.env.PATH = onlyOld
    try {
      const runner = bspSdk({ stateDir: join(dir, 'state2') })
      expect(await runner.run(['hosts'], { holder: 'claude:c', json: false, group: 'raw', reach: null, onOutput: () => {} })).toBe(0)
      expect(bsp.seen.at(-1)!.argv).toEqual(['hosts'])
    } finally { process.env.PATH = path }
  })

  it('hands a host command the lab\'s address and token, and leaves a command that names its own host alone', async () => {
    const bsp = fakeBoardctrl()
    const runner = bspSdk({ bin: bsp.bin, stateDir: join(dir, 'state') })
    const reach: SdkReach = { hosts: [{ name: 'lab-host1', url: 'http://registry.test:8765', token: 'host-secret' }], names: { host1: 'lab-host1' } }
    const said: string[] = []
    expect(await runner.run(['gpio', 'list'], { holder: 'claude:r', json: true, group: 'raw', reach, onOutput: (_s, text) => said.push(text) })).toBe(0)
    // The command runs unchanged; the labs are where bsp reads its remotes, each with its own token.
    expect(bsp.seen.at(-1)).toMatchObject({ argv: ['--json', '-r', 'lab-host1', 'gpio', 'list'], env: { BSP_HOLDER: 'bsp:claude:r' } })
    const config = bsp.seen.at(-1)!.env.BSP_CONFIG!
    expect(config).toMatch(new RegExp(`^${join(dir, 'state', 'bsp-holders')}/[0-9a-f]{16}/remotes\\.json$`))
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({ registry: null, remotes: { 'lab-host1': { url: 'http://registry.test:8765', token: 'host-secret' } } })
    expect(said).toEqual(['ok\n'])
    // `-r` keeps the command's choice, said the way a person says it (`host1`), written as the remote's own name.
    await runner.run(['-r', 'host1', 'gpio', 'list'], { holder: 'claude:r', json: false, group: 'raw', reach, onOutput: () => {} })
    expect(bsp.seen.at(-1)!.argv).toEqual(['-r', 'lab-host1', 'gpio', 'list'])
    // A name that is no lab is left alone: it may be bsp's own remote.
    await runner.run(['-r', 'elsewhere', 'gpio', 'list'], { holder: 'claude:r', json: false, group: 'raw', reach, onOutput: () => {} })
    expect(bsp.seen.at(-1)!.argv).toEqual(['-r', 'elsewhere', 'gpio', 'list'])
    // A lab on a board host: its own address first (never loopback, which may be a hostd on the boardd's machine),
    await runner.run(['dut', 'list'], { holder: 'claude:r', json: false, group: 'raw', reach: { hosts: [{ name: 'b', url: 'bspd+ssh://root@host-a.example:8765', token: 't' }], names: {} }, onOutput: () => {} })
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({ registry: null, remotes: { b: { url: 'http://host-a.example:8765', ssh: 'root@host-a.example', token: 't' } } })
    // The site's own remotes.json may point its `registry` at a machine and name the same hosts: a registry entry
    // merges over everything else and carries no token, so the reach speaks for the labs alone and under its own names.
    expect(JSON.parse(readFileSync(config, 'utf8'))).not.toHaveProperty('registered')
    expect(Object.keys(JSON.parse(readFileSync(config, 'utf8')).remotes)).toEqual(['b'])
    // No reach (`sdk`, `catalog`, or no lab to tell): the command runs as before, with no token of a lab's.
    await runner.run(['list'], { holder: 'claude:r', json: false, group: 'sdk', reach: null, onOutput: () => {} })
    expect(bsp.seen.at(-1)).toMatchObject({ argv: ['sdk', 'list'], env: { BSP_HOLDER: 'boardlab:claude:r' } })
    expect(bsp.seen.at(-1)!.env.BSP_TOKEN).toBeUndefined()
  })
})
