/**
 * Offers the clients module to boardd: installing the boardlab CLI on other machines from the release boardd runs.
 * Settings (all optional): `hub` (the address those machines ssh to), `tunnel` (the user they log in as), `port`
 * (boardd's port, by default the one it serves on).
 */
import { number, text, type CatalogEntry } from 'boardlab-core/server/catalog.ts'
import { clients, releaseAt } from './index.ts'

// `uname -m` of the machines boardd's own Node runs on.
const ARCH: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64', riscv64: 'riscv64' }
/** The port boardd serves on, from its command line (`serve --port N`). */
const servedPort = () => { const at = process.argv.indexOf('--port'); return at > 0 ? Number(process.argv[at + 1]) || undefined : undefined }

export const entry: CatalogEntry = {
  id: 'clients', about: '给编译机、笔记本装 boardlab 命令行，连到这台 boardd（hub、tunnel、port）',
  create: (settings, context) => clients({
    stateDir: context.stateDir,
    release: releaseAt(context.shipped('VERSION')?.replace(/\/VERSION$/, '') ?? null),
    port: number(settings, 'port') ?? servedPort(),
    hub: { address: text(settings, 'hub'), tunnel: text(settings, 'tunnel') },
    node: ARCH[process.arch] ? { path: process.execPath, arch: ARCH[process.arch]! } : null,
  }),
}
