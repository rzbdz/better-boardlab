/**
 * The `market` module: the module markets this boardlab reads modules from, as the page sees them, and the one
 * operation a page can do to them — pull a market's newest version. Adding and removing a market change what the next
 * boardd process loads, so those stay with the CLI (`boardlab market add|remove`); updating is a git fetch, and a
 * running boardd keeps loading what it started with, so the page can do it and say "restart to apply".
 *
 * A market is a git repository of module packages (see `boardlab-core/core/module-markets.ts`). boardd clones each
 * under its state directory and imports the modules the configuration selects. What a market offers is its manifest,
 * never code that has run: the page lists ids, titles, tags and what each module needs and offers.
 *
 * The view is in `ui.ts`; the endpoints here are what it reads and the one thing it does.
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BoardError } from 'boardlab-core/core/errors.ts'
import type { Module } from 'boardlab-core/core/module.ts'
import { isHuman } from 'boardlab-core/core/text.ts'
import { marketsOnDisk, readMarket, readRecords, syncMarket, writeRecords, type MarketModule } from 'boardlab-core/core/module-markets.ts'

/** A market as the page lists it: a record, and what its copy says now. */
export interface MarketView {
  id: string
  url: string
  branch: string | null
  commit: string | null
  modules: MarketModule[]
  problems: string[]
}

/** A module from any market, as the page searches them: `market/id` tells two markets' modules apart. */
export interface SearchHit extends MarketModule { ref: string }

export interface MarketState { markets: MarketView[], problems: string[] }

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Git's own environment for a market fetch: no prompt (a private market's key is in this machine's configuration), a C locale. */
const GIT_ENV = { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' }

/** The markets on disk, each with what its copy says now (the CLI's own read, so the page and the CLI agree). */
function list(stateDir: string): MarketState {
  const { markets, problems } = marketsOnDisk(stateDir)
  return { markets: markets.map(({ modules, problems: readProblems, ...record }): MarketView => ({ ...record, modules, problems: readProblems })), problems }
}

export const market: Module<{ list: typeof list }> = {
  id: 'market',
  title: '模块市场',
  about: '从 git 仓库装的模块市场：看它们提供什么，拉取新版本（boardlab market add 加一个）',
  tags: ['module', 'market', 'own'],
  setup(lab, ctx) {
    const stateDir = ctx.stateDir
    lab.api.add('market', [
      {
        method: 'GET', path: '/api/market',
        about: '装了哪些模块市场，各自提供什么模块（id、说明、标签、要什么给什么），以及复制品有什么问题',
        handle: () => list(stateDir),
      },
      {
        method: 'GET', path: '/api/market/search',
        about: '在装了的模块市场里按名字、说明和标签找模块（?text=）',
        handle: ({ query }) => {
          const text = (query.get('text') ?? '').trim().toLowerCase()
          const hits: SearchHit[] = []
          if (text) for (const market of list(stateDir).markets) {
            for (const module of market.modules) {
              if (`${module.id} ${module.title} ${module.about} ${module.tags.join(' ')}`.toLowerCase().includes(text)) hits.push({ ...module, ref: `${market.id}/${module.id}` })
            }
          }
          return { hits }
        },
      },
      {
        method: 'POST', path: '/api/market/update',
        about: '拉取一些模块市场的新版本（body: {id} 一个，或省略为全部）；改了什么会列出来，重启 boardd 后生效',
        handle: async ({ body, caller }) => {
          if (!isHuman(caller.holder)) throw new BoardError('forbidden', '拉取模块市场要人来做：换掉的是所有在这台机器上运行的东西')
          const raw = (body ?? {}) as { id?: unknown }
          const id = typeof raw.id === 'string' ? raw.id : null
          const { records } = readRecords(stateDir)
          const chosen = id ? records.filter(record => record.id === id) : records
          if (!chosen.length) throw new BoardError('invalid', id ? `没有模块市场 ${id}` : '还没有模块市场：boardlab market add <市场> <git 地址>')
          const changed: Array<{ id: string, from: string | null, to: string, added: string[], updated: string[], removed: string[], problems: string[] }> = []
          let next = [...records]
          for (const record of chosen) {
            const copy = join(stateDir, 'markets', record.id)
            const before = existsSync(join(copy, 'market.json')) ? readMarket(record.id, copy) : { modules: [], problems: [] }
            const synced = await syncMarket(stateDir, record.id, { url: record.url, branch: record.branch, env: GIT_ENV })
            const after = readMarket(record.id, synced.dir)
            const known = new Map(before.modules.map(module => [module.id, module.digest]))
            const now = new Map(after.modules.map(module => [module.id, module.digest]))
            changed.push({
              id: record.id, from: record.commit, to: synced.commit,
              added: [...now.keys()].filter(key => !known.has(key)),
              updated: [...now.keys()].filter(key => known.has(key) && known.get(key) !== now.get(key)),
              removed: [...known.keys()].filter(key => !now.has(key)),
              problems: after.problems,
            })
            next = next.map(item => item.id === record.id ? { ...item, commit: synced.commit } : item)
            writeRecords(stateDir, next)
          }
          const differs = changed.some(item => item.from !== item.to)
          return { changed, restart: differs, message: differs ? '拉到了新版本：重启 boardd 后生效' : '已经是最新的' }
        },
      },
      {
        method: 'POST', path: '/api/market/remove',
        about: '删掉一个模块市场（body: {id, yes}）：它在本机的复制品一起删掉，配置里从它装的模块下次启动就没有了',
        handle: async ({ body, caller }) => {
          if (!isHuman(caller.holder)) throw new BoardError('forbidden', '删模块市场要人来做')
          const raw = (body ?? {}) as { id?: unknown, yes?: unknown }
          const id = typeof raw.id === 'string' ? raw.id : ''
          if (!ID.test(id)) throw new BoardError('invalid', `市场名不对：${id}`)
          if (raw.yes !== true) throw new BoardError('invalid', `删掉市场 ${id} 和它在本机的复制品？这会让配置里从它装的模块下次启动就没了。确认请带上 yes`)
          const { records } = readRecords(stateDir)
          if (!records.some(record => record.id === id)) throw new BoardError('invalid', `没有模块市场 ${id}`)
          writeRecords(stateDir, records.filter(record => record.id !== id))
          rmSync(join(stateDir, 'markets', id), { recursive: true, force: true })
          return { removed: id, message: `删了模块市场 ${id}：重启 boardd 后生效` }
        },
      },
    ])
    return { list }
  },
}
