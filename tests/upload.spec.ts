// @vitest-environment jsdom
/** The browser's uploader: pieces of the size boardd gives, a broken piece resumed from what arrived, and an upload given up. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { uploadFile } from '../src/ui/upload.ts'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
afterEach(() => { vi.restoreAllMocks() })

/** A boardd that takes pieces of 10 bytes and keeps what arrived, failing the pieces `fail` says to (half arrives). */
function boardd(fail: (offset: number, attempt: number) => 'drop' | 'refuse' | 'busy' | null) {
  let received = 0
  const asked: string[] = [], tries = new Map<number, number>()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost/'), method = init?.method ?? 'GET'
    asked.push(`${method} ${url.pathname.slice(1)}${url.search}`)
    if (url.pathname === '/api/files/uploads') return json({ id: 'u1', piece: 10 })
    if (url.pathname === '/api/files/uploads/u1/seal') return json({ sha256: 'cd'.repeat(32), size: received, name: 'f.bin' })
    if (url.pathname === '/api/files/uploads/u1/abandon') return json({ ok: true })
    if (method === 'GET') return json({ received })
    const offset = Number(url.searchParams.get('offset')), size = (init!.body as Blob).size
    const attempt = (tries.get(offset) ?? 0) + 1; tries.set(offset, attempt)
    const what = fail(offset, attempt)
    if (what === 'drop') { received = offset + Math.floor(size / 2); throw new TypeError('network error') }
    if (what === 'refuse') return json({ error: '续传位置不对' }, 400)
    // The first send of this piece is still being written: boardd refuses this one, then the first lands.
    if (what === 'busy') { received = offset + size; return json({ error: '这个上传正有一片在写', code: 'conflict' }, 409) }
    received = offset + size
    return json({ received, size: 25 })
  })
  return asked
}

describe('uploadFile', () => {
  it('sends the file in the pieces boardd asks for and has boardd seal it', async () => {
    const asked = boardd(() => null)
    const seen: number[] = []
    expect(await uploadFile(new File([new Uint8Array(25)], 'f.bin'), p => seen.push(p.sent))).toEqual({ sha256: 'cd'.repeat(32), size: 25, name: 'f.bin' })
    expect(asked).toEqual(['POST api/files/uploads', 'PUT api/files/uploads/u1?offset=0', 'PUT api/files/uploads/u1?offset=10', 'PUT api/files/uploads/u1?offset=20', 'POST api/files/uploads/u1/seal'])
    expect(seen).toEqual([0, 10, 20, 25])
  })

  it('goes on from what arrived after a piece broke off', async () => {
    const asked = boardd((offset, attempt) => offset === 10 && attempt === 1 ? 'drop' : null)
    await uploadFile(new File([new Uint8Array(25)], 'f.bin'))
    // Half of the second piece arrived: boardd says 15, and the next piece starts there.
    expect(asked).toEqual(['POST api/files/uploads', 'PUT api/files/uploads/u1?offset=0', 'PUT api/files/uploads/u1?offset=10', 'GET api/files/uploads/u1',
      'PUT api/files/uploads/u1?offset=15', 'PUT api/files/uploads/u1?offset=20', 'POST api/files/uploads/u1/seal'])
  }, 10_000)

  it('waits for a piece boardd is still writing, and goes on from where it ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const asked = boardd((offset, attempt) => offset === 10 && attempt === 1 ? 'busy' : null)
      const done = uploadFile(new File([new Uint8Array(25)], 'f.bin'))
      await vi.runAllTimersAsync()
      await done
      // The repeated piece was refused, not appended twice: boardd says the first one landed, and the next starts after it.
      expect(asked).toEqual(['POST api/files/uploads', 'PUT api/files/uploads/u1?offset=0', 'PUT api/files/uploads/u1?offset=10', 'GET api/files/uploads/u1',
        'PUT api/files/uploads/u1?offset=20', 'POST api/files/uploads/u1/seal'])
    } finally { vi.useRealTimers() }
  })

  it('gives up after a few tries and has boardd drop what arrived', async () => {
    const asked = boardd(() => 'drop')
    await expect(uploadFile(new File([new Uint8Array(25)], 'f.bin'))).rejects.toThrow(/network error/)
    expect(asked.at(-1)).toBe('POST api/files/uploads/u1/abandon')
  }, 15_000)
})
