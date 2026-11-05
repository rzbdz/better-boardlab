/** Typed boardd client over its Unix socket, shared by the CLI and the DSH plugin. */
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  BoardDetail, HaDiscovery, HaSettings, Lease, LockResult, Scan, SendResult, Slot, State,
} from './types.ts'

export const DEFAULT_PORT = 38127

export function defaultStateDir(): string {
  return process.env.BOARDS_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'troy-boards')
}

export const socketPathFor = (stateDir: string) => join(stateDir, 'boardd.sock')

export class BoardsApiError extends Error {
  constructor(readonly status: number, message: string, readonly code: string | null) { super(message) }
}

export class BoardsClient {
  constructor(readonly socketPath = socketPathFor(defaultStateDir()), readonly holder?: string) {}

  call<T>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const req = request({
        socketPath: this.socketPath, method, path, signal,
        headers: { ...(this.holder ? { 'x-boards-holder': this.holder } : {}), ...(payload ? { 'Content-Type': 'application/json' } : {}) },
      }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if ((response.statusCode ?? 500) >= 400) {
            let parsed: { error?: string, code?: string } = {}
            try { parsed = JSON.parse(text) } catch {}
            return reject(new BoardsApiError(response.statusCode ?? 500, parsed.error ?? text, parsed.code ?? null))
          }
          resolve((response.headers['content-type'] ?? '').startsWith('application/json') ? JSON.parse(text) : text as T)
        })
      })
      req.on('error', error => reject((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ECONNREFUSED'
        ? new BoardsApiError(503, `boardd 没有运行（${this.socketPath}）`, 'unavailable') : error))
      if (payload) req.write(payload)
      req.end()
    })
  }

  state() { return this.call<State>('GET', '/api/state') }
  board(name: string) { return this.call<BoardDetail>('GET', `/api/board?name=${encodeURIComponent(name)}`) }
  lock(board: string, purpose: string, queue: 'none' | 'join' | 'wait' = 'none', signal?: AbortSignal) { return this.call<LockResult>('POST', '/api/lock', { board, purpose, queue }, signal) }
  unqueue(board: string) { return this.call<{ ok: true }>('POST', '/api/unqueue', { board }) }
  unlock(board: string, token?: string | null) { return this.call<{ ok: true }>('POST', '/api/unlock', { board, token }) }
  steal(board: string, reason: string) { return this.call<LockResult>('POST', '/api/steal', { board, reason }) }
  reset(board: string, token?: string | null) { return this.call<{ ok: true }>('POST', '/api/reset', { board, token }) }
  fastboot(board: string, token?: string | null) { return this.call<{ ok: true }>('POST', '/api/fastboot', { board, token }) }
  send(board: string, input: { die?: string, text: string, newline?: boolean, wait?: string, timeoutMs?: number, token?: string | null }) { return this.call<SendResult>('POST', '/api/send', { board, ...input }) }
  log(board: string, die?: string, lines = 200) { return this.call<{ lines: string[] }>('GET', `/api/log?board=${encodeURIComponent(board)}${die ? `&die=${encodeURIComponent(die)}` : ''}&lines=${lines}`) }
  stage(board: string, firmware: string, die?: string, token?: string | null) { return this.call<{ output: string }>('POST', '/api/stage', { board, firmware, die, token }) }
  boot(board: string, files: string[], die?: string, token?: string | null) { return this.call<{ output: string }>('POST', '/api/boot', { board, files, die, token }) }
  scan(input: { slots?: number[], boards?: string[], confirmed: boolean }) { return this.call<Scan>('POST', '/api/scan', input) }
  scanStatus(id: string) { return this.call<Scan>('GET', `/api/scan?id=${encodeURIComponent(id)}`) }
  cancelScan(id: string) { return this.call<{ ok: true }>('POST', '/api/scan/cancel', { id }) }
  resolveProposals(ids: string[], decision: 'apply' | 'reject', names?: Record<string, string>) { return this.call<{ ok: true }>('POST', '/api/proposals', { ids, decision, names }) }
  saveScriptSlot(input: { slot: number, label?: string | null, resetScript: string, fastbootScript?: string | null }) { return this.call<Slot>('POST', '/api/slots/script', input) }
  removeScriptSlot(slot: number) { return this.call<{ ok: true }>('POST', '/api/slots/script/remove', { slot }) }
  configureHa(url: string, token?: string) { return this.call<HaSettings>('POST', '/api/ha', { url, token }) }
  testHa() { return this.call<HaSettings>('POST', '/api/ha/test') }
  removeBoard(name: string) { return this.call<{ ok: true }>('POST', '/api/boards/remove', { name }) }
  exportToml() { return this.call<string>('GET', '/api/export.toml') }
}
