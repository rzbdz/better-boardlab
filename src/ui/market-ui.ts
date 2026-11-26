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
      // boardd gives the path relative to the page, so a page works under a reverse proxy's sub-path; this module is
      // bundled under `assets/`, so the page's own base is what it resolves against.
      const loadedPart = await import(/* @vite-ignore */ new URL(part.url, document.baseURI).href) as { default?: ModuleUi, ui?: ModuleUi }
      const ui = loadedPart.default ?? loadedPart.ui
      if (ui && typeof ui.views === 'function') out.push({ ...part, ui })
    } catch (error) { console.error(`模块 ${part.id} 的页面部分没能加载：${(error as Error).message}`) }
  }
  return out
}

async function load(): Promise<MarketUi[]> {
  try {
    const answer = await fetch('api/module-markets', { headers: { Accept: 'application/json' } })
    if (!answer.ok) return []
    const { pages } = await answer.json() as { pages?: Array<{ id: string, ui: string }> }
    // The page parts of the modules boardd loaded (a market added only to browse it serves no code to the page), each
    // at its own file: `<module>/<file>` inside the market's copy, and nothing else of it is served.
    return (pages ?? []).filter(part => typeof part.id === 'string' && typeof part.ui === 'string').map(part => ({ id: part.id, url: part.ui }))
  } catch { return [] }
}
