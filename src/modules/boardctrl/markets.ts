/**
 * The image markets a site sets up: `markets/<id>.yaml` in the site, each `{ id, kind, title?, config }`. Which servers,
 * repositories and directories there are is the site's; the modules that offer a kind of market only know the kind.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { MarketSetup } from 'boardlab-core/core/markets.ts'

export interface SiteMarkets { markets: Array<{ id: string, setup: MarketSetup }>, problems: string[] }

/** A market id from a file name that is not a market: listed with what is wrong, so the page shows it. */
const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** The markets of the site at `dir`, and what is wrong with the files that are not markets (a market with a bad file is left out). */
export function readMarkets(dir: string): SiteMarkets {
  const found: SiteMarkets = { markets: [], problems: [] }
  const at = join(dir, 'markets')
  if (!existsSync(at)) return found
  for (const name of readdirSync(at).filter(file => file.endsWith('.yaml')).sort()) {
    try {
      const data = parse(readFileSync(join(at, name), 'utf8')) as Record<string, unknown> | null
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('要是一组设置')
      const id = String(data.id ?? name.replace(/\.yaml$/, ''))
      if (typeof data.kind !== 'string' || !data.kind) throw new Error('要写 kind（市场的种类）')
      const config = data.config ?? {}
      if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new Error('config 要是一组设置')
      if (found.markets.some(market => market.id === id)) throw new Error(`id ${id} 重复了`)
      found.markets.push({ id, setup: { kind: data.kind, title: typeof data.title === 'string' ? data.title : null, config: config as Record<string, unknown>, source: 'site' } })
    } catch (error) {
      const problem = `markets/${name}：${(error as Error).message}`
      found.problems.push(problem)
      // Listed as a market that cannot be used, under its file's name when that is one, so a broken file never just disappears.
      const id = name.replace(/\.yaml$/, '')
      if (FILE_ID.test(id) && !found.markets.some(market => market.id === id)) found.markets.push({ id, setup: { kind: '', title: id, config: {}, source: 'site', problem } })
    }
  }
  return found
}
