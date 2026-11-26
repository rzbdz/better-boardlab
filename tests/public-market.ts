/**
 * The page parts a machine actually loads, for the frontend tests: the public module market's modules that bring views
 * (the notification bus, the console watchers, the request inbox, the market's own page). A boardd on such a machine answers
 * `api/module-markets` with them, and the page imports each one at load (see `ui/market-ui.ts`).
 *
 * The tests mount them beside this build's own views, so a tab that moved to the market is still the tab a person sees —
 * and a module whose page part no longer loads is a test failure here, not a page that silently lost a tab.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ModuleUi } from '../src/ui/contract.ts'

/**
 * Where the public market is: beside this checkout, as a sibling directory, or wherever `BOARDLAB_PUB_MARKET` names it
 * (the chain test reads the same). By the test run's own directory, since a frontend test's `import.meta.url` is the
 * runner's served URL, not a path.
 */
export const PUB_MARKET = process.env.BOARDLAB_PUB_MARKET ?? resolve(process.cwd(), '..', 'boardlab-modules-pub')

/** The modules of that market the frontend tests draw, and the page part each one brings. */
export const MARKET_PAGES = [
  { id: 'alerts', ui: 'alerts/ui.js' },
  { id: 'console-watch', ui: 'console-watch/ui.js' },
  { id: 'human', ui: 'human/ui.js' },
  { id: 'feedback', ui: 'feedback/ui.js' },
  { id: 'market', ui: 'market/ui.js' },
  { id: 'terminal', ui: 'terminal/ui.js' },
  // The lab itself: the boards on this machine and their scan, and the boardctrl hosts' own pages.
  { id: 'local', ui: 'local/ui.js' },
  { id: 'boardctrl', ui: 'boardctrl/ui.js' },
  { id: 'home-assistant', ui: 'home-assistant/ui.js' },
  { id: 'script-slots', ui: 'script-slots/ui.js' },
]

/** The page parts, imported as the browser imports them. */
export async function marketModuleUis(): Promise<ModuleUi[]> {
  const out: ModuleUi[] = []
  for (const page of MARKET_PAGES) {
    const file = join(PUB_MARKET, page.ui)
    if (!existsSync(file)) continue
    // Through the test runner's own loader, by path: a plain file URL is not one it resolves (a browser's page gets the
    // file from boardd at `/module-ui/<module>/<ui>`, which only a machine running that market has).
    const loaded = await import(/* @vite-ignore */ file) as { ui?: ModuleUi, default?: ModuleUi }
    const ui = loaded.ui ?? loaded.default
    if (ui) out.push(ui)
  }
  return out
}

/** What `api/module-markets` answers on such a machine: the pages above, which the page then imports. */
export const marketPagesAnswer = {
  markets: [{ id: 'pub', url: 'git@github.com:rzbdz/boardlab-modules-pub.git', branch: null, commit: '0'.repeat(40), modules: MARKET_PAGES, problems: [] }],
  pages: MARKET_PAGES.map(page => ({ id: page.id, ui: page.ui })),
  problems: [],
}
