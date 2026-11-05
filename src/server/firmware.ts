/** The firmware boardd ships: firmware/firmware.json lists each file with the sha256 it must still have. */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Firmware } from '../shared/types.ts'

export function readFirmware(dir: string | undefined): Firmware[] {
  if (!dir) return []
  const manifest = join(dir, 'firmware.json')
  let raw: unknown
  try { raw = JSON.parse(readFileSync(manifest, 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error(`读不懂 ${manifest}：${(error as Error).message}`)
  }
  if (!Array.isArray(raw)) throw new Error(`${manifest} 应该是一个数组`)
  return raw.map((entry, index) => {
    const field = (name: string) => {
      const value = (entry as Record<string, unknown>)?.[name]
      if (typeof value !== 'string' || !value) throw new Error(`${manifest} 第 ${index + 1} 条缺少 ${name}`)
      return value
    }
    const note = (entry as Record<string, unknown>)?.note
    return { soc: field('soc'), purpose: field('purpose'), path: resolve(dir, field('file')), sha256: field('sha256'), note: typeof note === 'string' ? note : null }
  })
}
