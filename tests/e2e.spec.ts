/**
 * End to end: the real `boardlab` CLI against a real boardd that drives two real board hosts.
 *
 * Everything here is the thing itself — two `boardctrld`s on fake hardware (the boardctrl repo's mock GPIO backend), each
 * with its own token, a boardd that knows both labs, and the built CLI talking to it. Nothing is mocked, so it
 * exercises the whole chain a defect can hide in: the CLI's argument handling, the HTTP API, the boardctrl module's
 * wiring of a lab's address and token, the boardctrl CLI's own remote resolution, and the host's tool API.
 *
 * It exists because the bugs that shipped in 0.4.43 lived in exactly that seam and no unit test could see them: a
 * lab's token never reaching boardctrl, a site file's entry answering instead of boardd's, a host address that was
 * loopback. Each of those breaks here and nowhere else.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { syncMarket, writeRecords } from 'boardlab-core/server/markets.ts'

const ROOT = resolve(__dirname, '..')
const BSP = join(ROOT, 'externals/boardctrl')
const CLI = join(ROOT, 'dist/cli.js')
/** The boardctrl test venv: it has the server extras, the machine's own python may not. */
const PYTHON = process.env.BOARDLAB_E2E_PYTHON ?? '/root/workspace/bspvenv/bin/python'

/** Whether this machine can run the test at all: the built CLI, boardctrl's sources, and a python with its server extras. */
function usable(): string | null {
  if (!existsSync(CLI)) return `the CLI is not built (${CLI}): run pnpm run build`
  if (!existsSync(join(BSP, 'frontends/server/__main__.py'))) return `bsp's sources are not here (${BSP})`
  if (!existsSync(PYTHON)) return `no python for boardctrl's server (${PYTHON}); set BOARDLAB_E2E_PYTHON`
  const probe = spawnSync(PYTHON, ['-c', 'import fastapi, uvicorn'], { encoding: 'utf8' })
  if (probe.status !== 0) return `${PYTHON} has no fastapi/uvicorn: ${(probe.stderr || '').trim().split('\n').pop()}`
  return null
}

const why = usable()

/** A port nothing listens on, asked for and given back. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  await new Promise<void>(done => server.close(() => done()))
  return port
}

interface Host { id: string, url: string, token: string, process: ChildProcess }

/**
 * One board host: boardctrld on the mock GPIO backend, with its own token. `site` is boardctrl's own layered configuration, so
 * each host is a separate instance with its own boards — the two labs a boardlab has are two of these.
 */
