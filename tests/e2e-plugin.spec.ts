/**
 * End to end: a board whose debug path comes from a **site plugin**, through boardd to the page's API.
 *
 * This is the shape the EC port relies on: a site's `modules/<name>/module.py` registers a `debug` provider, a DUT
 * record binds it, and boardlab then asks the host what that path offers and drives it — without boardlab or core
 * knowing the plugin's name, its protocol, or that a plugin exists at all.
 *
 * Everything is the real thing: a real `boardctrld` with a plugin, the host's real session service (a fake
 * `systemd-run`/`systemctl` pair on PATH, as a session is a transient unit), the real boardd, and the built CLI. The
 * plugin is deliberately a plain fake with made-up names (`fake-sd`, `regs`, `halt`): if the chain only worked for a
 * provider with one site's name, that would be a leak, and this test is what shows it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..')
const BSP = join(ROOT, 'externals/bsp')
const CLI = join(ROOT, 'dist/cli.js')
const PYTHON = process.env.BOARDLAB_E2E_PYTHON ?? '/root/workspace/bspvenv/bin/python'
/** One holder throughout the test: the CLI takes the lock, and a request to boardd acts as the same holder. */
const HOLDER = 'agent:e2e-plugin'

/** The line the fake trace console serves, which the stream test looks for in the base64 frames. */
const SERVED_LINE = 'pc 0x00001000  sp 0x20001000'
/** The plugin host's API token (its `server.auth_token` in the site config written below). */
const HOST_TOKEN = 'plugin-token'

/** The bytes an SSE stream carried, in order: every `data:` frame is base64 of what the provider sent. */
const decoded = (text: string) => text.split('\n').filter(line => line.startsWith('data: '))
  .map(line => Buffer.from(line.slice(6), 'base64').toString('utf8')).join('')

/** Wait for a condition that becomes true as boardd works (a stopped session is seen on its next read). */
async function waitFor(check: () => Promise<boolean>, ms = 20_000) {
  const until = Date.now() + ms
  while (Date.now() < until) { if (await check()) return; await new Promise(done => setTimeout(done, 250)) }
  throw new Error('condition did not become true in time')
}
const BOARD = 'plug-host-plug-board'

function usable(): string | null {
  if (!existsSync(CLI)) return `the CLI is not built (${CLI}): run pnpm run build`
  if (!existsSync(join(BSP, 'frontends/server/__main__.py'))) return `bsp's sources are not here (${BSP})`
  if (!existsSync(PYTHON)) return `no python for bsp's server (${PYTHON}); set BOARDLAB_E2E_PYTHON`
  const probe = spawnSync(PYTHON, ['-c', 'import fastapi, uvicorn, yaml'], { encoding: 'utf8' })
  if (probe.status !== 0) return `${PYTHON} has no fastapi/uvicorn: ${(probe.stderr || '').trim().split('\n').pop()}`
  return null
}

const why = usable()
if (why) console.warn(`e2e (plugin) skipped: ${why}`)

/**
 * A site plugin doing what EC's does: it registers a `debug` provider, serves the session through the host's session
 * service, and answers the actions it declares. Its names are its own, and so is the state it reports.
 */
