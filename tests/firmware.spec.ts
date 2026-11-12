/** The firmware this distribution ships in firmware/: every file matches its sha256 in firmware.json. */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFirmware } from 'boardlab-core/core/firmware.ts'

describe('shipped firmware', () => {
  it('has files that match the sha256 in firmware.json', () => {
    const shipped = readFirmware(join(import.meta.dirname, '../firmware'))
    expect(shipped.map(item => `${item.soc}/${item.purpose}`).sort()).toEqual(['k3/fsbl', 'k3/minor-board-info', 'k3/u-boot-opensbi'])
    for (const item of shipped) expect(createHash('sha256').update(readFileSync(item.path)).digest('hex')).toBe(item.sha256)
  })
})
