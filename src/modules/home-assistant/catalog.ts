/** Offers the home-assistant module to boardd: slots on a Home Assistant controller. */
import type { CatalogEntry } from 'boardlab-core/server/catalog.ts'
import { homeAssistant as client } from './client.ts'
import { homeAssistant } from './index.ts'

export const entry: CatalogEntry = { id: 'home-assistant', about: 'Home Assistant 控制器上的槽位（需要 local）', create: () => homeAssistant({ client }) }
