import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from 'boardlab-core/core/db.ts'
import { serve } from 'boardlab-core/server/http.ts'
import { BoardsClient } from 'boardlab-core/shared/client.ts'
import { Bench, dir, makeLab, sha, useTempDir } from './fakes.ts'

useTempDir()

describe('SDK work through boardd', () => {
  it('runs bsp sdk for the caller, streams its output, and carries files both ways', async () => {
    const runs: Array<{ args: string[], holder: string, json: boolean }> = []
    const sdk = {
      async run(args: string[], options: { holder: string, json: boolean, group?: string, onOutput: (stream: 'stdout' | 'stderr', text: string) => void }) {
        runs.push({ args, holder: options.holder, json: options.json, ...(options.group && options.group !== 'sdk' ? { group: options.group } : {}) })
        if (args[0] === 'build') { options.onOutput('stderr', 'CC init/main.o\n'); options.onOutput('stdout', 'build ok\n'); return 0 }
        if (args[0] === 'put') { options.onOutput('stdout', readFileSync(args[3]!, 'utf8')); return 0 }
        if (args[0] === 'get') { writeFileSync(args[args.indexOf('-o') + 1]!, 'remote main.c'); return 0 }
        return 2
      },
    }
    const bench = new Bench([])
    const svc = makeLab({ ...bench.options(openDatabase(join(dir, 'sdk.sqlite'))), sdk })
    const port = 40000 + Math.floor(Math.random() * 1000)
    const running = await serve(svc, { port, socketPath: join(dir, 'sdk.sock'), uiDir: null })
    try {
      const client = new BoardsClient(join(dir, 'sdk.sock'), 'claude:build-1')
      const out: string[] = []
      expect(await client.sdk(['build', 'sdk-a', 'kernel'], false, (stream, text) => out.push(`${stream}:${text}`))).toEqual({ code: 0, download: null })
      expect(out).toEqual(['stderr:CC init/main.o\n', 'stdout:build ok\n'])
      expect(runs[0]).toEqual({ args: ['build', 'sdk-a', 'kernel'], holder: 'claude:build-1', json: false })
      // put: the local file is sent first and stands in as @sha256:<hex>.
      const local = join(dir, 'main.c')
      writeFileSync(local, 'patched main.c')
      const ref = await client.sendFile(local)
      const echoed: string[] = []
      await client.sdk(['put', 'sdk-a', 'init/main.c', `@${ref}`], false, (_stream, text) => echoed.push(text))
      expect(echoed).toEqual(['patched main.c'])
      // get -o: saved on boardd's side, handed back by sha256 and fetched.
      const got = await client.sdk(['get', 'sdk-a', 'init/main.c', '-o', '@download'], false, () => {})
      expect(got.download).toBe(sha('remote main.c'))
      await client.fetchFile(got.download!, join(dir, 'fetched.c'))
      expect(readFileSync(join(dir, 'fetched.c'), 'utf8')).toBe('remote main.c')
      await expect(client.sdk(['probe'], false, () => {})).rejects.toThrow(/不支持的 sdk 操作/)
      // The registry's SDK catalog goes through the same runner as `bsp catalog`.
      await client.sdk(['recipe', 'k2-asr', 'download', '-f', `@${ref}`], false, () => {}, 'catalog')
      expect(runs.at(-1)).toMatchObject({ args: ['recipe', 'k2-asr', 'download', '-f', svc.files.get(sha('patched main.c'))!.path], group: 'catalog' })
      await expect(client.sdk(['export', '--dir', '/tmp/x'], false, () => {}, 'catalog')).rejects.toThrow(/不支持的 registry sdk 操作/)
      // Any bsp command goes through, except those that change boardd's own machine.
      await client.sdk(['-r', 'h1', 'dut', 'status', 'k3-a'], true, () => {}, 'raw')
      expect(runs.at(-1)).toMatchObject({ args: ['-r', 'h1', 'dut', 'status', 'k3-a'], json: true, group: 'raw' })
      await expect(client.sdk(['remote', 'add', 'x', 'http://x'], false, () => {}, 'raw')).rejects.toThrow(/boardd 所在机器自己的配置/)
      await expect(client.sdk(['catalog', 'export', '--dir', '/'], false, () => {}, 'raw')).rejects.toThrow(/boardd 所在机器自己的配置/)
      expect((await client.call<{ endpoints: string[] }>('GET', '/api')).endpoints).toContain('POST /api/sdk')
      expect(svc.history().actions.filter(action => action.kind === 'sdk').map(action => action.detail)).toEqual(['get sdk-a init/main.c -o', 'put sdk-a init/main.c', 'build sdk-a kernel'])
    } finally { await running.close() }
  })
})
