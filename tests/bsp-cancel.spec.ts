/**
 * Cancelling what the bsp driver runs: the host is told to stop its job and the driver follows it to its end, a job
 * that ended cancelled is reported as cancelled, and a CLI that has to be killed takes everything it started with it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CancelledError } from 'boardlab-core/core/errors.ts'
import type { BoardTarget, LabConfig } from 'boardlab-core/core/backend.ts'
import { bspLab, jobIn, runCli, type BspRunner } from '../src/modules/bsp/driver.ts'

const on = (device: string, lease: string | null = null): BoardTarget => ({ board: `bsp-${device}`, device, lease, die: 'die0', usbPath: null, port: null, gate: null })
const config: LabConfig = { url: 'http://registry.test:8765', username: '', password: 'tok', jump: '' }
const after = (args: string[]) => args.slice(args.indexOf('--stateless') + 1)
const routed = (rest: string[]) => rest[0] === '-r' ? rest.slice(2) : rest
const cancelledEnvelope = JSON.stringify({ ok: false, error: { code: 'cancelled', message: 'job flash-1-1 cancelled' } })

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bsp-cancel-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A fake `bsp` on disk: a shell script, run for real. */
function script(body: string): string {
  const file = join(dir, 'bsp')
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const until = async (test: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 20))) if (test()) return true
  return test()
}

