/**
 * SDK work through boardd: `boards sdk …` runs `boardctrl sdk …` here, where the boardctrl CLI and its site live, so the machines
 * people and agents work on need nothing but `boards`. boardctrl drives the build servers over ssh as the site says; boardd
 * only runs it and streams its output back. Each holder has their own boardctrl configuration directory, so the SDK lease
 * tokens boardctrl remembers are theirs alone.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cliName } from './driver.ts'
import { hostUrl, statePath } from './address.ts'

export type SdkStream = 'stdout' | 'stderr'
/** sdk and catalog run `boardctrl sdk|catalog …`; raw runs any `boardctrl …` command. */
export type SdkGroup = 'sdk' | 'catalog' | 'raw'
/** One board host boardlab knows: how boardctrl reaches it, and the token it asks for. */
export interface ReachedHost {
  /** The name the command's `-r` uses: the lab's id. */
  name: string
  /** Reach it as `driver.ts` does: one boardctrld directly (`boardctrld+http://…`), or over ssh (`boardctrld+ssh://user@host:8765`). */
  url: string
  token: string
}

/**
 * Where a boardctrl command that talks to board hosts (`raw`) reaches them: every lab boardlab has, as one boardctrl "registry"
 * file. That is `driver.ts`'s own reach per lab, put where boardctrl reads it, so `gpio`/`dut`/a site provider's command answers
 * with the token the lab has instead of refusing. `null` when there is no lab: `sdk` and `catalog` work on build
 * servers and the registry, and need none.
 */
export interface SdkReach {
  hosts: ReachedHost[]
  /** A lab's id as a person says it, and the remote name it is written as here. */
  names: Record<string, string>
}
export interface SdkRunner {
  /** Run `boardctrl [--json] <group> <args>` for `holder` (group sdk, or catalog for the registry's SDK catalog); resolves with its exit code. */
  run(args: string[], options: { holder: string, json: boolean, group?: SdkGroup, onOutput: (stream: SdkStream, text: string) => void, signal?: AbortSignal, reach?: SdkReach | null }): Promise<number>
}

/** The `boardctrl sdk` actions boardd runs; everything else boardctrl has stays on this machine. */
export const SDK_ACTIONS = new Set(['list', 'show', 'status', 'plan', 'acquire', 'release', 'build', 'jobs', 'job', 'exec', 'get', 'put'])
/** The `boardctrl catalog` actions boardd runs (`boardlab registry sdk`); export writes on this machine and is left out. */
/** What the raw passthrough refuses: commands that change boardd's own machine rather than the lab. */
export const RAW_REFUSED = new Set(['remote', 'install'])
export const CATALOG_ACTIONS = new Set(['list', 'get', 'put', 'recipe', 'rm', 'history', 'rollback', 'import', 'status', 'refresh'])

