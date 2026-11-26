/**
 * The market module: module markets are git repositories, and the page shows the ones this machine has — what each
 * offers, which of those boardd loaded — and can pull their newest versions. Adding a market is the CLI's job.
 *
 * A real git repository stands in for a market (a real `git init`), so the chain the page depends on — CLI-added
 * market → boardd's copy → manifest read → page API → update — is the one exercised.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from 'boardlab-core/core/db.ts'
import { BoardLab } from 'boardlab-core/core/lab.ts'
import { market, type MarketState } from '../src/modules/market/index.ts'
import { dir, useTempDir } from './fakes.ts'

useTempDir()

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.org', ...args], { cwd, encoding: 'utf8' }).trim()

/** A market repository: `probe` adds nothing, it is only listed. */
function marketRepo(name: string): string {
  const at = join(dir, name)
  mkdirSync(join(at, 'probe'), { recursive: true })
  writeFileSync(join(at, 'market.json'), JSON.stringify({ modules: [{ id: 'probe', title: '探针', tags: ['content'], inject: [], provide: [] }] }))
  writeFileSync(join(at, 'probe/module.js'), 'export default { id: "probe", title: "探针", setup: () => ({}) }')
  git(at, 'init', '-q', '-b', 'main'); git(at, 'add', '-A'); git(at, 'commit', '-q', '-m', 'market')
  return at
}

async function call(lab: BoardLab, method: 'GET' | 'POST', path: string, body: Record<string, unknown> = {}, holder = 'user:dana'): Promise<any> {
  const url = new URL(path, 'http://boardd')
  const found = lab.api.match(method, url.pathname)
  if (!found) throw new Error(`no ${method} ${url.pathname}`)
  return found.endpoint.handle({ query: url.searchParams, params: found.params, body, caller: { holder, local: true } } as never)
}

/** A boardd with the market module, over `dir`. */
const labAt = (sub: string) => new BoardLab({ db: openDatabase(join(dir, `${sub}.sqlite`)), stateDir: dir, modules: [market] })

describe('the module market on the page', () => {
  it('lists the markets the CLI added, with what each offers and which of it boardd loaded', async () => {
    const lab = labAt('list')
    // The CLI writes the record and clones the market; the page reads the same files, so a market added on the
    // command line shows up without asking boardd again.
    expect(await call(lab, 'GET', '/api/market')).toEqual({ markets: [], problems: [] })
    const repo = marketRepo('listed')
    const { syncMarket } = await import('boardlab-core/core/module-markets.ts')
    const synced = await syncMarket(dir, 'pub', { url: repo })
    writeFileSync(join(dir, 'markets.json'), JSON.stringify({ markets: [{ id: 'pub', url: repo, branch: null, commit: synced.commit }] }))
    const after = await call(lab, 'GET', '/api/market') as MarketState
    expect(after.markets).toHaveLength(1)
    expect(after.markets[0]).toMatchObject({ id: 'pub', url: repo, modules: [{ id: 'probe', title: '探针', tags: ['content'] }] })
    expect(after.markets[0]!.problems).toEqual([])
  })

  it('pulls a market to its newest commit and says what changed, and a person is the one who may', async () => {
    const lab = labAt('update')
    const repo = marketRepo('updated')
    const { syncMarket } = await import('boardlab-core/core/module-markets.ts')
    const first = await syncMarket(dir, 'up', { url: repo })
    writeFileSync(join(dir, 'markets.json'), JSON.stringify({ markets: [{ id: 'up', url: repo, branch: null, commit: first.commit }] }))
    // The market moves on: a second module appears.
    mkdirSync(join(repo, 'extra'), { recursive: true })
    const manifest = JSON.parse(execFileSync('cat', [join(repo, 'market.json')], { encoding: 'utf8' })) as { modules: unknown[] }
    manifest.modules.push({ id: 'extra', title: '新模块' })
    writeFileSync(join(repo, 'market.json'), JSON.stringify(manifest))
    writeFileSync(join(repo, 'extra/module.js'), 'export default { id: "extra", title: "新模块", setup: () => ({}) }')
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'more')
    // An agent may not swap what runs on the machine.
    await expect(call(lab, 'POST', '/api/market/update', {}, 'claude:task-1')).rejects.toMatchObject({ code: 'forbidden' })
    const pulled = await call(lab, 'POST', '/api/market/update', {}) as { changed: Array<{ added: string[] }>, restart: boolean, message: string }
    expect(pulled.changed[0]!.added).toEqual(['extra'])
    expect(pulled.restart).toBe(true)
    expect(pulled.message).toMatch(/重启 boardd/)
    // Pulling again is a no-op that says so.
    expect(await call(lab, 'POST', '/api/market/update', {})).toMatchObject({ restart: false })
  })

  it('searches across the markets by name, description and tag', async () => {
    const lab = labAt('search')
    const repo = marketRepo('searched')
    const { syncMarket } = await import('boardlab-core/core/module-markets.ts')
    const synced = await syncMarket(dir, 'sh', { url: repo })
    writeFileSync(join(dir, 'markets.json'), JSON.stringify({ markets: [{ id: 'sh', url: repo, branch: null, commit: synced.commit }] }))
    const hit = await call(lab, 'GET', '/api/market/search?text=探针') as { hits: Array<{ ref: string }> }
    expect(hit.hits.map(item => item.ref)).toEqual(['sh/probe'])
    expect((await call(lab, 'GET', '/api/market/search?text=zzz')).hits).toEqual([])
  })

  it('removes a market only with a person saying yes, and takes its copy with it', async () => {
    const lab = labAt('remove')
    const repo = marketRepo('removed')
    const { syncMarket } = await import('boardlab-core/core/module-markets.ts')
    const synced = await syncMarket(dir, 'rm', { url: repo })
    writeFileSync(join(dir, 'markets.json'), JSON.stringify({ markets: [{ id: 'rm', url: repo, branch: null, commit: synced.commit }] }))
    await expect(call(lab, 'POST', '/api/market/remove', { id: 'rm' }, 'claude:task-1')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(call(lab, 'POST', '/api/market/remove', { id: 'rm' })).rejects.toMatchObject({ code: 'invalid' })
    expect(await call(lab, 'POST', '/api/market/remove', { id: 'rm', yes: true })).toMatchObject({ removed: 'rm' })
    expect((await call(lab, 'GET', '/api/market') as MarketState).markets).toEqual([])
  })
})
