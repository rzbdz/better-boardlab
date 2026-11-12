/**
 * `boardlab site`: the command against a fake boardd answering the site endpoints. No bsp, no hosts.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoardsClient } from 'boardlab-core/shared/client.ts'
import type { CommandContext } from 'boardlab-core/cli/command.ts'
import { commands } from '../src/modules/bsp/cli.ts'

const doc = (kind: string, id: string, fields: Record<string, string>, layer = 'site') =>
  ({ kind, id, file: `${kind}/${id}.yaml`, layer, text: `id: ${id}\n`, fields })
const site = {
  source: 'git', url: 'git@git.example:lab/site.git', branch: 'main', ready: true, revision: 'abc1234',
  commit: { subject: 'add sdk-a', at: '2026-11-12T08:00:00Z' }, ahead: 1,
  docs: [
    doc('servers', 'build-1', { host: 'build-1.example', user: 'ci' }),
    doc('instances', 'sdk-a', { server: 'build-1', family: 'buildroot', path: '/srv/sdk-a' }),
    doc('workspaces', 'tree-1', { server: 'build-1' }),
    doc('instances', 'sdk-b', { workspace: 'tree-1' }),
    doc('instances', 'sdk-c', { server: 'elsewhere' }),
    doc('instances', 'packed', { server: 'build-1' }, 'pack'),
  ],
  socs: [], problems: ['servers/old.yaml: no host'], hosts: { 'host-a': { revision: 'abc1234', at: '', ok: true, message: '' } },
  syncing: false, images: { ok: true, message: '', missing: [], optional: ['probe.bin'] },
}

let dir: string, server: Server, requests: Array<{ method: string, url: string, body: any }>, syncOk: boolean, lines: string[]

function answer(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8')
    const body = text ? JSON.parse(text) : undefined
    requests.push({ method: req.method!, url: req.url!, body })
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (req.method === 'GET' && req.url === '/api/bsp/site') return json(200, site)
    if (req.url === '/api/bsp/site/pull') return json(200, { message: '拉取了 2 个提交' })
    if (req.url === '/api/bsp/site/doc') return json(200, { file: `${body.kind}/${body.id}.yaml` })
    if (req.url === '/api/bsp/site/remove') return json(body.id === 'sdk-a' ? 409 : 200, body.id === 'sdk-a' ? { error: 'sdk-a 还在用' } : { message: `删了 ${body.id}` })
    if (req.url === '/api/bsp/site/sync') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`event: out\ndata: ${JSON.stringify({ text: 'host-a: 同步中' })}\n\n`)
      res.end(`event: exit\ndata: ${JSON.stringify({ ok: syncOk, message: syncOk ? '都同步了' : 'host-a 没同步上' })}\n\n`)
      return
    }
    json(404, { error: 'not found' })
  })
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'site-cli-'))
  requests = []; syncOk = true; lines = []
  server = createServer(answer)
  await new Promise<void>(resolve => server.listen(join(dir, 'boardd.sock'), resolve))
  vi.spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.join(' ')) })
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string) => { lines.push(text); return true }) as any)
})
afterEach(async () => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  await new Promise(resolve => server.close(resolve))
  rmSync(dir, { recursive: true, force: true })
})

async function run(words: string[], flags: Record<string, string> = {}, json = false) {
  const command = commands.commands.find(c => c.name === 'site')!
  const values: unknown[] = []
  const ctx = {
    args: words, argv: words, flags: new Map(Object.entries(flags)), flag: (name: string) => flags[name], json,
    out: (value: unknown, text: () => void) => json ? values.push(value) : text(),
    client: new BoardsClient(join(dir, 'boardd.sock'), 'user:test'), holder: 'user:test', remote: false,
  } as unknown as CommandContext
  await command.run(ctx)
  return values
}

describe('boardlab site', () => {
  it('shows the site by build server', async () => {
    await run(['show'])
    const text = lines.join('\n')
    expect(text).toContain('git git@git.example:lab/site.git 分支 main')
    expect(text).toContain('abc1234 · add sdk-a')
    expect(text).toContain('1 个提交还没推送')
    expect(text).toContain('问题  servers/old.yaml: no host')
    expect(text).toMatch(/build-1 {2}ci@build-1\.example\n {4}sdk-a {2}buildroot {2}\/srv\/sdk-a\n {4}sdk-b {2}源码树 tree-1\n {4}packed/)
    expect(text).toMatch(/别处的 SDK\n {4}sdk-c/)
    expect(text).toContain('主机  host-a abc1234')
    expect(text).toContain('可选  probe.bin')
  })

  it('prints one document, and refuses an unknown kind', async () => {
    await run(['show', 'sdk', 'sdk-a'])
    expect(lines).toEqual(['id: sdk-a\n'])
    await expect(run(['show', 'board', 'x'])).rejects.toThrow(/不认识的种类 board/)
    await expect(run(['show', 'sdk', 'nope'])).rejects.toThrow(/站点里没有 sdk nope/)
  })

  it('edits the site\'s own document and takes over a pack\'s', async () => {
    const file = join(dir, 'sdk.yaml')
    writeFileSync(file, 'id: sdk-a\nserver: build-1\n')
    await run(['set', 'sdk', 'sdk-a'], { file })
    await run(['set', 'sdk', 'packed'], { file })
    const posts = requests.filter(r => r.url === '/api/bsp/site/doc').map(r => r.body)
    expect(posts).toEqual([
      { kind: 'instances', id: 'sdk-a', text: 'id: sdk-a\nserver: build-1\n', original: 'sdk-a' },
      { kind: 'instances', id: 'packed', text: 'id: sdk-a\nserver: build-1\n' },
    ])
    expect(lines).toContain('写好了 instances/sdk-a.yaml；boardlab site sync 同步到主机')
    await expect(run(['set', 'sdk', 'sdk-a'])).rejects.toThrow(/--file/)
  })

  it('removes, pulls, and passes boardd\'s refusal on', async () => {
    await run(['remove', 'server', 'build-2'])
    await run(['pull'])
    expect(lines).toEqual(['删了 build-2', '拉取了 2 个提交'])
    await expect(run(['remove', 'sdk', 'sdk-a'])).rejects.toThrow('sdk-a 还在用')
  })

  it('streams a sync and fails when a host did not take it', async () => {
    await run(['sync'], { lab: 'host-a' })
    expect(requests.at(-1)).toMatchObject({ url: '/api/bsp/site/sync', body: { lab: 'host-a' } })
    expect(lines).toEqual(['host-a: 同步中', '都同步了'])
    expect(process.exitCode).toBeUndefined()
    syncOk = false
    const values = await run(['sync'], {}, true)
    expect(values).toEqual([{ ok: false, message: 'host-a 没同步上' }])
    expect(process.exitCode).toBe(1)
  })
})
