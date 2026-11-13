/** Offers the human module to boardd: the requests agents make for work only a person at the bench can do. */
import type { CatalogEntry } from 'boardlab-core/server/catalog.ts'
import { human } from './index.ts'

export const entry: CatalogEntry = {
  id: 'human', about: '人工请求：AI 请人插拔线、接板子、按按钮；人在页面上点「我做好了」或「做不了」，请求方等到结果',
  create: () => human(),
}
