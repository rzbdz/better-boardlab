/**
 * Firmware a release ships in firmware/ matches each file's sha256 in firmware.json. A distribution may ship none — a
 * vendor's firmware comes from a module's market — and what it does ship must be what its manifest says.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFirmware } from 'boardlab-core/core/firmware.ts'

describe('shipped firmware', () => {
  it('has files that match the sha256 in firmware.json', () => {
    const dir = join(import.meta.dirname, '../firmware')
    const shipped = readFirmware(dir)
    if (!existsSync(join(dir, 'firmware.json'))) return expect(shipped).toEqual([])
    for (const item of shipped) expect(createHash('sha256').update(readFileSync(item.path)).digest('hex')).toBe(item.sha256)
  })
})