describe('cancelling bsp jobs', () => {
  it('reports a job that ended cancelled (exit 4, error.code cancelled) as cancelled, not as done or failed', async () => {
    const bin = script(`echo '${cancelledEnvelope}'; exit 4`)
    const lab = bspLab({ bin })
    const flashing = lab.builds!.flash!(config, on('k3-a', 'T1'), { url: 'https://images.test/pkg.zip', flasher: null }, () => {})
    await expect(flashing).rejects.toBeInstanceOf(CancelledError)
    await expect(flashing).rejects.toThrow(/^已取消：bsp dut flash：job flash-1-1 cancelled/)
    // Either sign alone is enough: an older CLI's exit code, or the envelope.
    const coded = bspLab({ run: async () => ({ code: 4, stdout: '', stderr: '' }) })
    await expect(coded.builds!.boot(config, on('k3-a'), { sdk: 's', method: 'load', variant: null }, () => {})).rejects.toBeInstanceOf(CancelledError)
  })

  it('tells the host to stop the job its progress named, and follows the job to its end instead of killing the CLI', async () => {
    const calls: string[][] = []
    let finish!: () => void
    const run: BspRunner = (args, { onStderr, signal }) => {
      const rest = after(args)
      calls.push(rest)
      const command = routed(rest)
      if (command[0] === 'job' || (command[0] === 'dut' && command[1] === 'cancel')) return Promise.resolve({ code: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: '' })
      onStderr?.('k3-a @ h1: boot k3-sdk [load] job boot-1794977803-7')
      return new Promise(resolve => {
        // The job ends cancelled once told; killing the CLI (the signal) would leave the board in an unknown state.
        finish = () => resolve({ code: 4, stdout: cancelledEnvelope, stderr: '' })
        signal?.addEventListener('abort', () => resolve({ code: null, stdout: '', stderr: 'killed' }), { once: true })
      })
    }
    const lab = bspLab({ run })
    const stop = new AbortController()
    const booting = lab.builds!.boot(config, on('k3-a', 'T1'), { sdk: 'k3-sdk', method: 'load', variant: null }, () => {}, stop.signal)
    await until(() => calls.length === 1)
    stop.abort(new CancelledError('已取消：k3-a 的启动'))
    await until(() => calls.length === 3)
    // A board's job is the board's: the host cancels it only under the board's lease, by board or by job id.
    expect(calls.slice(1)).toEqual(expect.arrayContaining([['dut', 'cancel', 'k3-a', '--lease', 'T1'], ['-r', 'h1', 'job', 'cancel', 'boot-1794977803-7', '--lease', 'T1']]))
    finish()
    await expect(booting).rejects.toThrow('已取消：k3-a 的启动')
  })

  it('cancels under the lease the board holds when the cancel comes, not the one it started with', async () => {
    const calls: string[][] = []
    let finish!: () => void
    const run: BspRunner = (args, { onStderr, signal }) => {
      const command = routed(after(args))
      calls.push(command)
      if (command[0] === 'job' || (command[0] === 'dut' && command[1] === 'cancel')) return Promise.resolve({ code: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: '' })
      onStderr?.('k3-a @ h1: flash pkg.zip with tool-b, job flash-1794977803-13')
      return new Promise(resolve => {
        finish = () => resolve({ code: 4, stdout: cancelledEnvelope, stderr: '' })
        signal?.addEventListener('abort', () => resolve({ code: null, stdout: '', stderr: 'killed' }), { once: true })
      })
    }
    // The lease ran out during a long flash and boardd took it again (`followLease`): the target reads the new token.
    let token = 'T1'
    const target = { ...on('k3-a'), get lease() { return token } }
    const stop = new AbortController()
    const flashing = bspLab({ run }).builds!.flash!(config, target, { url: 'https://images.test/pkg.zip', flasher: null }, () => {}, stop.signal)
    await until(() => calls.length === 1)
    token = 'T2'
    stop.abort(new CancelledError('已取消：k3-a 的刷机'))
    await until(() => calls.length === 3)
    expect(calls.slice(1)).toEqual(expect.arrayContaining([['dut', 'cancel', 'k3-a', '--lease', 'T2'], ['job', 'cancel', 'flash-1794977803-13', '--lease', 'T2']]))
    finish()
    await expect(flashing).rejects.toThrow('已取消')
  })

  it('hands the host\'s refusal to the cancel, and follows the job to its own end instead of calling it cancelled', async () => {
    const calls: string[][] = []
    let finish!: () => void
    const refused = { code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'forbidden', message: 'DUT k3-a is not leased; mutating operations need a lease' } }), stderr: '' }
    const run: BspRunner = (args, { onStderr, signal }) => {
      const command = routed(after(args))
      calls.push(command)
      if (command[0] === 'job' || (command[0] === 'dut' && command[1] === 'cancel')) return Promise.resolve(refused)
      onStderr?.('k3-a @ h1: flash pkg.zip with tool-b, job flash-1794977803-12')
      return new Promise(resolve => {
        finish = () => resolve({ code: 0, stdout: JSON.stringify({ ok: true, result: { lines: ['done'] } }), stderr: '' })
        signal?.addEventListener('abort', () => resolve({ code: null, stdout: '', stderr: 'killed' }), { once: true })
      })
    }
    const lab = bspLab({ run, cancelGraceMs: 30 })
    const stop = new AbortController()
    const flashing = lab.builds!.flash!(config, on('k3-a', 'T1'), { url: 'https://images.test/pkg.zip', flasher: null }, () => {}, stop.signal)
    await until(() => calls.length === 1)
    const cancel = new CancelledError('已取消：k3-a 的刷机')
    stop.abort(cancel)
    await expect(cancel.answered()).rejects.toThrow(/not leased/)
    // Refused, it is not killed when the grace ends: the host still writes the board.
    await new Promise(resolve => setTimeout(resolve, 60))
    finish()
    expect(await flashing).toBe('done')
  })

  it('kills a CLI whose lock ended at once, and one with no job yet when cancelled', async () => {
    let killed = 0
    const run: BspRunner = (args, { signal }) => new Promise(resolve => signal?.addEventListener('abort', () => { killed++; resolve({ code: null, stdout: '', stderr: '' }) }, { once: true }))
    const lab = bspLab({ run })
    const stop = new AbortController()
    const staging = lab.download.stage(config, on('k3-a', 'T1'), { path: '/f', sha256: 'x' }, 1000, stop.signal)
    stop.abort(new CancelledError('已取消：加载'))
    await expect(staging).rejects.toThrow('已取消：加载')
    expect(killed).toBe(1)
  })

  it('names the jobs a command started from its progress', () => {
    expect(jobIn('[h1] probing (job probe-1794977803-3) ...')).toEqual({ id: 'probe-1794977803-3', host: 'h1' })
    expect(jobIn('k3-a @ h2: flash pkg.zip with tool-b, job flash-1794977803-12')).toEqual({ id: 'flash-1794977803-12', host: 'h2' })
    expect(jobIn('[  12.0s] flash rootfs 40%')).toBeNull()
  })
})

describe('the bsp process runner', () => {
  it('kills the CLI\'s whole process group, so what it started (ssh, scp) does not outlive it', async () => {
    const pidFile = join(dir, 'child.pid')
    const bin = script(`sleep 60 &\necho $! > ${pidFile}\nwait`)
    const stop = new AbortController()
    const running = runCli(bin, [], { env: process.env, timeoutMs: 60_000, signal: stop.signal })
    expect(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')).toBe(true)
    const child = Number(readFileSync(pidFile, 'utf8'))
    expect(alive(child)).toBe(true)
    stop.abort()
    const result = await running
    expect(result.code).toBeNull()
    expect(await until(() => !alive(child))).toBe(true)
  })

  it('passes stdout, stderr lines and the exit code through', async () => {
    const bin = script(`echo progress one >&2\necho '{"ok":true,"result":1}'\nexit 3`)
    const lines: string[] = []
    expect(await runCli(bin, [], { env: process.env, timeoutMs: 10_000, onStderr: line => lines.push(line) })).toEqual({ code: 3, stdout: '{"ok":true,"result":1}\n', stderr: 'progress one\n' })
    expect(lines).toEqual(['progress one'])
  })
})
