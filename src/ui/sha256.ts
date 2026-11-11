/**
 * SHA-256 for files the page sends to boardd, fed piece by piece: a flash package is too big to hold in memory at
 * once, and a page served over plain http has no `crypto.subtle`.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

export class Sha256 {
  private readonly h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  private readonly w = new Uint32Array(64)
  private readonly rest = new Uint8Array(64)
  private kept = 0
  private length = 0

  update(data: Uint8Array): this {
    this.length += data.length
    let at = 0
    if (this.kept) {
      at = Math.min(64 - this.kept, data.length)
      this.rest.set(data.subarray(0, at), this.kept)
      this.kept += at
      if (this.kept < 64) return this
      this.block(this.rest, 0)
      this.kept = 0
    }
    for (; at + 64 <= data.length; at += 64) this.block(data, at)
    if (at < data.length) { this.rest.set(data.subarray(at)); this.kept = data.length - at }
    return this
  }

  /** The digest in hex; the hash is spent afterwards. */
  digest(): string {
    const bits = this.length * 8
    const pad = new Uint8Array((this.kept < 56 ? 56 : 120) - this.kept + 8)
    pad[0] = 0x80
    const view = new DataView(pad.buffer)
    view.setUint32(pad.length - 8, Math.floor(bits / 0x100000000))
    view.setUint32(pad.length - 4, bits >>> 0)
    this.update(pad)
    return Array.from(this.h, word => word.toString(16).padStart(8, '0')).join('')
  }

  private block(data: Uint8Array, at: number) {
    const w = this.w, h = this.h
    for (let i = 0; i < 16; i++, at += 4) w[i] = (data[at]! << 24) | (data[at + 1]! << 16) | (data[at + 2]! << 8) | data[at + 3]!
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!, y = w[i - 2]!
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
      w[i] = w[i - 16]! + s0 + w[i - 7]! + s1
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, k = h[7]!
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0
      const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    h[0]! += a; h[1]! += b; h[2]! += c; h[3]! += d; h[4]! += e; h[5]! += f; h[6]! += g; h[7]! += k
  }
}

const CHUNK = 8 * 1024 * 1024

/** A file's sha256 in hex, read a piece at a time; `onRead` hears how many bytes are done. */
export async function sha256File(file: Blob, onRead?: (done: number) => void): Promise<string> {
  const hash = new Sha256()
  for (let at = 0; at < file.size; at += CHUNK) {
    hash.update(new Uint8Array(await read(file.slice(at, at + CHUNK))))
    onRead?.(Math.min(at + CHUNK, file.size))
  }
  return hash.digest()
}

function read(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}
