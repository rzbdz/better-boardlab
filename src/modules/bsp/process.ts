/**
 * The bsp CLI as boardd runs it: each command the leader of a process group of its own, so stopping it stops the ssh
 * and scp it started too, and the jobs a command starts on a host, as its progress names them.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { Duplex } from 'node:stream'
import { CancelledError } from 'boardlab-core/core/errors.ts'

/** A CLI told to stop (SIGTERM, to its whole process group) is killed outright after this. */
export const KILL_GRACE_MS = 5_000
/** A cancelled job ends before its next step; the CLI following it is killed only if it has not ended by then. */
export const CANCEL_GRACE_MS = 10 * 60_000
/** boardctrl's exit code for a job that was cancelled. */
export const EXIT_CANCELLED = 4

export interface BspResult { code: number | null, stdout: string, stderr: string }

/** Stop a process and everything it started: it leads its own process group (it was spawned detached). */
export function killGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return
  try { process.kill(-child.pid!, signal) } catch { try { child.kill(signal) } catch {} }
}

/**
 * Run the CLI as the leader of a process group of its own, so killing it (a timeout, `signal`) also stops the ssh and
 * scp it started, which otherwise stay behind holding the host.
 */
export function runCli(bin: string, args: string[], options: { env: NodeJS.ProcessEnv, timeoutMs: number, onStderr?: (line: string) => void, signal?: AbortSignal }): Promise<BspResult> {
  const { env, timeoutMs, onStderr, signal } = options
  return new Promise(resolve => {
    const LIMIT = 16 * 1024 * 1024
    let child: ChildProcess
    try { child = spawn(bin, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (error) { return resolve({ code: null, stdout: '', stderr: (error as Error).message }) }
    let stdout = '', stderr = '', partial = '', finished = false, failure = ''
    let hard: ReturnType<typeof setTimeout> | undefined
    const kill = () => {
      if (finished) return
      killGroup(child, 'SIGTERM')
      hard ??= setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS)
      hard.unref?.()
    }
    const timer = setTimeout(kill, timeoutMs)
    timer.unref?.()
    const aborted = () => kill()
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted) kill()
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { if (stdout.length < LIMIT) stdout += chunk })
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < LIMIT) stderr += chunk
      if (!onStderr) return
      const lines = (partial + chunk).split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) onStderr(line.trim())
    })
    const finish = (code: number | null) => {
      if (finished) return
      finished = true
      clearTimeout(timer); if (hard) clearTimeout(hard)
      signal?.removeEventListener('abort', aborted)
      if (partial.trim()) onStderr?.(partial.trim())
      // Whatever it left running in its group (a command it backgrounded) goes with it.
      try { process.kill(-child.pid!, 'SIGTERM') } catch {}
      resolve({ code, stdout, stderr: stderr || failure })
    }
    child.on('error', error => { failure = error.message; finish(null) })
    child.on('close', code => finish(code))
  })
}

/** A job a bsp command started, as its progress names it (`[h1] probing (job probe-17-3)`, `k3-a @ h1: … job boot-17-4`). */
export function jobIn(line: string): { id: string, host: string | null } | null {
  const found = line.match(/\bjob ([a-z][a-z_]*-\d+-\d+)\b/)
  if (!found) return null
  const host = line.match(/^\[([^\]\s]+)\]/)?.[1] ?? line.match(/ @ ([^\s:]+):/)?.[1] ?? null
  return { id: found[1]!, host }
}

/**
 * Run one bsp command under `signal`. A cancel (the signal's reason is a CancelledError) tells the host to stop what
 * the command started — `stop`, the command that cancels it there, and every job its progress named (`tell`, with
 * `jobArgs`: the board's lease, which a board's job needs) — and keeps following the job until it has ended, so the
 * board's state is known. Each ask is handed to the cancel (`CancelledError.answer`): when the host refuses every one,
 * the cancel says so and the command is followed to its own end. Only a command with no job on the host yet, or one
 * that does not end within `graceMs` of an accepted cancel, is killed (`attempt`'s signal); so is one stopped for any
 * other reason (its lock ended). Progress lines go on to `onStderr`.
 */
export async function cancellable(attempt: (onLine: ((line: string) => void) | undefined, kill: AbortSignal | undefined) => Promise<BspResult>,
  tell: (what: string[], host: string | null) => Promise<unknown>,
  options: { onStderr?: (line: string) => void, signal?: AbortSignal, stop?: () => string[], jobArgs?: () => string[], graceMs?: number }): Promise<BspResult> {
  // `stop` and `jobArgs` are read when the cancel comes: the board's lease may have been taken again since the start.
  const { onStderr, signal, stop } = options
  if (!signal) return attempt(onStderr, undefined)
  const kill = new AbortController()
  const jobs: Array<{ id: string, host: string | null }> = []
  const told = new Set<string>()
  const once = (what: string[], host: string | null) => {
    const key = `${host ?? ''}\0${what.join(' ')}`
    if (told.has(key)) return
    told.add(key)
    ;(signal.reason as CancelledError).answer(tell(what, host))
  }
  const cancelling = () => signal.aborted && signal.reason instanceof CancelledError && !signal.reason.refused
  const cancelJob = (job: { id: string, host: string | null }) => once(['job', 'cancel', job.id, ...(options.jobArgs?.() ?? [])], job.host)
  let grace: ReturnType<typeof setTimeout> | undefined
  const aborted = () => {
    if (!cancelling()) return kill.abort(signal.reason)
    if (stop) once(stop(), null)
    for (const job of jobs) cancelJob(job)
    // Nothing started on the host yet (an upload, a call still on its way): there is nothing to follow.
    if (!jobs.length && !stop) return kill.abort(signal.reason)
    grace = setTimeout(() => kill.abort(signal.reason), options.graceMs ?? CANCEL_GRACE_MS); grace.unref?.()
    // A host that refused to stop it goes on with it: it is followed to its end, not killed halfway.
    ;(signal.reason as CancelledError).answered().catch(() => { if (grace) clearTimeout(grace); grace = undefined })
  }
  const lines = (line: string) => {
    const job = jobIn(line)
    if (job) { jobs.push(job); if (cancelling()) cancelJob(job) }
    onStderr?.(line)
  }
  signal.addEventListener('abort', aborted, { once: true })
  if (signal.aborted) aborted()
  try { return await attempt(lines, kill.signal) }
  finally { signal.removeEventListener('abort', aborted); if (grace) clearTimeout(grace) }
}

/** Start a long-lived bsp command (`dut pipe`, `watch`): its stdin and stdout are the stream; closing it stops all of it. */
export function spawnPipe(bin: string, args: string[], env: NodeJS.ProcessEnv): { stream: Duplex, stderr: () => string } {
  const child = spawn(bin, args, { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000) })
  const stream = Duplex.from({ readable: child.stdout, writable: child.stdin })
  child.on('error', error => stream.destroy(error))
  stream.on('close', () => { killGroup(child); setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS).unref() })
  return { stream, stderr: () => stderr }
}