function startHost(dir: string, id: string, token: string, port: number): Promise<Host> {
  // boardctrl resolves boards/ and platforms/ from the host config's own directory, so the config goes inside a copy of its site.
  const site = join(dir, id, 'site')
  mkdirSync(join(site, 'hosts'), { recursive: true })
  mkdirSync(join(site, 'duts'), { recursive: true })
  spawnSync('cp', ['-a', join(BSP, 'tests/fixtures/site/boards'), join(BSP, 'tests/fixtures/site/socs'), site])
  // This host's boards, named after this host: boardctrl's example DUT, which the mock GPIO backend knows how to reset.
  const example = readFileSync(join(BSP, 'tests/fixtures/site/duts/mock-slot.yaml'), 'utf8').replace(/^host: .*$/m, `host: ${id}`)
  writeFileSync(join(site, 'duts', 'mock-board.yaml'), example)
  writeFileSync(join(site, 'boardctrl.yaml'), '{}\n')
  // The board's console log as serial-mux keeps it on the host: by day, each line stamped. Two boots, and a timeout.
  mkdirSync(join(dir, id, 'logs', 'mock-slot'), { recursive: true })
  const boot = (h: string) => [`[2026-11-24 ${h}:00:01] U-Boot SPL 2022.10-dirty (Nov 10 2026 - 08:00:00 +0800)`, `[2026-11-24 ${h}:00:02] OpenSBI v1.3`,
    `[2026-11-24 ${h}:00:03] U-Boot 2022.10-dirty (Nov 10 2026 - 08:00:00 +0800)`, `[2026-11-24 ${h}:00:04] [    0.000000] Linux version 6.6.36 (builder@host) (gcc 13.2) #1 SMP`,
    `[2026-11-24 ${h}:00:05] mmc0: error -110 whilst initialising SD card`]
  writeFileSync(join(dir, id, 'logs', 'mock-slot', '2026-11-24.log'), [...boot('08'), ...boot('09')].join('\n') + '\n')
  writeFileSync(join(site, 'hosts', `${id}.yaml`), [
    'host:',
    `  id: ${id}`,
    `  description: ${id} (end to end)`,
    'server:',
    '  bind: 127.0.0.1',
    `  port: ${port}`,
    `  state_dir: ${join(dir, id, 'var')}`,
    `  auth_token: ${token}`,
    'modules:',
    '  gpio:',
    '    board: example-40pin',
    '    backend: mock',
    '    pinmux: false',
    '  sdk: {}',
    '  dut:',
    '    probe: {pulse_ms: 20}',
    `    serial_log_dir: ${join(dir, id, 'logs')}`,
    '',
  ].join('\n'))
  const child = spawn(PYTHON, ['-m', 'frontends.server', '-c', join(site, 'hosts', `${id}.yaml`)], {
    cwd: BSP, env: { ...process.env, BSP_SITE: site, PYTHONPATH: BSP }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((done, fail) => {
    let seen = ''
    const timer = setTimeout(() => fail(new Error(`${id} did not start: ${seen.split('\n').slice(-6).join(' / ')}`)), 60_000)
    const read = (chunk: Buffer) => {
      seen += chunk.toString()
      if (/Uvicorn running|Application startup complete/.test(seen)) { clearTimeout(timer); done({ id, url: `http://127.0.0.1:${port}`, token, process: child }) }
    }
    child.stdout!.on('data', read)
    child.stderr!.on('data', read)
    child.on('exit', code => { clearTimeout(timer); fail(new Error(`${id} exited ${code}: ${seen.split('\n').slice(-6).join(' / ')}`)) })
  })
}

/**
 * boardd with its own state, then each lab added and set up **through its own API** — the path the page's settings use.
 * That is deliberate: a lab's address and token are what the product stores, so the test reaches hosts the same way a
 * person setting one up would, and a defect in that wiring shows here.
 */
async function startBoardd(dir: string, hosts: Array<{ id: string, url: string, token: string }>): Promise<{ url: string, process: ChildProcess }> {
  const port = await freePort()
  const stateDir = join(dir, 'boardd')
  mkdirSync(stateDir, { recursive: true })
  // The lab's modules come from the public market, as on a machine: clone it into the state directory first, so boardd
  // resolves `boardctrl` from there rather than from this build (which has no copy of it).
  const market = process.env.BOARDLAB_PUB_MARKET ?? resolve(ROOT, '..', 'boardlab-modules-pub')
  const synced = await syncMarket(stateDir, 'pub', { url: market })
  writeRecords(stateDir, [{ id: 'pub', url: market, branch: null, commit: synced.commit }])
  writeFileSync(join(stateDir, 'boardd.json'), JSON.stringify({ modules: { boardctrl: {} } }, null, 2))
  const child = spawn(process.execPath, ['--no-warnings', CLI, 'serve', '--port', String(port), '--state-dir', stateDir, '--no-ui'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let seen = ''
  const collect = (chunk: Buffer) => { seen += chunk.toString() }
  child.stdout!.on('data', collect)
  child.stderr!.on('data', collect)
  const url = `http://127.0.0.1:${port}`
  // Wait for it to answer, rather than for a line it prints: the line is wording, the answer is the contract.
  for (let at = 0; ; at++) {
    try { if ((await fetch(`${url}/api/version`)).ok) break } catch {}
    if (at > 120) throw new Error(`boardd did not start: ${seen.slice(-600)}`)
    await new Promise(done => setTimeout(done, 250))
  }
  const call = async (path: string, body: Record<string, unknown>) => {
    const response = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const text = await response.text()
    if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text.slice(0, 300)}`)
    return JSON.parse(text) as unknown
  }
  for (const host of hosts) {
    await call('/api/labs/add', { id: host.id, kind: 'boardctrl' })
    // `boardctrld+http://…`: this boardd reaches that host directly, the way it reaches a host it set up itself.
    await call('/api/labs', { id: host.id, enabled: true, url: `boardctrld+${host.url}`, password: host.token })
    const tested = await call('/api/labs/test', { id: host.id }) as { verifyOk?: boolean, verifyMessage?: string }
    if (tested.verifyOk !== true) throw new Error(`${host.id} could not be reached: ${tested.verifyMessage}`)
  }
  return { url, process: child }
}

// Skipping is for a machine that cannot run it (no python with boardctrl's server extras); it is said, never silent, since
// what this covers — a lab's token and address reaching boardctrl — is exactly where 0.4.43's defects hid.
if (why) console.warn(`e2e skipped: ${why}`)

describe.skipIf(why)('end to end: the CLI through boardd to two real board hosts', () => {
  let dir: string
  let boardd: { url: string, process: ChildProcess } | null = null
  const hosts: Host[] = []

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'boardlab-e2e-'))
    // Two hosts with different tokens: the defect was one lab's token never reaching boardctrl, which one host cannot show.
    hosts.push(await startHost(dir, 'host-a', 'token-for-a', await freePort()))
    hosts.push(await startHost(dir, 'host-b', 'token-for-b', await freePort()))
    boardd = await startBoardd(dir, hosts.map(host => ({ id: host.id, url: host.url, token: host.token })))
  }, 180_000)

  afterAll(async () => {
    boardd?.process.kill('SIGTERM')
    for (const host of hosts) host.process.kill('SIGTERM')
    await new Promise(done => setTimeout(done, 500))
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  /** The built CLI, as a person runs it, talking to this boardd. */
  function cli(args: string[]): { code: number | null, out: string, err: string } {
    const run = spawnSync(process.execPath, ['--no-warnings', CLI, ...args], {
      cwd: ROOT, encoding: 'utf8', timeout: 120_000, env: { ...process.env, BOARDS_REMOTE: boardd!.url, NODE_NO_WARNINGS: '1' },
    })
    return { code: run.status, out: run.stdout ?? '', err: run.stderr ?? '' }
  }

  it('sees every board of every lab, and says which host each is on', () => {
    const list = cli(['list'])
    expect(list.code, list.err).toBe(0)
    // Both hosts' boards are listed, named `<lab>-<dut>`: a single host's would mean one lab took both.
    expect(list.out).toMatch(/host-a-mock-slot/)
    expect(list.out).toMatch(/host-b-mock-slot/)
  })

  /**
   * The chain the defects lived in: a host command has to reach the host itself, with that host's token. A lab whose
   * token did not reach boardctrl, whose address was loopback, or whose name a site entry claimed, answers "missing or
   * wrong token" for — or silently talks to — the wrong host, and this is where that shows.
   */
  it('reads each host itself, with that host\'s token, through the raw boardctrl passthrough', () => {
    const gpio = cli(['boardctrl', 'gpio', 'list'])
    expect(gpio.code, gpio.err).toBe(0)
    // One section per host, both of them: a single section means one lab answered for the other.
    const sections = [...gpio.out.matchAll(/^== (\S+) ==$/gm)].map(found => found[1])
    expect(sections.sort()).toEqual(['host-a', 'host-b'])
    expect(gpio.out).not.toMatch(/missing or wrong token/)
    // and it is each host's own header: the example 40-pin board's pins, once per host.
    expect((gpio.out.match(/^P\d+/gm) ?? []).length).toBeGreaterThan(40)
  })

  it('names one lab the way the page names it, and reaches that one only', () => {
    const one = cli(['boardctrl', '-r', 'host-a', 'gpio', 'list'])
    expect(one.code, one.err).toBe(0)
    // One host: boardctrl prints no section header, and what comes is that host's header and nothing else.
    expect(one.out).not.toMatch(/^== /m)
    expect(one.out).toMatch(/^P\d+/m)
    expect(one.out + one.err).not.toMatch(/unknown remote|missing or wrong token/)
  })

  it('reads a host\'s console log by line number, finds every match and every boot, through boardd and boardctrl', () => {
    const boots = cli(['boots', 'host-a-mock-slot', '--json'])
    expect(boots.code, boots.err).toBe(0)
    expect(JSON.parse(boots.out).map((mark: { line: number, id: string }) => [mark.line, mark.id])).toEqual([[0, 'spl'], [1, 'opensbi'], [2, 'uboot'], [3, 'linux'], [5, 'spl'], [6, 'opensbi'], [7, 'uboot'], [8, 'linux']])
    const hits = cli(['logs', 'host-a-mock-slot', '--grep', 'mmc0', '--hits', '--json'])
    expect(hits.code, hits.err).toBe(0)
    expect(JSON.parse(hits.out)).toMatchObject({ hits: [4, 9], matched: 2, total: 10, source: 'backend' })
    // The line a match names is the line a window there shows, and its position names it again.
    const window = JSON.parse(cli(['logs', 'host-a-mock-slot', '--line', '9', '--before', '1', '--after', '0', '--json']).out)
    expect(window).toMatchObject({ numbers: [8, 9], moreBefore: true, moreAfter: false, snapped: false })
    expect(window.lines[1]).toContain('mmc0: error -110')
    const again = JSON.parse(cli(['logs', 'host-a-mock-slot', '--at', window.positions[0], '--before', '0', '--after', '0', '--json']).out)
    expect(again).toMatchObject({ numbers: [8], at: window.positions[0] })
    expect(again.lines[0]).toContain('Linux version')
  }, 180_000)

  it('takes a board lock and gives it back', () => {
    const lock = cli(['lock', 'host-a-mock-slot', '--for', 'end to end'])
    expect(lock.code, lock.err).toBe(0)
    expect(cli(['list']).out).toMatch(/使用中/)
    const unlock = cli(['unlock', 'host-a-mock-slot'])
    expect(unlock.code, unlock.err).toBe(0)
    expect(cli(['list']).out).not.toMatch(/使用中/)
  }, 180_000)
})
