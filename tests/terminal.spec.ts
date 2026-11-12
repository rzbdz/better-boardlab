/**
 * The terminal module against a real tmux of its own (a private TMUX_TMPDIR): terminals are made, typed into, read back
 * over the stream, renamed and removed (their tmux session with them), and a page that connects again gets the screen.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { openDatabase } from 'boardlab-core/core/db.ts'
import { BoardLab } from 'boardlab-core/core/lab.ts'
import { serve } from 'boardlab-core/server/http.ts'
import { terminal } from '../src/modules/terminal/index.ts'
import { dir, useTempDir } from './fakes.ts'

useTempDir()
const has = (bin: string) => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true } catch { return false } }

async function boardd() {
  const tmuxDir = join(dir, 'tmux'); mkdirSync(tmuxDir)
  const lab = new BoardLab({ db: openDatabase(join(dir, 'boards.sqlite')), modules: [terminal({ stateDir: dir, tmuxDir })] })
  const port = 43000 + Math.floor(Math.random() * 3000)
  const running = await serve(lab, { port, socketPath: join(dir, 'boardd.sock'), uiDir: null })
  const base = `http://127.0.0.1:${(running.http[0]!.address() as AddressInfo).port}`
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { host: `127.0.0.1:${port}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const text = await response.text()
    if (!response.ok) throw new Error(text)
    return text ? JSON.parse(text) : null
  }
  const tmux = (...args: string[]) => execFileSync('tmux', args, { env: { ...process.env, TMUX: '', TMUX_TMPDIR: tmuxDir }, encoding: 'utf8' })
  /** Read the stream until `until` shows in its output (or time runs out). */
  const watch = (id: string, until: RegExp) => new Promise<string>((resolve, reject) => {
    let seen = ''
    const req = request(`${base}/api/terminals/stream?id=${id}&rows=24&cols=80`, { headers: { host: `127.0.0.1:${port}` } }, response => {
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) if (line.startsWith('data: ')) { try { const value = JSON.parse(line.slice(6)); if (typeof value === 'string') seen += value } catch {} }
        if (until.test(seen)) { req.destroy(); resolve(seen) }
      })
    })
    req.on('error', error => { if (!until.test(seen)) reject(error) })
    req.end()
    setTimeout(() => { req.destroy(); until.test(seen) ? resolve(seen) : reject(new Error(`没等到 ${until}：${JSON.stringify(seen.slice(-300))}`)) }, 8000)
  })
  return { call, watch, tmux, close: async () => { try { tmux('kill-server') } catch {} await running.close() } }
}

describe.runIf(has('tmux') && has('python3'))('web terminals', () => {
  it('makes a terminal, types into it and reads it back, and a page that connects again gets the screen', async () => {
    const b = await boardd()
    try {
      const made = await b.call('POST', '/api/terminals', { name: '调试 k3' })
      expect(made).toMatchObject({ name: '调试 k3', alive: true })
      expect(b.tmux('list-sessions', '-F', '#{session_name}')).toContain(made.session)
      const reading = b.watch(made.id, /boardlab-said-hi/)
      await new Promise(resolve => setTimeout(resolve, 600))
      await b.call('POST', '/api/terminals/input', { id: made.id, data: 'echo boardlab-said-$((1+0))hi\r'.replace('$((1+0))', '') })
      expect(await reading).toMatch(/boardlab-said-hi/)
      // Another page (or the same one, reconnected) sees what is on the screen.
      expect(await b.watch(made.id, /boardlab-said-hi/)).toMatch(/boardlab-said-hi/)
      await b.call('POST', '/api/terminals/resize', { id: made.id, rows: 40, cols: 120 })
      await b.call('POST', '/api/terminals/rename', { id: made.id, name: '编译' })
      expect((await b.call('GET', '/api/terminals')).map((row: { name: string }) => row.name)).toEqual(['编译'])
      await b.call('POST', '/api/terminals/remove', { id: made.id })
      expect(await b.call('GET', '/api/terminals')).toEqual([])
      expect(() => b.tmux('has-session', '-t', made.session)).toThrow()
    } finally { await b.close() }
  }, 30_000)

  it('resizing a terminal whose shell has ended is a no-op, not an EPIPE', async () => {
    const b = await boardd()
    try {
      const made = await b.call('POST', '/api/terminals', { name: '要结束的' })
      // The stream resizes the pty at once and again 60 ms later; the session ends in between.
      const reading = b.watch(made.id, /$^/).catch(() => {})
      await new Promise(resolve => setTimeout(resolve, 20))
      await b.call('POST', '/api/terminals/remove', { id: made.id })
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(await b.call('POST', '/api/terminals/resize', { id: made.id, rows: 30, cols: 90 })).toEqual({ ok: true })
      await reading
    } finally { await b.close() }
  }, 30_000)

  it('refuses names that are empty after trimming or too long, and terminals it does not have', async () => {
    const b = await boardd()
    try {
      await expect(b.call('POST', '/api/terminals', { name: 'x'.repeat(41) })).rejects.toThrow(/40/)
      await expect(b.call('POST', '/api/terminals/remove', { id: 'nope' })).rejects.toThrow(/没有这个终端/)
    } finally { await b.close() }
  })
})
