/** Offers the script-slots module to boardd: slots driven by scripts. */
import { number, type CatalogEntry } from 'boardlab-core/server/catalog.ts'
import { scriptRunner } from '../local/hardware.ts'
import { scriptSlots } from './index.ts'

export const entry: CatalogEntry = {
  id: 'script-slots', about: '脚本驱动的槽位（需要 local）',
  create: settings => scriptSlots({ runner: scriptRunner, timeoutMs: number(settings, 'timeoutMs') }),
}