const PLUGIN = `
from core.dut.contracts import DebugProvider, ConsoleProvider

class FakeSd(DebugProvider):
    provider_name = "fake-sd"
    kinds = ("halt", "run", "regs")

    def __init__(self, spec, config, services=None):
        super().__init__(spec, config, services)
        self.spec, self.config = spec, config
        self.halted = False

    def start(self, lease=None):
        self.sessions.start(self.spec.id, "debug", self.provider_name, ["fake-sd-server"], lease=lease,
                            endpoint="127.0.0.1:3999")
        return {"dut": self.spec.id, "endpoint": "127.0.0.1:3999"}

    def stop(self):
        return self.sessions.stop(self.spec.id, "debug")

    def action(self, name, args=None):
        # The names a page renders come from here, not from boardlab: nothing further up knows them.
        self.halted = name in ("halt", "step")
        return {"halted": self.halted, "idcode": "0x12345678"}

    def shelf(self):
        return {"provider": self.provider_name, "kinds": list(self.kinds)}

    def info(self):
        return {"provider": self.provider_name, "kinds": list(self.kinds), "available": True}

    def state(self):
        s = self.sessions.get(self.spec.id, "debug")
        return {"halted": self.halted, **({"endpoint": s.endpoint} if s else {})}


class FakeTrace(ConsoleProvider):
    """The debug session's own bytes as the board's console: what a trace channel is (the EC's RTT).

    A console provider that serves a socket is reachable through the host like any other, so a page's
    trace pane travels the same path a serial console does. The socket greets a reader with the line the
    provider's session would print, then closes: a trace that ended, not one that hangs.
    """

    provider_name = "fake-trace"

    def __init__(self, spec, config=None, services=None):
        super().__init__(spec, config)
        self.spec = spec
        self.services = services
        # Its slot name: a console provider says what it is called, and the host starts the ones that have a slot
        # (a trace channel has none, and starts nothing).
        self.alias = "plug-board"
        self._serving = None

    def _path(self):
        return "/tmp/e2e-plugin-trace-" + self.spec.id + ".sock"

    def ensure(self):
        import os, socket, threading
        path = self._path()
        try:
            os.unlink(path)
        except OSError:
            pass
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(path)
        server.listen(4)

        def serve():
            while True:
                try:
                    conn, _ = server.accept()
                except OSError:
                    return
                with conn:
                    conn.sendall(("pc 0x00001000  sp 0x20001000" + "\\r\\n").encode())

        threading.Thread(target=serve, daemon=True).start()
        self._serving = server
        return "serving " + path

    def stop(self):
        if self._serving:
            self._serving.close()
            self._serving = None

    def up(self):
        # A trace console is usable while its session runs: the socket is the session, so the host's own record of
        # it is what says whether a reader would find anything there.
        if self.services is None:
            return self._serving is not None
        try:
            return self.services("sessions").get(self.spec.id, "debug") is not None
        except Exception:
            return self._serving is not None

    def socket(self):
        return self._path()

    def tail(self, lines=50, grep=None):
        return ["pc 0x00001000  sp 0x20001000"]

    def read_since(self, mark):
        return ""

    def range(self, since=None, until=None, grep=None, regex=False, limit=20000, first=False):
        return {"lines": self.tail(limit), "matched": 1, "truncated": False}

    def send(self, text, pattern=None, fail=None, timeout=60, mark=None):
        return {"output": text, "matched": True}

    def wait(self, pattern=None, fail=None, timeout=60, mark=None):
        return ""

    def run(self, command, expect, timeout):
        return {"output": "", "matched": True}

def setup(ctx, api, config):
    api.provider("debug", "fake-sd", lambda c, s, sv: FakeSd(s, config, sv),
                 title="Fake serial debug", about="a debug path a site brought, not boardlab")
    api.provider("console", "fake-trace", lambda c, s, sv: FakeTrace(s, {"provider": "fake-trace"}, sv),
                 title="the session's own bytes", about="a console that is the debug channel")
`

/** `systemd-run` and `systemctl` enough for the session service: a unit is up while a sentinel file is there. */
function fakeSystemd(dir: string): string {
  const bin = join(dir, 'bin')
  const units = join(dir, 'units')
  mkdirSync(bin, { recursive: true })
  mkdirSync(units, { recursive: true })
  writeFileSync(join(bin, 'systemd-run'), `#!/bin/sh
for arg in "$@"; do case "$arg" in --unit=*) unit=\${arg#--unit=} ;; esac; done
[ -n "$unit" ] || exit 1
mkdir -p "${units}"
: > "${units}/$unit"
exit 0
`)
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh
cmd=$1
unit=""
for arg in "$@"; do case "$arg" in boardctrl-session-*|boardctrl-console-*) unit=$arg ;; esac; done
[ -n "$unit" ] || unit=$2
case "$cmd" in
  stop) rm -f "${units}/$unit"; exit 0 ;;
  is-active) [ -f "${units}/$unit" ] && { echo active; exit 0; }; echo inactive; exit 3 ;;
