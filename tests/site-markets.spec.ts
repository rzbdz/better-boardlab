/** The image markets a site sets up: markets/<id>.yaml read from the site, a file that is not a market named and left out. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMarkets } from '../src/modules/bsp/markets.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boardlab-site-markets-')); mkdirSync(join(dir, 'markets')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const put = (name: string, text: string) => writeFileSync(join(dir, 'markets', name), text)

describe('site markets', () => {
  it('has none without a markets directory', () => {
    rmSync(join(dir, 'markets'), { recursive: true })
    expect(readMarkets(dir)).toEqual({ markets: [], problems: [] })
  })

  it('reads each yaml file as a market, named by its id or its file, with its kind, title and configuration', () => {
    put('one.yaml', 'kind: shelf\ntitle: One\nconfig:\n  url: https://x.example.org\n')
    put('two.yaml', 'id: second\nkind: shelf\n')
    put('notes.txt', 'ignored')
    expect(readMarkets(dir)).toEqual({
      markets: [
        { id: 'one', setup: { kind: 'shelf', title: 'One', config: { url: 'https://x.example.org' }, source: 'site' } },
        { id: 'second', setup: { kind: 'shelf', title: null, config: {}, source: 'site' } },
      ],
      problems: [],
    })
  })

  it('lists a file that is not a market with what is wrong, and still loads the others', () => {
    put('bad.yaml', '- a\n- b\n')
    put('nokind.yaml', 'id: x\n')
    put('one.yaml', 'kind: shelf\n')
    put('zdup.yaml', 'id: one\nkind: shelf\n')
    put('zconfig.yaml', 'kind: shelf\nconfig: [1]\n')
    const { markets, problems } = readMarkets(dir)
    // The broken files are listed under their file names, each with what is wrong (a second file claiming an id too).
    expect(markets.map(market => market.id)).toEqual(['bad', 'nokind', 'one', 'zconfig', 'zdup'])
    expect(markets.find(market => market.id === 'nokind')!.setup).toMatchObject({ kind: '', source: 'site', problem: expect.stringMatching(/^markets\/nokind\.yaml：要写 kind/) })
    expect(markets.find(market => market.id === 'one')!.setup.problem).toBeUndefined()
    expect(problems).toEqual([
      expect.stringMatching(/^markets\/bad\.yaml：要是一组设置/),
      expect.stringMatching(/^markets\/nokind\.yaml：要写 kind/),
      expect.stringMatching(/^markets\/zconfig\.yaml：config 要是一组设置/),
      expect.stringMatching(/^markets\/zdup\.yaml：id one 重复了/),
    ])
  })
})
