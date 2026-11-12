/**
 * The `terminal` module: shells on boardd's machine in the browser, each a tmux session that outlives the page, the
 * connection and boardd itself. boardd keeps the list (name ↔ tmux session); a terminal is reached through a pty bridge
 * (python3's pty, no native module) attached to its session, shared by every page that has it open. Output streams to
 * the page (SSE) and keystrokes come back as small POSTs, as for serial consoles; a page that reconnects gets the whole
 * screen redrawn.
 *
 * A terminal is a shell as boardd's own user: load this module only where everyone who can open the page may have that.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { EventStream } from 'boardlab-core/core/api.ts'
import { BoardError } from 'boardlab-core/core/errors.ts'
import type { Module } from 'boardlab-core/core/module.ts'

export interface Terminal { id: string, name: string, session: string, createdAt: string, createdBy: string, alive: boolean, viewers: number }
export interface TerminalApi { list(): Promise<Terminal[]> }

/** The pty bridge: runs `tmux new -A -s <session>` on a pty, relays stdin and stdout, and takes `rows cols` lines on fd 3. */
const BRIDGE = `import os, pty, sys, select, fcntl, termios, struct, signal
session, rows, cols = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
env = dict(os.environ, TERM="xterm-256color")
env.setdefault("LANG", "C.UTF-8")
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[4], [sys.argv[4], "new-session", "-A", "-s", session], env)
def size(r, c):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
size(rows, cols)
signal.signal(signal.SIGPIPE, signal.SIG_DFL)
ctl, buf = 3, b""
while True:
    try:
        ready, _, _ = select.select([0, ctl, fd], [], [])
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if 0 in ready:
        data = os.read(0, 65536)
        if not data:
            break
        os.write(fd, data)
    if ctl in ready:
        more = os.read(ctl, 1024)
        if not more:
            ctl = -1
            continue
        buf += more
        while b"\\n" in buf:
            line, buf = buf.split(b"\\n", 1)
            try:
                r, c = (int(x) for x in line.split())
                size(max(r, 2), max(c, 10))
            except ValueError:
                pass
`

const NAME = /^[^\n\r\t]{1,40}$/
const SCREEN = 512 * 1024

interface Bridge { child: ChildProcess, screen: Buffer[], size: number, rows: number, cols: number, outputs: Set<(data: Buffer) => void>, ended: Set<(why: string) => void> }

