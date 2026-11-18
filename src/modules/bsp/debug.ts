/**
 * A board's debug path through its board host: `bsp debug …`.
 *
 * The host owns the path (a bit-banged SWD link, a USB-JTAG probe, whatever its site provides); boardlab asks what
 * it offers and runs the actions it declares, so nothing here knows an adapter or a protocol. The session lives
 * under the board's lock: boardd holds the board's lease already, and the host reaps the session when it ends.
 */
import type { Duplex } from 'node:stream'
import type { LabConfig, BoardTarget } from 'boardlab-core/core/backend.ts'
import type { ConsoleSession } from 'boardlab-core/core/console.ts'
import { openRaw } from './console.ts'
import type { DebugPath, DebugResult } from 'boardlab-core/core/debug.ts'

/** One board's debug provider as `bsp debug status/list` reports it. */
interface BspDebug {
  dut: string, host?: string, provider: string, kinds?: string[], title?: string, about?: string,
  state?: Record<string, unknown>
}

/** What the bsp driver already knows: how to run a command on the host, and how to spawn a stream from it. */
export interface BspDebugSeams {
  run<T>(config: LabConfig, args: string[]): Promise<T>
  /** A pipe to a process on the host: its stdout/stdin, and what it said on stderr. */
  spawnStream(config: LabConfig, args: string[]): { stream: Duplex, stderr: () => string }
}

function pathOf(record: BspDebug): DebugPath {
  // The provider's own keys, as it reports them: a page shows them, it does not rename them.
  const state = Object.entries(record.state ?? {})
    .filter(([, value]) => value !== null && value !== undefined && value !== '' && value !== false)
    .map(([label, value]) => ({ label, value: typeof value === 'object' ? JSON.stringify(value) : String(value) }))
  const endpoint = typeof record.state?.endpoint === 'string' ? record.state.endpoint : null
  return {
    provider: record.provider, title: record.title ?? record.provider, about: record.about ?? '',
    kinds: record.kinds ?? [], running: !!endpoint, endpoint, state,
  }
}

export interface DebugCapabilityImpl {
  path(config: LabConfig, target: BoardTarget): Promise<DebugPath | null>
  start(config: LabConfig, target: BoardTarget): Promise<DebugPath>
  stop(config: LabConfig, target: BoardTarget): Promise<string>
  action(config: LabConfig, target: BoardTarget, action: string): Promise<DebugResult>
  stream(config: LabConfig, target: BoardTarget): Promise<ConsoleSession>
}

export function bspDebug(seams: BspDebugSeams): DebugCapabilityImpl {
  const status = (config: LabConfig, target: BoardTarget) => seams.run<BspDebug>(config, ['debug', 'status', target.device])

  return {
    async path(config, target) {
      const record = await status(config, target)
      return record.provider === 'none' ? null : pathOf(record)
    },
    async start(config, target) {
      const record = await seams.run<BspDebug & { endpoint?: string | null }>(config,
        ['debug', 'start', target.device, ...(target.lease ? ['--lease', target.lease] : [])])
      return { ...pathOf(record), running: true, endpoint: record.endpoint ?? pathOf(record).endpoint }
    },
    async stop(config, target) {
      await seams.run(config, ['debug', 'stop', target.device, ...(target.lease ? ['--lease', target.lease] : [])])
      return `${target.board}：调试会话已停止`
    },
    async action(config, target, action): Promise<DebugResult> {
      const record = await seams.run<Record<string, unknown> & BspDebug>(config,
        ['debug', 'action', target.device, action, ...(target.lease ? ['--lease', target.lease] : [])])
      const entries = Object.entries(record).filter(([key]) => !['dut', 'action', 'host', 'provider', 'kinds', 'title', 'about', 'state'].includes(key))
      return {
        message: `${target.board}：${action} 已完成`,
        data: entries.filter(([, value]) => value !== null && value !== undefined && value !== '')
          .map(([label, value]) => ({ label, value: typeof value === 'object' ? JSON.stringify(value) : String(value) })),
      }
    },
    /**
     * The session's trace bytes, as a console-like session. It is opened on boardd's side, which is where the
     * stream lives (the host's session stream), so a console provider that is a debug
     * channel reads exactly what a browser sees.
     */
    async stream(config, target): Promise<ConsoleSession> {
      const child = seams.spawnStream(config, ['debug', 'pipe', target.device])
      // Same rule as a raw console: bytes are a live stream, the CLI's error envelope is a session that never
      // opened (said now, with its reason, instead of arriving as if the board had printed it), a pipe that
      // closes without a word is that failure without the reason, and silence is a session with nothing to say yet.
      // The reason, without the console's wording around it: boardd names the debug path itself, and twice is noise.
      return openRaw(child, target.board, 'debug', undefined, true)
        .catch(error => { throw new Error((error as Error).message.replace(/^打不开 .+ 的串口：/, '')) })
    },
  }
}
