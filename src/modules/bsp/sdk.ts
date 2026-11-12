/**
 * SDK work through boardd: `boards sdk …` runs `bsp sdk …` here, where the bsp CLI and its site live, so the machines
 * people and agents work on need nothing but `boards`. bsp drives the build servers over ssh as the site says; boardd
 * only runs it and streams its output back. Each holder has their own bsp configuration directory, so the SDK lease
 * tokens bsp remembers are theirs alone.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type SdkStream = 'stdout' | 'stderr'
/** sdk and catalog run `bsp sdk|catalog …`; raw runs any `bsp …` command. */
export type SdkGroup = 'sdk' | 'catalog' | 'raw'
export interface SdkRunner {
  /** Run `bsp [--json] <group> <args>` for `holder` (group sdk, or catalog for the registry's SDK catalog); resolves with its exit code. */
  run(args: string[], options: { holder: string, json: boolean, group?: SdkGroup, onOutput: (stream: SdkStream, text: string) => void, signal?: AbortSignal }): Promise<number>
}

/** The `bsp sdk` actions boardd runs; everything else bsp has stays on this machine. */
export const SDK_ACTIONS = new Set(['list', 'show', 'status', 'plan', 'acquire', 'release', 'build', 'jobs', 'job', 'exec', 'get', 'put'])
/** The `bsp catalog` actions boardd runs (`boardlab registry sdk`); export writes on this machine and is left out. */
/** What the raw passthrough refuses: commands that change boardd's own machine rather than the lab. */
export const RAW_REFUSED = new Set(['remote', 'install'])
export const CATALOG_ACTIONS = new Set(['list', 'get', 'put', 'recipe', 'rm', 'history', 'rollback', 'import', 'status', 'refresh'])

export function bspSdk(options: { bin?: string, stateDir: string }): SdkRunner {
  const bin = options.bin ?? process.env.BOARDS_BSP ?? 'bsp'
  const site = join(options.stateDir, 'bsp', 'site')
  return {
    run: (args, { holder, json, group = 'sdk', onOutput, signal }) => new Promise(resolve => {
      const dir = join(options.stateDir, 'bsp-holders', createHash('sha256').update(holder).digest('hex').slice(0, 16))
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const child = spawn(bin, [...(json ? ['--json'] : []), ...(group === 'raw' ? [] : [group]), ...args], {
        // BSP_CONFIG names the holder's own configuration directory: bsp keeps lease tokens next to it. Leases taken
        // through the raw passthrough are `bsp:<holder>`, which boardd sees as someone using the board in bsp (its own
        // leases are boardlab:<holder>).
        // BSP_SITE: the site boardd keeps and ships to its board hosts (SDKs, build servers), so SDK commands see the same.
        env: { ...process.env, ...(existsSync(site) ? { BSP_SITE: site } : {}), BSP_CONFIG: join(dir, 'remotes.json'),
          BSP_HOLDER: `${group === 'raw' ? 'bsp' : 'boardlab'}:${holder}`, PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const stop = () => child.kill('SIGTERM')
      signal?.addEventListener('abort', stop, { once: true })
      child.stdout.setEncoding('utf8').on('data', text => onOutput('stdout', text))
      child.stderr.setEncoding('utf8').on('data', text => onOutput('stderr', text))
      child.on('error', error => { onOutput('stderr', `bsp 没能运行：${error.message}\n`); resolve(127) })
      child.on('close', code => { signal?.removeEventListener('abort', stop); resolve(code ?? 1) })
    }),
  }
}