/** `tmuxDir`: where tmux keeps its server socket ($TMUX_TMPDIR), for a tmux server of boardlab's own (tests). */
export function terminal(options: { stateDir: string, tmux?: string, python?: string, tmuxDir?: string }): Module<TerminalApi> {
  const tmux = options.tmux ?? 'tmux'
  const python = options.python ?? 'python3'
  const dir = join(options.stateDir, 'terminal')
  mkdirSync(dir, { recursive: true })
  const bridgePath = join(dir, 'bridge.py')
  writeFileSync(bridgePath, BRIDGE)
  const env = { ...process.env, TMUX: '', ...(options.tmuxDir ? { TMUX_TMPDIR: options.tmuxDir } : {}) }
  const run = (args: string[]) => new Promise<string>((resolve, reject) => execFile(tmux, args, { timeout: 10_000, env }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout)))

  return {
    id: 'terminal',
    title: '终端',
    setup(lab) {
      const settings = lab.kernel.settings('terminal')
      type Row = Omit<Terminal, 'alive' | 'viewers'>
      const read = (): Row[] => { try { return JSON.parse(settings.get('list') ?? '[]') } catch { return [] } }
      const write = (rows: Row[]) => { settings.set('list', JSON.stringify(rows)); lab.kernel.changed(null) }
      const bridges = new Map<string, Bridge>()
      const find = (id: string) => { const row = read().find(item => item.id === id); if (!row) throw new BoardError('not-found', `没有这个终端：${id}`); return row }
      const sessions = async () => new Set((await run(['list-sessions', '-F', '#{session_name}']).catch(() => '')).split('\n').filter(Boolean))

      /** The bridge to a terminal's session, started when first needed; the session is made if it is gone. */
      function bridge(row: Row, rows = 30, cols = 100): Bridge {
        const known = bridges.get(row.id)
        if (known) return known
        const child = spawn(python, [bridgePath, row.session, String(rows), String(cols), tmux], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env })
        const made: Bridge = { child, screen: [], size: 0, rows, cols, outputs: new Set(), ended: new Set() }
        bridges.set(row.id, made)
        child.stdout!.on('data', (data: Buffer) => {
          made.screen.push(data); made.size += data.length
          while (made.size > SCREEN && made.screen.length > 1) made.size -= made.screen.shift()!.length
          for (const fn of made.outputs) fn(data)
        })
        child.on('exit', code => {
          if (bridges.get(row.id) === made) bridges.delete(row.id)
          for (const fn of made.ended) fn(code === 0 ? '终端里的 shell 退出了' : `终端断开（${code ?? '信号'}）`)
        })
        child.stdin!.on('error', () => {})        // a shell that ended while typing: drop the write
        ;(child.stdio[3] as NodeJS.WritableStream | null)?.on('error', () => {})
        return made
      }
      /** The pty beside the shell: resizing it after the shell is gone must be a no-op, not an EPIPE. */
      const control = (made: Bridge): NodeJS.WritableStream | null => {
        const fd = made.child.stdio[3] as NodeJS.WritableStream | null
        return fd && made.child.exitCode === null && !made.child.killed ? fd : null
      }
      const resize = (made: Bridge, rows: number, cols: number) => {
        made.rows = rows; made.cols = cols
        try { control(made)?.write(`${rows} ${cols}\n`) } catch { /* the terminal ended meanwhile */ }
      }

      const api: TerminalApi = {
        async list() {
          const live = await sessions()
          return read().map(row => ({ ...row, alive: live.has(row.session), viewers: bridges.get(row.id)?.outputs.size ?? 0 }))
        },
      }

      lab.api.add('terminal', [
        { method: 'GET', path: '/api/terminals', about: '终端列表：每个是 boardd 机器上的一个 tmux 会话', handle: () => api.list() },
        {
          method: 'POST', path: '/api/terminals', about: '新建终端（name）', handle: async ({ body, caller }) => {
            const name = String(body.name ?? '').trim() || `终端 ${read().length + 1}`
            if (!NAME.test(name)) throw new BoardError('invalid', '名字最多 40 个字，不能换行')
            const id = randomBytes(4).toString('hex')
            const row: Row = { id, name, session: `boardlab-${id}`, createdAt: lab.kernel.iso(), createdBy: caller.holder }
            await run(['new-session', '-d', '-s', row.session, '-x', '200', '-y', '50'])
            write([...read(), row])
            lab.kernel.record(caller.holder, null, 'terminal', `新建 ${name}`, true, null)
            return { ...row, alive: true, viewers: 0 }
          },
        },
        {
          method: 'POST', path: '/api/terminals/rename', about: '改终端的名字（id、name）', handle: ({ body }) => {
            const row = find(String(body.id ?? '')), name = String(body.name ?? '').trim()
            if (!NAME.test(name)) throw new BoardError('invalid', '名字最多 40 个字，不能换行')
            write(read().map(item => item.id === row.id ? { ...item, name } : item))
            return { ok: true }
          },
        },
        {
          method: 'POST', path: '/api/terminals/remove', about: '删除终端：结束它的 tmux 会话（id）', handle: async ({ body, caller }) => {
            const row = find(String(body.id ?? ''))
            bridges.get(row.id)?.child.kill()
            await run(['kill-session', '-t', row.session]).catch(() => {})
            write(read().filter(item => item.id !== row.id))
            lab.kernel.record(caller.holder, null, 'terminal', `删除 ${row.name}`, true, null)
            return { ok: true }
          },
        },
        {
          method: 'GET', path: '/api/terminals/stream', about: '终端的输出（id，rows，cols）：先重画整屏，再实时推送', handle: ({ query }) => {
            const row = find(query.get('id') ?? '')
            const rows = Math.max(2, Number(query.get('rows')) || 30), cols = Math.max(10, Number(query.get('cols')) || 100)
            return new EventStream((emit, end, signal) => {
              const made = bridge(row, rows, cols)
              const decoder = new TextDecoder()
              const out = (data: Buffer) => emit('output', decoder.decode(data, { stream: true }))
              const gone = (why: string) => { emit('closed', why); end() }
              made.outputs.add(out); made.ended.add(gone)
              emit('ready', { id: row.id, name: row.name })
              // A page that (re)connects gets the whole screen: tmux redraws it when the size changes.
              resize(made, rows, Math.max(10, cols - 1))
              setTimeout(() => resize(made, rows, cols), 60)
              const ping = setInterval(() => emit('ping', Date.now()), 20_000)
              signal.addEventListener('abort', () => { clearInterval(ping); made.outputs.delete(out); made.ended.delete(gone) }, { once: true })
            })
          },
        },
        {
          method: 'POST', path: '/api/terminals/input', about: '往终端打字（id、data）', handle: ({ body }) => {
            const row = find(String(body.id ?? ''))
            const data = String(body.data ?? '')
            if (data.length > 256 * 1024) throw new BoardError('invalid', '一次输入太多')
            const made = bridges.get(row.id) ?? bridge(row)
            made.child.stdin!.write(data)
            return { ok: true }
          },
        },
        {
          method: 'POST', path: '/api/terminals/resize', about: '终端的大小（id、rows、cols）', handle: ({ body }) => {
            const made = bridges.get(String(body.id ?? ''))
            if (made) resize(made, Math.max(2, Math.min(500, Number(body.rows) || 30)), Math.max(10, Math.min(1000, Number(body.cols) || 100)))
            return { ok: true }
          },
        },
      ])
      return api
    },
  }
}
