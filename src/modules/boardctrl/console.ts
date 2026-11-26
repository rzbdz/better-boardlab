/**
 * A board's console when it is not serial-mux: the provider serves plain bytes on its own socket (a trace channel
 * over a debug adapter, a network console), and `boardctrl dut pipe` carries them here. serial-mux consoles keep
 * their protocol session (`muxSession`); this one has no handshake and no backlog — what it prints is what comes.
 */
import type { Duplex } from 'node:stream'
import type { ConsoleSession } from 'boardlab-core/core/console.ts'

/** A console of raw bytes over a stream; `early` is what arrived before the first listener. */
export function rawSession(stream: Duplex, options: { alias: string, transport: string, early?: Buffer[] }): ConsoleSession {
  const outputs = new Set<(data: Buffer) => void>()
  const closes: Array<(reason: string) => void> = []
  let closed = false, ended: string | null = null
  const end = (reason: string) => { if (closed) return; closed = true; ended = reason; closes.forEach(fn => fn(reason)) }
  stream.on('data', (chunk: Buffer) => outputs.forEach(fn => fn(chunk)))
  // What a person reads on the console ("串口断开：<reason>"), so never a bare word of the stream's.
  stream.on('error', error => end(`${options.alias} 的串口连接出错：${error.message}`))
  stream.on('close', () => end(`${options.alias} 的串口连接关了`))
  stream.on('end', () => end(`${options.alias} 的串口连接关了`))
  return {
    hello: { alias: options.alias, device: null, baud: 0, transport: options.transport },
    history: [],
    send: data => { if (!closed) stream.write(Buffer.from(data)) },
    onOutput: listener => { outputs.add(listener); for (const chunk of options.early ?? []) listener(chunk); return () => outputs.delete(listener) },
    onClose: listener => { if (ended) listener(ended); else closes.push(listener) },
    close: () => { stream.end(); stream.destroy() },
  }
}

/** The CLI's failure envelope, when what came is one (`{"ok": false, "error": {message, hint}}`). */
function failure(text: string): Error | null {
  if (!text.startsWith('{')) return null
  try {
    const envelope = JSON.parse(text) as { ok?: boolean, error?: { message?: string, hint?: string } }
    if (envelope?.ok !== false || !envelope.error) return null
    const { message, hint } = envelope.error
    return new Error(`${message ?? 'the pipe reported a failure'}${hint ? `（${hint}）` : ''}`)
  } catch { return null }
}

/**
 * Open a raw console, telling a pipe that could not start from a console that is merely quiet.
 *
 * There is no handshake to fail on, so the pipe's first moments decide: output that is not JSON is the console
 * speaking and opens at once; the CLI's error envelope is a failure; a pipe that closes without a word is a
 * failure too; and a pipe that stays silent for `settleMs` is a console with nothing to say yet.
 *
 * A caller that must know whether the stream opened (`patient`) waits for the pipe instead: the pipe closes on
 * failure and only a stream that opened stays open, so silence is never taken for success — a session that is
 * being asked for on a slow host would otherwise open with its failure still on its way.
 */
export function openRaw(child: { stream: Duplex, stderr: () => string }, alias: string, transport: string,
                         settleMs = 1500, patient = false): Promise<ConsoleSession> {
  const early: Buffer[] = []
  return new Promise((resolve, reject) => {
    let settled = false, envelope: NodeJS.Timeout | null = null, idle: NodeJS.Timeout | undefined
    const done = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(idle)
      if (envelope) clearTimeout(envelope)
      child.stream.off('data', onData)
      if (error) { child.stream.destroy(); reject(new Error(`打不开 ${alias} 的串口：${error.message}`)) }
      else resolve(rawSession(child.stream, { alias, transport, early }))
    }
    const inspect = (closed: boolean, why?: string) => {
      const text = Buffer.concat(early).toString('utf8').trim()
      const failed = failure(text)
      if (failed) return done(failed)
      if (text) return done()                       // the console said something: it is alive
      if (closed) done(new Error(child.stderr().trim() || why || 'the pipe closed before the console said anything'))
    }
    const onData = (chunk: Buffer) => {
      early.push(chunk)
      // An envelope is one JSON document that may arrive in pieces; other output settles it as a console.
      if (Buffer.concat(early).toString('utf8').trim().startsWith('{')) {
        envelope ??= setTimeout(() => inspect(false), 200)
      } else inspect(false)
    }
    child.stream.on('data', onData)
    // Silent this long: a console with nothing to say yet (what comes later reaches the session's listeners).
    idle = patient ? undefined : setTimeout(() => done(), settleMs)
    // A broken pipe says why it broke only after what it managed to write: what it wrote is the reason to give.
    child.stream.once('error', error => patient ? inspect(true, error.message) : done(new Error(error.message)))
    child.stream.once('close', () => { if (!settled) inspect(true) })
    child.stream.once('end', () => { if (!settled) inspect(true) })
  })
}
