/**
 * Sending a local file to boardd from the browser, for every frontend: in pieces of at most what boardd says (8 MiB),
 * each from exactly where the last one stopped, resuming after a piece that failed, and sealed at the end by boardd,
 * which hashes the file itself — the browser never reads gigabytes into memory or hashes them.
 */
import { ApiError, call, identity } from './api.ts'

export interface UploadProgress { sent: number, size: number }
export interface Uploaded { sha256: string, size: number, name: string }

const TRIES = 4

async function putPiece(id: string, offset: number, piece: Blob, signal?: AbortSignal): Promise<{ received: number }> {
  const user = identity.get()
  const response = await fetch(`api/files/uploads/${encodeURIComponent(id)}?offset=${offset}`, {
    method: 'PUT', body: piece, signal, headers: { 'Content-Type': 'application/octet-stream', ...(user ? { 'X-Boards-User': user } : {}) },
  })
  const text = await response.text()
  if (!response.ok) { let message = text; try { message = JSON.parse(text).error ?? text } catch {} throw new ApiError(response.status, message) }
  return JSON.parse(text)
}

/** Send `file` and return the sha256 boardd keeps it under. `onProgress` is told after every piece. */
export async function uploadFile(file: Blob & { name?: string }, onProgress: (progress: UploadProgress) => void = () => {}, signal?: AbortSignal): Promise<Uploaded> {
  const name = file.name || 'file'
  const { id, piece } = await call<{ id: string, piece: number }>('POST', 'api/files/uploads', { name, size: file.size })
  try {
    let sent = 0
    onProgress({ sent, size: file.size })
    while (sent < file.size) {
      if (signal?.aborted) throw new DOMException('上传取消了', 'AbortError')
      const end = Math.min(file.size, sent + piece)
      let tries = 0
      for (;;) {
        try { sent = (await putPiece(id, sent, file.slice(sent, end), signal)).received; break }
        catch (error) {
          // 409: boardd is still writing the piece this one repeats (the first broke off on the way back); wait for it.
          if (signal?.aborted || ++tries >= TRIES || (error instanceof ApiError && error.status < 500 && error.status !== 400 && error.status !== 409)) throw error
          // A piece that broke off: ask how much arrived and go on from there.
          await new Promise(resolve => setTimeout(resolve, (error instanceof ApiError && error.status === 409 ? 2000 : 500) * tries))
          sent = (await call<{ received: number }>('GET', `api/files/uploads/${encodeURIComponent(id)}`)).received
          if (sent >= end) break
        }
      }
      onProgress({ sent, size: file.size })
    }
    // A seal that meets the last piece still being written (its first send broke off) waits for it.
    let sealed: { sha256: string, size: number, name: string }
    for (let tries = 1; ; tries++) {
      try { sealed = await call('POST', `api/files/uploads/${encodeURIComponent(id)}/seal`, {}); break }
      catch (error) { if (signal?.aborted || tries >= TRIES || !(error instanceof ApiError && error.status === 409)) throw error; await new Promise(resolve => setTimeout(resolve, 2000 * tries)) }
    }
    return { sha256: sealed.sha256, size: sealed.size, name: sealed.name }
  } catch (error) {
    // Given up, or cancelled: what arrived is of no use to anyone.
    void call('POST', `api/files/uploads/${encodeURIComponent(id)}/abandon`, {}).catch(() => {})
    throw error
  }
}
