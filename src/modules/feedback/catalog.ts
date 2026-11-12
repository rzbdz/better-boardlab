/** Offers the feedback module to boardd: the inbox where agents file what boardlab itself should do better. */
import type { CatalogEntry } from 'boardlab-core/server/catalog.ts'
import { feedback } from './index.ts'

export const entry: CatalogEntry = {
  id: 'feedback', about: '意见箱：AI 用 boardlab 时提的请求和意见，存在 boardd 的数据库里，等维护的人处理',
  create: () => feedback(),
}
