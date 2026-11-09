import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { openDatabase } from 'boardlab-core/core/db.ts'
import { BoardLab } from 'boardlab-core/core/lab.ts'
import { createModules, type ModuleContext } from 'boardlab-core/server/catalog.ts'
import { parseConfig } from 'boardlab-core/server/config.ts'
import { CATALOG } from '../src/catalog.ts'
import { dir, useTempDir } from './fakes.ts'

useTempDir()

/** What boardd gives a catalog entry, with nothing shipped beside the tests. */
const context = (): ModuleContext => ({ stateDir: dir, shipped: () => null, timing: {} })
const ids = CATALOG.map(entry => entry.id)

describe('boardd configuration', () => {
  it('offers every module of this distribution once, and loads them all by default or those listed', () => {
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(expect.arrayContaining(['local', 'home-assistant', 'script-slots', 'bsp']))
    expect(Object.keys(parseConfig({}, null, ids).modules)).toEqual(ids)
    expect(parseConfig({ modules: ['bsp'] }, null, ids).modules).toEqual({ bsp: {} })
    expect(parseConfig({ timing: { boot: { firstMs: 5000 }, scan: { windowMs: 100 }, syncMs: 30000 } }, null, ids).timing).toMatchObject({ boot: { firstMs: 5000 }, scan: { windowMs: 100 }, syncMs: 30000 })
  })

  it('makes the modules selected from the catalog, with their settings, under the names a site knows its hosts by', () => {
    // A lab server with only remote hosts: two bsp board hosts.
    const lab = new BoardLab({ db: openDatabase(join(dir, 'config.sqlite')), modules: createModules(CATALOG, { bsp: { instances: ['site-a', 'site-b'] } }, context()) })
    expect(lab.modules().map(item => item.id)).toEqual(['bsp'])
    expect(lab.backends.labSettings().map(item => item.id)).toEqual(['site-a', 'site-b'])
    expect(() => createModules(CATALOG, { bsp: { instances: ['bad name'] } }, context())).toThrow(/模块 bsp 的设置不对/)
    expect(() => createModules(CATALOG, { 'script-slots': { timeoutMs: 'soon' } }, context())).toThrow(/模块 script-slots 的设置不对/)
    expect(() => createModules(CATALOG, { zigbee: {} }, context())).toThrow(/没有这些模块：zigbee/)
    // Modules come in catalog order whatever order they are listed in, so those others need come first.
    expect(createModules(CATALOG, { 'script-slots': {}, 'home-assistant': {}, local: {} }, context()).map(item => item.id)).toEqual(['local', 'home-assistant', 'script-slots'])
  })
})
