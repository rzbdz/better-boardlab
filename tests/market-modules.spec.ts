/**
 * The modules that moved out of this distribution into the public market, loaded the way a machine loads them: cloned
 * from a real repository into a state directory, the manifest read, and each module imported by a Node process with
 * `boardlab` pointed at this build's SDK (as boardd does). If the SDK lacks one name a module uses, that import fails —
 * which is what moving the rest of the modules depends on. A module whose page part or help pages the manifest names
 * must also bring files that exist, since the page imports the one and links the other.
 *
 * It runs in a child process because that is the only place Node's own resolver points `boardlab` at the SDK: a test
 * runner's bundler does not, and the point of this test is the boundary itself.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { marketsOf, syncMarket, writeRecords } from 'boardlab-core/server/markets.ts'

const market = process.env.BOARDLAB_PUB_MARKET ?? resolve(process.cwd(), '..', 'boardlab-modules-pub')
const sdk = join(process.cwd(), 'dist/sdk.js')
// Built by `pnpm run build`: a market module resolves `boardlab` to it, and moving the modules is what the build is for.
const usable = existsSync(sdk) && existsSync(join(market, 'market.json'))

/** A state directory with the public market cloned into it, as `boardlab market add` leaves one. */
async function stateWithMarket(): Promise<string> {
  const state = mkdtempSync(join(tmpdir(), 'boardlab-pub-'))
  const synced = await syncMarket(state, 'pub', { url: market })
  writeRecords(state, [{ id: 'pub', url: market, branch: null, commit: synced.commit }])
  return state
}

/** Every module that left this distribution: the market offers it, and this build has no copy of its source. */
const MOVED = ['human', 'feedback', 'alerts', 'console-watch', 'market', 'sftp-images', 'terminal', 'boardlab', 'clients']
/** Those of them with a page of their own: the rest are configured on another module's page (an image market), only
 * answer interfaces (a backend), or bring settings sections (the clients a boardd has). */
const WITH_PAGE = ['human', 'feedback', 'alerts', 'console-watch', 'market', 'terminal']

