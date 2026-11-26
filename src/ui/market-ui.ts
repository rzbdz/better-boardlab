/**
 * The page parts of modules from a market: each module's `ui` file, imported by the page at load, so its views are
 * rendered beside the ones built into a frontend. A market module is not in the frontend's build, so its file imports
 * `boardlab/ui` — the import map a frontend's index.html carries points that at boardd's `sdk.browser.js`.
 *
 * Which modules bring a page part, and where each one's file is served from, comes from boardd (`/api/module-markets`).
 * A file that fails to load costs its module its views and nothing else: the page says so in the console and goes on.
 */
import type { ModuleUi } from './contract.ts'

export interface MarketUi { id: string, url: string }

/** The page parts the markets bring, imported. One whose file does not load costs its module its views and nothing else. */
export async function marketUis(): Promise<Array<MarketUi & { ui: ModuleUi }>> {
  const parts = await load()
  const out: Array<MarketUi & { ui: ModuleUi }> = []
  for (const part of parts) {
    try {
      const loadedPart = await import(/* @vite-ignore */ part.url) as { default?: ModuleUi, ui?: ModuleUi }
      const ui = loadedPart.default ?? loadedPart.ui
      if (ui && typeof ui.views === 'function') out.push({ ...part, ui })
    } catch (error) { console.error(`模块 ${part.id} 的页面部分没能加载：${(error as Error).message}`) }
  }
  return out
}

async function load(): Promise<MarketUi[]> {
  try {
    const answer = await fetch('/api/module-markets')
    if (!answer.ok) return []
    const { markets } = await answer.json() as { markets: Array<{ modules: Array<{ id: string, ui: string }> }> }
    // boardd gives each page part by its path at `/module-ui/<module>/<file>`: the module's own directory, one file deep.
    return markets.flatMap(market => market.modules.filter(module => module.ui).map(module => ({ id: module.id, url: module.ui })))
  } catch { return [] }
}
