/** The Nexus market against a fake Nexus: the folder tree, the SoC a folder belongs to, what is left out, and where an image is fetched from. */
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { matches, nexusConfig, nexusMarket } from '../src/modules/nexus-images/index.ts'

let server: Server | null = null
afterEach(() => new Promise<void>(resolve => { if (server) server.close(() => resolve()); else resolve(); server = null }))

const node = (id: string, leaf: boolean) => ({ id, text: id.split('/').at(-1)!, leaf })
const tree: Record<string, Array<{ id: string, text: string, leaf: boolean }>> = {
  '/': [node('a', false), node('b', false), node('c', false)],
  'a': [node('a/v2', false), node('a/img.zip', true), node('a/__probe__', false)],
}
const sha = 'ab'.repeat(32)
const assets: Record<string, unknown[]> = {
  '/a': [{ path: 'a/img.zip', downloadUrl: 'https://nexus.example.org/repository/images/a/img.zip', fileSize: 1234, lastModified: '2026-03-01T00:00:00.000+00:00', checksum: { sha256: sha } }],
}

/** A Nexus that answers the browser's folder read and the asset search, and notes what it was asked. */
async function nexus(asked: string[]): Promise<string> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const url = new URL(req.url!, 'http://localhost')
      res.setHeader('content-type', 'application/json')
      if (req.method === 'POST' && url.pathname === '/service/extdirect') {
        const call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { action: string, data: Array<{ repositoryName: string, node: string }> }
        asked.push(`browse ${call.data[0]!.repositoryName} ${call.data[0]!.node}`)
        return void res.end(JSON.stringify({ result: { success: true, data: tree[call.data[0]!.node] ?? [] } }))
      }
      if (req.method === 'GET' && url.pathname === '/service/rest/v1/search/assets') {
        const q = url.searchParams.get('q')
        if (q) {
          // A search of the whole repository: Nexus matches paths too, so it answers more than the name holds.
          asked.push(`search ${url.searchParams.get('repository')} ${q} ${url.searchParams.get('continuationToken') ?? ''}`)
          const first = q.toLowerCase() === 'img' && !url.searchParams.get('continuationToken')
          const page = first ? [
            { path: 'a/img.zip', fileSize: 1234, lastModified: '2026-03-01T00:00:00.000+00:00', checksum: { sha256: sha } },
            { path: 'a/__probe__/img-inner.zip', fileSize: 1 },
            { path: 'a/img-folder-only/x.txt', fileSize: 2 },
            { path: 'b/other.zip', fileSize: 3 },
          ] : [{ path: 'b/v2/IMG2.zip', fileSize: 4 }]
          return void res.end(JSON.stringify({ items: page, continuationToken: first ? 'next' : null }))
        }
        asked.push(`assets ${url.searchParams.get('repository')} ${url.searchParams.get('group')}`)
        return void res.end(JSON.stringify({ items: assets[url.searchParams.get('group')!] ?? [], continuationToken: null }))
      }
      res.statusCode = 404; res.end('{}')
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/`
}

describe('nexus-images', () => {
  it('matches paths against patterns with *', () => {
    expect(matches('*/__probe__*', 'a/__probe__')).toBe(true)
    expect(matches('a/*.zip', 'a/img.zip')).toBe(true)
    expect(matches('a/*.zip', 'a/img.iso')).toBe(false)
    expect(matches('exact', 'exact')).toBe(true)
    expect(matches('exact', 'exactly')).toBe(false)
  })

  it('says what is wrong with a market setting', () => {
    expect(() => nexusConfig({ repository: 'images' })).toThrow(/url/)
    expect(() => nexusConfig({ url: 'ftp://x.example.org', repository: 'images' })).toThrow(/url/)
    expect(() => nexusConfig({ url: 'https://me:secret@nexus.example.org', repository: 'images' })).toThrow(/用户名或密码/)
    expect(() => nexusConfig({ url: 'https://nexus.example.org', repository: 'a b' })).toThrow(/repository/)
    expect(() => nexusConfig({ url: 'https://nexus.example.org', repository: 'images', socs: ['a/'] })).toThrow(/socs/)
    expect(() => nexusConfig({ url: 'https://nexus.example.org', repository: 'images', exclude: 'x' })).toThrow(/exclude/)
    expect(nexusConfig({ url: 'https://nexus.example.org///', repository: 'images', socs: { 'a/': 'soc-a', 'a/deep/': 'soc-d' } }).socs.map(([prefix]) => prefix)).toEqual(['a/deep/', 'a/'])
  })

  it('lists folders and images, files each under its SoC, leaves out what is excluded, and reads sizes and sha256', async () => {
    const asked: string[] = []
    const market = nexusMarket({ url: await nexus(asked), repository: 'images', socs: { 'a/': 'soc-a', 'b/': 'soc-b' }, exclude: ['*/__probe__*'] })
    const top = await market.list('')
    expect(top).toEqual([
      { path: 'a', name: 'a', kind: 'folder', soc: 'soc-a' },
      { path: 'b', name: 'b', kind: 'folder', soc: 'soc-b' },
      { path: 'c', name: 'c', kind: 'folder', soc: null },
    ])
    expect(await market.list('a')).toEqual([
      { path: 'a/v2', name: 'v2', kind: 'folder', soc: 'soc-a' },
      { path: 'a/img.zip', name: 'img.zip', kind: 'image', soc: 'soc-a', size: 1234, sha256: sha, modified: '2026-03-01T00:00:00.000+00:00' },
    ])
    expect(asked).toEqual(['browse images /', 'browse images a', 'assets images /a'])
    // Its images all come from the repository's own address, by that scheme.
    expect(market.scheme).toBe('http')
  })

  it('searches the whole repository from its index: numbers a name matches, with the folders above them only', async () => {
    const asked: string[] = []
    const base = await nexus(asked)
    const market = nexusMarket({ url: base, repository: 'images', socs: { 'a/': 'soc-a', 'b/': 'soc-b' }, exclude: ['*/__probe__*'] })
    // Nexus answered a path match (img-folder-only) and a file outside the name (other.zip): neither is in the answer,
    // nor is one under an excluded path. The case of what was typed does not matter, and it keeps reading pages.
    const answer = await market.search!('IMG')
    const found = Array.isArray(answer) ? answer : answer.entries
    expect(Array.isArray(answer) ? false : answer.partial).toBe(false)
    expect(found.map(entry => `${entry.kind} ${entry.path} ${entry.soc}`)).toEqual([
      'folder a soc-a', 'image a/img.zip soc-a',
      'folder b soc-b', 'folder b/v2 soc-b', 'image b/v2/IMG2.zip soc-b',
    ])
    expect(found.find(entry => entry.path === 'a/img.zip')).toMatchObject({ size: 1234, sha256: sha })
    expect(asked.filter(item => item.startsWith('search'))).toEqual(['search images IMG ', 'search images IMG next'])
    // A folder, then what is in it: `a-b` (which sorts between `a` and `a/x.zip` as plain strings) comes after `a`'s
    // contents, so the page draws each image under its own folder.
    const order = (field: { entries: Array<{ path: string }> }) => field.entries.map(entry => entry.path)
    // The excluded path is not in it, and `a/img-folder-only` is not an image whose name matches.
    const sorted = await nexusMarket({ url: base, repository: 'images', exclude: ['*/__probe__*'] }).search!('img') as { entries: Array<{ path: string }> }
    expect(order(sorted)).toEqual(['a', 'a/img.zip', 'b', 'b/v2', 'b/v2/IMG2.zip'])
  })

  it('says where an image is fetched from, with the sha256 it must hash to, and refuses an excluded path', async () => {
    const market = nexusMarket({ url: await nexus([]), repository: 'images', exclude: ['*/__probe__*'] })
    expect(await market.locate('/a/img.zip')).toEqual({ url: 'https://nexus.example.org/repository/images/a/img.zip', name: 'img.zip', sha256: sha, size: 1234 })
    // Nexus knowing nothing of the file still gives the repository's own address for it.
    expect(await market.locate('a/other file.zip')).toMatchObject({ name: 'other file.zip', sha256: null, url: expect.stringMatching(/\/repository\/images\/a\/other%20file\.zip$/) })
    await expect(market.locate('a/__probe__')).rejects.toThrow(/不在这个市场里/)
  })

  it('reports a Nexus that refuses or is down', async () => {
    const down = nexusMarket({ url: 'http://127.0.0.1:1', repository: 'images' })
    await expect(down.list('')).rejects.toThrow()
    const market = nexusMarket({ url: await nexus([]), repository: 'images' })
    server!.removeAllListeners('request')
    server!.on('request', (_req, res) => { res.statusCode = 503; res.end('busy') })
    await expect(market.list('')).rejects.toThrow(/503/)
  })
})
