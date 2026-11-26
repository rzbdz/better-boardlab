/** Offers the market module to boardd: the module markets this machine reads modules from, and pulling their updates. */
import type { CatalogEntry } from 'boardlab-core/server/catalog.ts'
import { market } from './index.ts'

export const entry: CatalogEntry = {
  id: 'market', about: '模块市场：从 git 仓库装的模块市场，看它们提供什么、拉取新版本（boardlab market add 加一个）',
  create: () => market,
}