describe.skipIf(!usable)('a module from the public market', () => {
  it.each(MOVED)('%s: imports, sets itself up in a lab, and brings the commands its manifest names', async (id) => {
    const state = await stateWithMarket()
    const offered = marketsOf(state)[0]!.modules.find(item => item.id === id)!
    expect(offered).toMatchObject({ id, market: 'pub' })
    // What a boardd says it offers (`GET /api/cli/commands`), and that one of them runs here and talks to its lab.
    const script = join(state, 'run.mjs')
    writeFileSync(script, [
      "import { registerHooks } from 'node:module'",
      'let sdk = null',
      // What a module may import, as boardd resolves it: `boardlab` (its server side), `boardlab/client` (the client
      // library beside the SDK, what a hub reaches a host with), and `boardlab/ui` (its page part, which the browser
      // gets from the import map and this child gets from the same build).
      "registerHooks({ resolve(specifier, context, next) { const url = specifier === 'boardlab' ? process.env.SDK : specifier === 'boardlab/client' ? process.env.CLIENT : specifier === 'boardlab/ui' ? process.env.UI_SDK : null; return url ? { url, shortCircuit: true, format: 'module' } : next(specifier, context) } })",
      // A module's own commands, when its manifest names a cli file (the market's own page has none: its commands are
      // the core's `boardlab market …`).
      'const { loadCommands, describe } = await import(process.env.MARKET_CLI)',
      'const { group, problem } = process.env.ENTRY === "null" ? { group: null, problem: null } : await loadCommands(process.env.ENTRY, process.env.MODULE)',
      'if (problem) throw new Error(problem)',
      'const described = group ? describe(group) : []',
      // The real reader, so a module exported as a factory (`alerts(...)`) loads as boardd loads it.
      'const { importMarketModule } = await import(process.env.MARKETS)',
      'const module = await importMarketModule({ id: process.env.MODULE, entry: process.env.MODULE_ENTRY })',
      'const { BoardLab } = await import(process.env.LAB)',
      'const { openDatabase } = await import(process.env.DB)',
      // A module that injects a service takes it from another loaded module: the same market, its provider first.
      'const providers = process.env.PROVIDER ? [await importMarketModule({ id: process.env.PROVIDER_ID, entry: process.env.PROVIDER })] : []',
      'const lab = new BoardLab({ db: openDatabase(process.env.DATABASE), modules: [...providers, module] })',
      // What it registered on the lab it was handed: this build makes a module from a catalog entry and sets it up the
      // same way (see `core.ts`'s `use`), so a module that does that and answers no interface added nothing — which for
      // one that only answers another module's interface (`nexus-images` is a market kind) is its whole job.
      'const registered = lab.plugins().find(plugin => plugin.id === module.id)',
      'const added = lab.api.list().filter(item => item.module === process.env.MODULE).length',
      'const stateParts = Object.keys(lab.state("user:a"))',
      'const status = providers.map(item => lab.plugins().find(plugin => plugin.id === item.id)?.status)',
      'const ui = process.env.UI ? await import(process.env.UI) : null',
      'const views = ui && typeof ui.ui.views === "function" ? ui.ui.views(lab.state("user:a"), {}) : []',
      'console.log(JSON.stringify({ id: module.id, status: registered?.status, added, providers: status, state: stateParts.filter(key => !["boards","labs","modules","plugins","proposals","now","you","yields","history","consoles"].includes(key)), commands: described.map(item => item.name), heading: described[0]?.group.title ?? null, pages: views.map(view => [view.id, view.slot, view.help ?? null]) }))',
    ].join('\n'))
    const root = process.cwd()
    // The page part as the browser runs it: the built file, whose own imports of `boardlab/ui` point at the SDK through
    // the page's import map — a Node child has no such map, so the test loads it only when it resolves the SDK itself.
    const ui = offered.ui ? pathToFileURL(join(offered.uiDir!, offered.ui.slice(offered.ui.lastIndexOf("/") + 1))).href : null
    const provider = id === 'console-watch' ? marketsOf(state)[0]!.modules.find(item => item.id === 'alerts') : null
    const env = {
      ...process.env,
      SDK: pathToFileURL(sdk).href,
      ...(provider ? { PROVIDER: provider.entry, PROVIDER_ID: provider.id } : {}),
      UI_SDK: pathToFileURL(join(process.cwd(), 'dist/sdk.browser.js')).href,
      CLIENT: pathToFileURL(join(process.cwd(), 'dist/client.js')).href,
      ENTRY: String(offered.cli),
      MODULE: id,
      // A real path: the loader hands it to `import()` itself, and a file URL would be encoded twice.
      MODULE_ENTRY: offered.entry,
      MARKET_CLI: pathToFileURL(join(root, 'core/src/cli/market-cli.ts')).href,
      MARKETS: pathToFileURL(join(root, 'core/src/server/markets.ts')).href,
      LAB: pathToFileURL(join(root, 'core/src/core/lab.ts')).href,
      DB: pathToFileURL(join(root, 'core/src/core/db.ts')).href,
      DATABASE: join(state, 'boards.sqlite'),
      ...(ui ? { UI: ui } : {}),
    }
    // Node 24 runs the module's and the core's TypeScript as it is, as boardd does.
    const out = execFileSync(process.execPath, ['--experimental-transform-types', '--no-warnings', script], { env, encoding: 'utf8', cwd: state })
    const answer = JSON.parse(out.trim().split('\n').at(-1)!)
    expect(answer.id).toBe(id)
    // The module loaded, with the SDK it imports and the settings it was given: the boundary this test is about.
    expect(answer.status).toBe('active')
    // Whatever it injected was loaded and active, not left waiting: a module from a market takes its services from there.
    expect(answer.providers.every((status: string | undefined) => status === 'active')).toBe(true)
    // Its commands as the manifest names them: one for each module that brings any, none for one whose commands are
    // the core's own (`boardlab market …`).
    expect(answer.commands.length).toBe(offered.cli ? 1 : 0)
    // A module whose page part brings views draws them; a page-part-less module, or one whose views are settings
    // sections, has no tab of its own — `offered.ui` says whether it brings a part at all.
    const tabs = WITH_PAGE.includes(id)
    expect(answer.pages.some(([, slot]: [string, string]) => slot === 'page')).toBe(tabs)
    if (offered.ui) expect(answer.pages.length).toBeGreaterThan(0)
  }, 60_000)

  it.each(WITH_PAGE)('%s: brings the page part and help pages its manifest names', async (id) => {
    const offered = marketsOf(await stateWithMarket())[0]!.modules.find(item => item.id === id)!
    // The page imports the ui file as it is: it must be browser JavaScript, and it must import the SDK by name (the
    // import map points that at boardd's own build), never a relative path into the market.
    expect(offered.ui).toBeTruthy()
    const ui = readFileSync(join(offered.uiDir!, offered.ui!.slice(offered.ui!.lastIndexOf("/") + 1)), 'utf8')
    expect(ui).toMatch(/from\s*["']boardlab\/ui["']/)
    for (const page of offered.docs) expect(existsSync(page.file)).toBe(true)
  })

  it.each(MOVED)('%s: is gone from this distribution, so one module has one owner', (id) => {
    // The move is the point: a module in a market moves, it is not copied, or two boardds could load two of it.
    expect(() => execFileSync('git', ['ls-files', '--error-unmatch', `src/modules/${id}`], { cwd: process.cwd(), stdio: 'pipe' })).toThrow()
  })
})
