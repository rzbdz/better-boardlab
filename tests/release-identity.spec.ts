/** One isolated boardd: CLI, status and both version APIs report the same distribution identity. */
import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { startBoardd } from 'boardlab-core/server/main.ts'
import { BoardsClient } from 'boardlab-core/shared/client.ts'
import { entry } from '../src/modules/system/catalog.ts'
import { dir, useTempDir } from './fakes.ts'

useTempDir()
const execute = promisify(execFile)
const packageVersion = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')).version as string

describe('distribution release identity', () => {
  it('agrees across the built CLI, status and HTTP APIs', async () => {
    const revision = 'd'.repeat(40)
    const stateDir = join(dir, 'isolated-boardd')
    const boardd = await startBoardd({
      stateDir, catalog: [entry], modules: ['system'], port: 0, uiDir: null,
      version: packageVersion, revision,
    })
    try {
      const url = `http://127.0.0.1:${boardd.port}`
      const api = await new BoardsClient(join(stateDir, 'boardd.sock')).call<{ version: string, revision: string }>('GET', '/api/version')
      const system = await new BoardsClient(join(stateDir, 'boardd.sock')).call<{ version: string, revision: string }>('GET', '/api/system/version')
      expect(api).toMatchObject({ version: packageVersion, revision })
      expect(system).toMatchObject({ version: packageVersion, revision })
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(dir, 'home'), XDG_CONFIG_HOME: join(dir, 'config'), BOARDS_STATE_DIR: stateDir, NODE_NO_WARNINGS: '1' }
      for (const name of ['BOARDS_REMOTE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[name]
      const cli = join(import.meta.dirname, '../dist/cli.js')
      const version = JSON.parse((await execute(process.execPath, [cli, 'version', '--json', '--state-dir', stateDir], { env, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' })).stdout)
      const status = JSON.parse((await execute(process.execPath, [cli, 'status', '--json', '--state-dir', stateDir], { env, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' })).stdout)
      // Source CLI identity follows the distribution manifest; the boardd uses its explicit test release.
      expect(version.cli).toEqual({ version: packageVersion, revision: 'dev' })
      expect(version.boardd).toMatchObject({ version: packageVersion, revision })
      expect(version.api).toMatchObject({ version: packageVersion, revision })
      expect(status.version).toMatchObject({ version: packageVersion, revision })
    } finally {
      await boardd.close()
    }
  })
})
