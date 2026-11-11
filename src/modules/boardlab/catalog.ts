/** Offers the boardlab module to boardd: other boardds (on the board hosts) as backends, one per instance. */
import { instances, type CatalogEntry } from 'boardlab-core/server/catalog.ts'
import { boardlabHosts } from './index.ts'

export const entry: CatalogEntry = {
  id: 'boardlab', about: '其他 boardd（板卡主机上的 boardlab）：一台一个实例（instances），转发到它们',
  // No host by default: a hub names its hosts in boardd.json, e.g. { "boardlab": { "instances": ["lab1", "lab2"] } }.
  create: settings => boardlabHosts({ instances: settings.instances === undefined ? [] : instances(settings, 'lab1') }),
}
