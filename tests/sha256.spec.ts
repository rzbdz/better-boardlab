import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Sha256, sha256File } from '../src/ui/sha256.ts'

const node = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const bytes = (length: number) => Uint8Array.from({ length }, (_, i) => (i * 131 + (i >> 7)) & 0xff)

describe('sha256 for files the page sends', () => {
  it('matches the standard digest at every padding edge, fed in any pieces', () => {
    expect(new Sha256().update(new TextEncoder().encode('abc')).digest()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 4097]) {
      const data = bytes(length)
      expect(new Sha256().update(data).digest(), `${length} bytes`).toBe(node(data))
      const pieces = new Sha256()
      for (let at = 0, step = 1; at < length; at += step, step = step * 3 % 97 + 1) pieces.update(data.subarray(at, at + step))
      expect(pieces.digest(), `${length} bytes in pieces`).toBe(node(data))
    }
  })

  it('hashes a file a piece at a time, saying how far it got', async () => {
    const data = bytes(9 * 1024 * 1024 + 5)
    const seen: number[] = []
    expect(await sha256File(new Blob([data]), done => seen.push(done))).toBe(node(data))
    expect(seen).toEqual([8 * 1024 * 1024, data.length])
  })
})
