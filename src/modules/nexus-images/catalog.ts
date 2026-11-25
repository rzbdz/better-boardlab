/** Offers the nexus-images module to boardd: image markets over a Nexus raw repository. */
import type { CatalogEntry } from 'boardlab-core/server/catalog.ts'
import { nexusImages } from './index.ts'

export const entry: CatalogEntry = {
  id: 'nexus-images', about: 'Nexus raw 仓库的镜像市场（市场本身在站点或设置里配）',
  create: () => nexusImages(),
}
