import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { openDatabase } from 'boardlab-core/core/db.ts'
import { BoardLab } from 'boardlab-core/core/lab.ts'
import { createModules, type ModuleContext } from 'boardlab-core/server/catalog.ts'
import { parseConfig } from 'boardlab-core/server/config.ts'
import { CATALOG } from '../src/catalog.ts'
import { dir, useTempDir } from './helpers.ts'

useTempDir()

/** What boardd gives a catalog entry, with nothing shipped beside the tests. */
const context = (): ModuleContext => ({ stateDir: dir, shipped: () => null, timing: {}, release: { version: 'test', revision: 'test' } })
const ids = CATALOG.map(entry => entry.id)

describe('boardd configuration', () => {
  it('offers every module of this distribution once, and loads them all by default or those listed', () => {
    // This distribution ships `system`; the lab's other modules come from the public market.
    expect(ids).toEqual(['system'])
    expect(new Set(ids).size).toBe(ids.length)
    expect(Object.keys(parseConfig({}, null, ids).modules)).toEqual(ids)
    expect(parseConfig({ modules: ['system'] }, null, ids).modules).toEqual({ system: {} })
    expect(parseConfig({ timing: { boot: { firstMs: 5000 }, scan: { windowMs: 100 }, syncMs: 30000 } }, null, ids).timing).toMatchObject({ boot: { firstMs: 5000 }, scan: { windowMs: 100 }, syncMs: 30000 })
  })

  it('makes the modules selected from the catalog, with their settings, and refuses one it does not have', () => {
    const lab = new BoardLab({ db: openDatabase(join(dir, 'config.sqlite')), modules: createModules(CATALOG, { system: {} }, context()) })
    expect(lab.modules().map(item => item.id)).toEqual(['system'])
    // A module this build does not have is a configuration error naming what it does have, never a silent nothing.
    expect(() => createModules(CATALOG, { boardctrl: {} }, context())).toThrow(/没有这些模块：boardctrl（有：system）/)
    expect(() => createModules(CATALOG, { zigbee: {} }, context())).toThrow(/没有这些模块：zigbee/)
  })
})
