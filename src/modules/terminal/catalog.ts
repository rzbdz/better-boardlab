/**
 * Offers the terminal module to boardd. It gives a shell as boardd's user to whoever can open the page, so it is off
 * until boardd's configuration turns it on: { "terminal": { "enabled": true } }.
 */
import type { CatalogEntry } from 'boardlab-core/server/catalog.ts'
import { terminal } from './index.ts'

export const entry: CatalogEntry = {
  id: 'terminal', about: '网页里的终端：boardd 机器上的 tmux 会话（要在 boardd.json 里 enabled: true 才开）',
  create: (settings, context) => settings.enabled === true
    ? terminal({ stateDir: context.stateDir, tmux: typeof settings.tmux === 'string' ? settings.tmux : undefined, python: typeof settings.python === 'string' ? settings.python : undefined })
    : { id: 'terminal-off', title: '终端（未开启）', setup: () => ({}) },
}