/** A file's text, or null when it is not there yet. */
function readFile(path: string): string | null {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

/**
 * The `remotes.json` a reach is: boardctrl's own remotes file, one remote per lab, each with its token.
 *
 * The site's own `remotes.json` may name the same machines and may point `registry` at one: a registry entry merges
 * over every other (dropping its token, which a registry does not carry), and reading it would also reach past the
 * labs. So this file speaks for the labs alone: no registry, and names that no site entry answers to.
 */
function reachRemotes(reach: SdkReach): string {
  const remotes: Record<string, unknown> = {}
  for (const host of reach.hosts) {
    const url = hostUrl(host.url)
    // `ssh://user@host:port` is boardctrld on that machine's loopback port, through ssh: what the board host setup is.
    if (url.startsWith('ssh://')) {
      const target = new URL(url)
      // The address boardctrl tries first must be the host's own, never loopback: a boardd may run a hostd on its own
      // 127.0.0.1:8765, and that one would answer for every lab. `ssh` stays the way in when the address does not.
      remotes[host.name] = { url: `http://${target.hostname}:${target.port || 8765}`, ssh: `${target.username ? `${target.username}@` : ''}${target.hostname}`, token: host.token }
    } else remotes[host.name] = { url, token: host.token }
  }
  return JSON.stringify({ registry: null, remotes })
}

/** Whether the command names its own host (`-r`, `--remote`, `--url`), which the reach must not override. */
function hasRouting(args: string[]): boolean {
  return args.some(arg => arg === '-r' || arg === '--url' || arg === '--remote'
    || arg.startsWith('--url=') || arg.startsWith('--remote=') || (arg.startsWith('-r') && arg.length > 2))
}

export function sdkRunner(options: { bin?: string, stateDir: string }): SdkRunner {
  // The same CLI boardd's other boardctrl calls use: `boardctrl` when this machine has it, else `bsp`. A bare `boardctrl`
  // would fail to spawn on a machine that has only the older name, and the command would never run.
  const bin = options.bin ?? process.env.BOARDS_BOARDCTRL ?? cliName()
  const site = statePath(options.stateDir, 'boardctrl/site')
  return {
    run: (args, { holder, json, group = 'sdk', onOutput, signal, reach = null }) => new Promise(resolve => {
      const dir = join(statePath(options.stateDir, 'boardctrl-holders'), createHash('sha256').update(holder).digest('hex').slice(0, 16))
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const config = join(dir, 'remotes.json')
      // A command that talks to board hosts reaches them the way boardd does: the labs' addresses and tokens are what
      // `driver.ts` gives every boardctrl call, written where boardctrl reads its remotes, so a host-side command (`gpio list`, a
      // site provider's) answers instead of refusing for want of a token. A command that names its own host (`-r`,
      // `--url`) keeps it. `sdk` and `catalog` work on build servers and the registry and are left as they are.
      // Written only when it changes: this is the holder's own directory, and it keeps its leases beside this file.
      // The labs are written whether or not the command names one: a named one still has to resolve to the lab's own
      // address and token, which is what this file gives it.
      const registry = reach ? reachRemotes(reach) : null
      if (registry && readFile(config) !== registry) writeFileSync(config, registry, { mode: 0o600 })
      // Say which hosts unless the command says so itself: boardctrl prefers a `local` hostd (127.0.0.1:8765) whenever one
      // answers, and a boardd on a machine that also runs one would then ask itself instead of the labs.
      // A command that names a lab says the id a person reads (`-r CoM260-GPIO`); the remote here is `lab-<id>`. A name
      // that is no lab is left as it is: it may be boardctrl's own remote.
      const chosen = args.map((arg, at) => {
        const prev = args[at - 1]
        const value = arg.startsWith('--remote=') ? arg.slice('--remote='.length) : prev === '-r' || prev === '--remote' ? arg : null
        if (value === null || !reach) return arg
        const mapped = value.split(',').map(part => reach.names[part.trim()] ?? part.trim()).join(',')
        return arg.startsWith('--remote=') ? `--remote=${mapped}` : mapped
      })
      const routed = reach && !hasRouting(args) ? ['-r', reach.hosts.map(host => host.name).join(',')] : []
      const child = spawn(bin, [...(json ? ['--json'] : []), ...(group === 'raw' ? [] : [group]), ...routed, ...chosen], {
        // BOARDCTRL_CONFIG names the holder's own configuration directory: boardctrl keeps lease tokens next to it. The
        // `BSP_*` names are sent too, for a host's older boardctrl that only reads those. Leases taken through the raw
        // passthrough are `boardctrl:<holder>` — the holder name of the lease a board shows in boardctrl — which boardd sees as
        // someone using the board there (its own leases are `boardlab:<holder>`).
        // BOARDCTRL_SITE: the site boardd keeps and ships to its board hosts (SDKs, build servers), same to both names.
        env: { ...process.env, ...(existsSync(site) ? { BSP_SITE: site, BOARDCTRL_SITE: site } : {}),
          BSP_CONFIG: config, BOARDCTRL_CONFIG: config,
          BSP_HOLDER: `${group === 'raw' ? 'boardctrl' : 'boardlab'}:${holder}`, BOARDCTRL_HOLDER: `${group === 'raw' ? 'boardctrl' : 'boardlab'}:${holder}`,
          PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const stop = () => child.kill('SIGTERM')
      signal?.addEventListener('abort', stop, { once: true })
      child.stdout.setEncoding('utf8').on('data', text => onOutput('stdout', text))
      child.stderr.setEncoding('utf8').on('data', text => onOutput('stderr', text))
      child.on('error', error => { onOutput('stderr', `boardctrl 没能运行：${error.message}\n`); resolve(127) })
      child.on('close', code => { signal?.removeEventListener('abort', stop); resolve(code ?? 1) })
    }),
  }
}