esac
exit 0
`)
  chmodSync(join(bin, 'systemd-run'), 0o755)
  chmodSync(join(bin, 'systemctl'), 0o755)
  return bin
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  await new Promise<void>(done => server.close(() => done()))
  return port
}

describe.skipIf(why)('end to end: a site plugin\'s debug path, through boardd to the page\'s API', () => {
  let dir: string
  let host: { url: string, token: string, process: ChildProcess } | null = null
  let boardd: { url: string, process: ChildProcess } | null = null

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'boardlab-plugin-'))
    const bin = fakeSystemd(dir)
    const site = join(dir, 'site')
    mkdirSync(join(site, 'hosts'), { recursive: true })
    mkdirSync(join(site, 'duts'), { recursive: true })
    mkdirSync(join(site, 'providers', 'fake'), { recursive: true })
    spawnSync('cp', ['-a', join(BSP, 'tests/fixtures/site/boards'), join(BSP, 'tests/fixtures/site/socs'), site])
    writeFileSync(join(site, 'boardctrl.yaml'), '{}\n')
    writeFileSync(join(site, 'providers', 'fake', 'provider.py'), PLUGIN)

    const port = await freePort()
    const token = 'plugin-token'
    host = { url: `http://127.0.0.1:${port}`, token, process: null as unknown as ChildProcess }
    writeFileSync(join(site, 'hosts', 'plug.yaml'), [
      'host:', '  id: plug-host', '  description: plugin host (end to end)',
      'server:', `  bind: 127.0.0.1`, `  port: ${port}`, `  state_dir: ${join(dir, 'var')}`, `  auth_token: ${token}`,
      'modules:', '  gpio:', '    board: example-40pin', '    backend: mock', '    pinmux: false',
      '  sdk: {}', '  dut: {}',
      '  fake: {}', '',
    ].join('\n'))
    // The board, bound to the plugin's provider — how any site's record binds its own adapter.
    writeFileSync(join(site, 'duts', 'plug-board.yaml'), [
      'id: plug-board', 'host: plug-host', 'board: board-x', 'soc: soc-b',
      'description: a board debugged by a site plugin',
      'console: {alias: plug-board}',
      'services:', '  debug: {provider: fake-sd}', '  console: {provider: fake-trace, alias: plug-board}',
      'control:', '  backend: human', '  fdl: {strategy: strapped}',
      'sdks: []', '',
    ].join('\n'))
    const child = spawn(PYTHON, ['-m', 'frontends.server', '-c', join(site, 'hosts', 'plug.yaml')], {
      cwd: BSP, env: { ...process.env, BSP_SITE: site, PYTHONPATH: BSP, PATH: `${bin}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    host.process = child
    let seen = ''
    const read = (chunk: Buffer) => { seen += chunk.toString() }
    child.stdout!.on('data', read)
    child.stderr!.on('data', read)
    for (let at = 0; ; at++) {
      try { if ((await fetch(`${host.url}/api/v1/status`)).ok) break } catch {}
      if (at > 120) throw new Error(`the plugin host did not start: ${seen.slice(-800)}`)
      await new Promise(done => setTimeout(done, 250))
    }
    // A plugin that failed to load is reported, never silently missing: this is the check the EC port depends on.
    const status = await (await fetch(`${host.url}/api/v1/status`, { headers: { 'x-bsp-token': token } })).json() as {
      result?: { modules?: Record<string, { error?: string, providers?: string[] }>, providers?: Record<string, { names?: string[] }> }
    }
    const modules = status.result?.modules ?? {}
    expect(Object.values(modules).filter(m => m.error)).toEqual([])
    expect(Object.keys(modules)).toContain('fake')
    expect(status.result?.providers?.debug?.names ?? []).toContain('fake-sd')

    // boardd knows this one lab, added and set up through its API, as the page's settings do.
    const boarddPort = await freePort()
    const stateDir = join(dir, 'boardd')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'boardd.json'), JSON.stringify({ modules: { bsp: {} } }, null, 2))
    // The bsp boardd drives is this checkout's, not whatever `bsp` happens to be on the machine's PATH: a stale
    // install elsewhere has neither the rename nor the providers this test is about.
    const boarddChild = spawn(process.execPath, ['--no-warnings', CLI, 'serve', '--port', String(boarddPort), '--state-dir', stateDir, '--no-ui'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BOARDS_BSP: join(BSP, 'bin', 'bsp'), PATH: `${join(BSP, 'bin')}:${process.env.PATH}` },
    })
    const served = { url: `http://127.0.0.1:${boarddPort}`, process: boarddChild }
    boardd = served
    let boarddSeen = ''
    boarddChild.stdout!.on('data', (chunk: Buffer) => { boarddSeen += chunk.toString() })
    boarddChild.stderr!.on('data', (chunk: Buffer) => { boarddSeen += chunk.toString() })
    for (let at = 0; ; at++) {
      try { if ((await fetch(`${served.url}/api/version`)).ok) break } catch {}
      if (at > 120) throw new Error(`boardd did not start: ${boarddSeen.slice(-600)}`)
      await new Promise(done => setTimeout(done, 250))
    }
    const call = async (path: string, body: Record<string, unknown>) => {
      const response = await fetch(`${served.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const text = await response.text()
      if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text.slice(0, 300)}`)
      return JSON.parse(text) as Record<string, unknown>
    }
    await call('/api/labs/add', { id: 'plug-host', kind: 'bsp' })
    await call('/api/labs', { id: 'plug-host', enabled: true, url: `bspd+${host.url}`, password: token })
    const tested = await call('/api/labs/test', { id: 'plug-host' }) as { verifyOk?: boolean, verifyMessage?: string }
    expect(tested.verifyOk, tested.verifyMessage).toBe(true)
  }, 240_000)

  afterAll(async () => {
    boardd?.process.kill('SIGTERM')
    host?.process.kill('SIGTERM')
    await new Promise(done => setTimeout(done, 500))
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  /**
   * A request to boardd as `holder`. A CLI sends its holder and proves a lock with the token it kept; an HTTP caller
   * does the same with `x-boards-holder` and the lock's token, so the two can be the same holder throughout.
   */
  const request = async (path: string, body: Record<string, unknown>, holder = HOLDER, token?: string) => {
    const response = await fetch(`${boardd!.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-boards-holder': holder },
      body: JSON.stringify(token ? { ...body, token } : body),
    })
    return { response, text: await response.text() }
  }
  const post = async (body: Record<string, unknown>, token?: string) => {
    const { response, text } = await request('/api/debug', body, HOLDER, token)
    expect(response.ok, text).toBe(true)
    return (JSON.parse(text) as { debug: unknown }).debug as Record<string, unknown>
  }

  /** The built CLI, acting as the same holder the page's requests do. */
  const cli = (args: string[]) => spawnSync(process.execPath, ['--no-warnings', CLI, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, BOARDS_REMOTE: boardd!.url, BOARDS_HOLDER: HOLDER, CLAUDECODE: '', AI_AGENT: '', NODE_NO_WARNINGS: '1' },
  })

  /** Take the board's lock as the CLI does and hand back the token it keeps, which the requests above then prove. */
  const lock = (): string => {
    const taken = cli(['lock', BOARD, '--for', 'end to end', '--json'])
    expect(taken.status, taken.stderr).toBe(0)
    return (JSON.parse(taken.stdout) as { token: string }).token
  }

  it('reports the plugin\'s path with the words the plugin chose, and drives it under the lock', async () => {
    // The path is read before any lock: knowing what a board offers changes nothing on it.
    const path = await post({ board: BOARD, action: 'path' })
    expect(path.provider).toBe('fake-sd')
    // Boardlab shows the provider's own words, never its registered name: this is what a page renders.
    expect(path.title).toBe('Fake serial debug')
    expect(path.about).toBe('a debug path a site brought, not boardlab')
    expect(path.kinds).toEqual(['halt', 'run', 'regs'])
    expect(path.running).toBe(false)

    const token = lock()
    const started = await post({ board: BOARD, action: 'start' }, token)
    expect(started.running).toBe(true)
    expect(started.endpoint).toBe('127.0.0.1:3999')

    // An action's data is what the provider returned; boardlab adds a sentence, not a vocabulary.
    const ran = await post({ board: BOARD, action: 'halt' }, token) as { data?: Array<{ label: string, value: string }> }
    expect(ran.data).toContainEqual({ label: 'halted', value: 'true' })

    const stopped = await post({ board: BOARD, action: 'stop' }, token) as { message?: string }
    expect(String(stopped.message)).toMatch(/停止/)
    expect((await post({ board: BOARD, action: 'path' })).running).toBe(false)
    expect(cli(['unlock', BOARD]).status).toBe(0)
  })

  it('says so plainly for an action the path does not offer', async () => {
    const token = lock()
    const { response, text } = await request('/api/debug', { board: BOARD, action: 'flash' }, HOLDER, token)
    expect(response.ok).toBe(false)
    // The provider's own list of what it has, not a list boardlab keeps.
    expect(text).toMatch(/halt, run, regs/)
    expect(cli(['unlock', BOARD]).status).toBe(0)
  })

  it('registers a board a scan cannot see, by hand, and drives its debug path', async () => {
    // The board the EC is: no USB, no cabled console, only a debug path on header pins. This is the form's request.
    const made = await (async () => {
      const methods = await (await fetch(`${boardd!.url}/api/labs/discover/methods?id=plug-host`, { headers: { 'x-boards-holder': HOLDER } })).json() as
        Array<{ id: string, compose?: boolean, fields: Array<{ id: string }> }>
      const manual = methods.find(method => method.compose)
      expect(manual, JSON.stringify(methods)).toBeTruthy()
      // It asks what the person knows and bsp needs: the host, a name, the roles, and optionally SoC/model/console/USB/reset.
      expect(manual!.fields.map(field => field.id)).toEqual(['host', 'name', 'services', 'soc', 'board', 'console_alias', 'usb', 'reset_pin'])
      const { response, text } = await request('/api/labs/compose', { id: 'plug-host', method: manual!.id,
        values: { host: 'plug-host', name: 'by-hand', services: JSON.stringify({ debug: { provider: 'fake-sd' }, console: { provider: 'none' }, download: { provider: 'none' } }) } }, HOLDER)
      expect(response.ok, text).toBe(true)
      return JSON.parse(text) as { name: string, message: string }
    })()
    expect(made.name).toBe('by-hand')
    // It is a board like any other now: listed, and its debug path is the plugin provider's own.
    const listed = cli(['list'])
    expect(listed.status, listed.stderr).toBe(0)
    expect(listed.stdout).toContain('plug-host-by-hand')
    const path = cli(['debug', 'plug-host-by-hand'])
    expect(path.status, path.stderr).toBe(0)
    expect(path.stdout).toContain('Fake serial debug')
    expect(path.stdout).toContain('halt, run, regs')
  })

  it('drives the whole chain from the CLI: the board is listed and its debug path is the plugin\'s', () => {
    const list = cli(['list'])
    expect(list.status, list.stderr).toBe(0)
    expect(list.stdout).toContain(BOARD)
    const path = cli(['debug', BOARD])
    expect(path.status, path.stderr).toBe(0)
    expect(path.stdout).toContain('Fake serial debug')
    expect(path.stdout).toContain('halt, run, regs')
    expect(path.stdout).toContain('未启动')
  })

  it('streams the session\'s bytes through the host, and stops the session when the lock ends', async () => {
    // The trace pane: the plugin's session speaks on a socket its console provider serves, and boardd carries
    // those bytes to the page. Nothing above the provider knows what they say — only that it said them.
    const token = lock()
    await post({ board: BOARD, action: 'start' }, token)
    // The socket the trace pane reads is the console provider's, served by the host: it must exist before the
    // stream opens, or the pipe has nothing to carry (the host starts a non-serial console itself).
    const st = await (await fetch(`${host!.url}/api/v1/tools/dut_status`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-bsp-token': HOST_TOKEN },
      body: JSON.stringify({ dut: 'plug-board' }),
    })).json() as { result?: { console_socket?: string, console_up?: boolean } }
    expect(st.result?.console_up, JSON.stringify(st)).toBe(true)
    expect(existsSync(String(st.result?.console_socket))).toBe(true)
    const reply = await fetch(`${boardd!.url}/api/debug/stream?board=${encodeURIComponent(BOARD)}`, {
      headers: { 'x-boards-holder': HOLDER },
    })
    expect(reply.ok, await reply.clone().text()).toBe(true)
    let text = ''
    const reader = reply.body!.getReader()
    const decoder = new TextDecoder()
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (decoded(text).includes(SERVED_LINE)) break
    }
    void reader.cancel()
    // The line the provider served, base64 in an SSE data frames, exactly as the page's trace pane reads it: what
    // arrives is the provider's bytes, and nothing above it knows what they say.
    expect(decoded(text)).toContain(SERVED_LINE)

    // Releasing the lock ends the session: the unit the provider started is gone afterwards, not only its record.
    // Both layers that promise this are in the path — the host reaps a session whose lease ran out, and boardd stops
    // a session it started when the lock ends (pinned on its own in core's tests) — so this proves the chain end to
    // end, not either one alone.
    const units = join(dir!, 'units')
    expect(readdirSync(units).filter(name => name.includes('plug-board'))).not.toEqual([])
    expect(cli(['unlock', BOARD]).status).toBe(0)
    await waitFor(async () => readdirSync(units).every(name => !name.includes('plug-board')), 30_000)
    expect((await post({ board: BOARD, action: 'path' })).running).toBe(false)
  })
})
