/**
 * The `nexus-images` module: image markets over a Nexus raw repository. Nexus is open source, so this is generic: which
 * server, which repository and which folder belongs to which SoC is a market's configuration (a site's), never here.
 * A folder of the repository is a folder of the market; a file in it is an image.
 */
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import tls from 'node:tls'
import type { ImageMarket, MarketFound, MarketImage } from 'boardlab-core/core/markets.ts'
import type { Module } from 'boardlab-core/core/module.ts'
import type { MarketEntry } from 'boardlab-core/shared/types.ts'

interface Config {
  /** The server's address without a trailing `/`. */
  base: string
  repository: string
  /** Folder prefixes and the SoC each belongs to, longest prefix first. */
  socs: Array<[string, string]>
  /** Paths (with `*`) the market leaves out. */
  exclude: string[]
}

interface Asset { path: string, downloadUrl?: string, fileSize?: number, lastModified?: string, checksum?: { sha256?: string } }
interface Node { id: string, text: string, type?: string, leaf?: boolean }

/** `*` matches any run of characters, anything else itself. */
export function matches(pattern: string, text: string): boolean {
  const parts = pattern.split('*')
  if (parts.length === 1) return text === pattern
  const first = parts[0]!, last = parts.at(-1)!
  if (!text.startsWith(first)) return false
  let at = first.length
  for (const part of parts.slice(1, -1)) {
    const found = text.indexOf(part, at)
    if (found < 0) return false
    at = found + part.length
  }
  return text.length - last.length >= at && text.endsWith(last)
}

/** How many pages of Nexus's index a search reads (1000 assets a page; the real repository answers 50): past it, what
 * it did not reach is not found. A common word such as a SoC's name matches a few thousand assets here. */
const FIND_PAGES = 100

/**
 * A folder, then what is in it, each in the order its path reads: by name one level at a time, so `a`, `a/x.zip`, `a-b`
 * (a plain sort of the paths strings would put `a-b` between `a` and `a/x.zip`, which the page would draw inside `a`).
 */
function treeOrder(entries: MarketEntry[]): MarketEntry[] {
  const parts = new Map(entries.map(entry => [entry, entry.path.split('/')]))
  return entries.sort((x, y) => {
    const a = parts.get(x)!, b = parts.get(y)!
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1
    }
    return a.length - b.length
  })
}

const roots = new Map<string, string[]>()
/** The certificates a request trusts: the bundled and the system's, and the distribution's own CA file when it has one. */
function trusted(file: string | null): string[] {
  const key = file ?? ''
  let list = roots.get(key)
  if (!list) {
    let system: string[] = []
    try { system = (tls as unknown as { getCACertificates?: (kind: string) => string[] }).getCACertificates?.('system') ?? [] } catch {}
    list = [...tls.rootCertificates, ...system, ...(file ? [readFileSync(file, 'utf8')] : [])]
    roots.set(key, list)
  }
  return list
}

/** The market's settings, checked: what is wrong is said, so the page can show it. */
export function nexusConfig(config: Record<string, unknown>): Config {
  const url = typeof config.url === 'string' ? config.url.replace(/\/+$/, '') : ''
  if (!/^https?:\/\/[^/\s]+/.test(url)) throw new Error('url 要写 Nexus 的地址（http:// 或 https://）')
  // Its images are fetched by links under this address, and a link never carries a name or password.
  if (/^https?:\/\/[^/]*@/.test(url)) throw new Error('url 里不能写用户名或密码：仓库要能匿名读')
  if (typeof config.repository !== 'string' || !/^[A-Za-z0-9._-]+$/.test(config.repository)) throw new Error('repository 要写仓库名')
  const socs = config.socs ?? {}
  if (typeof socs !== 'object' || Array.isArray(socs) || Object.values(socs as object).some(soc => typeof soc !== 'string')) throw new Error('socs 要写成 {目录前缀: SoC}，例如 {"a/": "soc-a"}')
  const exclude = config.exclude ?? []
  if (!Array.isArray(exclude) || exclude.some(item => typeof item !== 'string')) throw new Error('exclude 要是路径模式的数组')
  const prefixes = Object.entries(socs as Record<string, string>).map(([prefix, soc]) => [prefix.replace(/^\/+/, ''), soc] as [string, string])
  return { base: url, repository: config.repository, socs: prefixes.sort((a, b) => b[0].length - a[0].length), exclude: exclude as string[] }
}

function send(config: Config, ca: string | null, method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${config.base}${path}`)
    const payload = body === undefined ? null : JSON.stringify(body)
    const secure = url.protocol === 'https:'
    const headers: Record<string, string | number> = { accept: 'application/json', 'x-nexus-ui': 'true' }
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload) }
    // node's own client: the fetch built into node rejects a header Nexus sends.
    const req = (secure ? httpsRequest : httpRequest)(url, { method, signal, timeout: 30_000, headers, ...(secure ? { ca: trusted(ca) } : {}) }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if ((response.statusCode ?? 500) >= 400) return reject(new Error(`Nexus 答了 ${response.statusCode}：${text.slice(0, 120)}`))
        try { resolve(JSON.parse(text)) } catch { reject(new Error('Nexus 的答复不是 JSON')) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('Nexus 30 秒没有答')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

export function nexusMarket(settings: Record<string, unknown>, caFile: () => string | null = () => null): ImageMarket {
  const config = nexusConfig(settings)
  const ask = (method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal) => send(config, caFile(), method, path, body, signal)
  const clean = (path: string) => path.replace(/^\/+|\/+$/g, '')
  const soc = (path: string) => config.socs.find(([prefix]) => `${path}/`.startsWith(prefix) || path.startsWith(prefix))?.[1] ?? null
  const left = (path: string) => config.exclude.some(pattern => matches(pattern, path))

  /** One folder as Nexus's browser reads it: its folders and files. */
  async function browse(path: string, signal?: AbortSignal): Promise<Node[]> {
    const body = { action: 'coreui_Browse', method: 'read', data: [{ repositoryName: config.repository, node: path || '/' }], type: 'rpc', tid: 1 }
    const answer = await ask('POST', '/service/extdirect', body, signal) as { result?: { success?: boolean, data?: Node[], message?: string } }
    if (!answer.result?.success) throw new Error(answer.result?.message ?? 'Nexus 读不了这个目录')
    return answer.result.data ?? []
  }

  /** What Nexus knows of the files in a folder (size, time, sha256), by path; a page or two of it. */
  async function assets(folder: string, signal?: AbortSignal): Promise<Map<string, Asset>> {
    const found = new Map<string, Asset>()
    let token: string | undefined
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ repository: config.repository, group: `/${folder}` })
      if (token) query.set('continuationToken', token)
      const answer = await ask('GET', `/service/rest/v1/search/assets?${query}`, undefined, signal) as { items?: Asset[], continuationToken?: string | null }
      for (const asset of answer.items ?? []) found.set(clean(asset.path), asset)
      token = answer.continuationToken ?? undefined
      if (!token) break
    }
    return found
  }

  const parent = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''

  /**
   * Images by name, from Nexus's own index of the repository (`search/assets?q=`): every page of it, so all of them are
   * found, each with its folders above it and nothing else. Nexus matches a path or a name without regard to case, so
   * the answer is checked against the name — its matches are more, never fewer. Past `FIND_PAGES` the index is left
   * where it is and the answer says it is not whole.
   */
  async function find(text: string, signal?: AbortSignal): Promise<MarketFound> {
    const words = text.toLowerCase()
    const found = new Map<string, MarketEntry>()
    let token: string | undefined, partial = false
    for (let page = 0; page < FIND_PAGES; page++) {
      const query = new URLSearchParams({ repository: config.repository, q: text })
      if (token) query.set('continuationToken', token)
      const answer = await ask('GET', `/service/rest/v1/search/assets?${query}`, undefined, signal) as { items?: Asset[], continuationToken?: string | null }
      for (const asset of answer.items ?? []) {
        const place = clean(asset.path ?? '')
        if (!place || found.has(place) || left(place)) continue
        const name = place.split('/').at(-1)!
        if (!name.toLowerCase().includes(words)) continue
        const parts = place.split('/').slice(0, -1)
        for (let i = 1; i <= parts.length; i++) {
          const folder = parts.slice(0, i).join('/')
          if (!found.has(folder)) found.set(folder, { path: folder, name: parts[i - 1]!, kind: 'folder', soc: soc(folder) })
        }
        found.set(place, { path: place, name, kind: 'image', soc: soc(place), size: asset.fileSize ?? null, sha256: asset.checksum?.sha256 ?? null, modified: asset.lastModified ?? null })
      }
      token = answer.continuationToken ?? undefined
      if (!token) break
      partial = page === FIND_PAGES - 1
    }
    return { entries: treeOrder([...found.values()]), partial }
  }

  return {
    // Every image of a repository comes from its own address.
    scheme: new URL(config.base).protocol.replace(':', ''),
    // Nexus's index answers a search of the whole repository far faster than every folder of it can be read: 763
    // folders take ~20 s one at a time, a name's assets and their folders a few seconds.
    search: (text, signal) => find(text, signal),
    async list(path, signal) {
      const nodes = (await browse(path, signal)).map(node => ({ node, path: clean(node.id || `${path}/${node.text}`) })).filter(item => !left(item.path))
      let details = new Map<string, Asset>()
      // Sizes and sha256 are a nicety: a market that cannot read them still lists.
      if (nodes.some(item => item.node.leaf)) try { details = await assets(path, signal) } catch {}
      return nodes.map(({ node, path: place }): MarketEntry => {
        if (!node.leaf) return { path: place, name: node.text, kind: 'folder', soc: soc(place) }
        const asset = details.get(place)
        return { path: place, name: node.text, kind: 'image', soc: soc(place), size: asset?.fileSize ?? null, sha256: asset?.checksum?.sha256 ?? null, modified: asset?.lastModified ?? null }
      })
    },
    async locate(path, signal): Promise<MarketImage> {
      const place = clean(path)
      if (left(place)) throw new Error(`${place} 不在这个市场里`)
      let asset: Asset | undefined
      try { asset = (await assets(parent(place), signal)).get(place) } catch {}
      const url = asset?.downloadUrl ?? `${config.base}/repository/${config.repository}/${place.split('/').map(encodeURIComponent).join('/')}`
      return { url, name: place.split('/').at(-1)!, sha256: asset?.checksum?.sha256 ?? null, size: asset?.fileSize ?? null }
    },
  }
}

export function nexusImages(): Module {
  return {
    id: 'nexus-images',
    title: 'Nexus 镜像市场',
    setup(lab) {
      lab.markets.offer({
        kind: 'nexus', title: 'Nexus', about: 'Nexus 的 raw 仓库：目录是文件夹，文件是镜像；哪个目录属于哪个 SoC 由市场设置里的 socs 说',
        create: config => nexusMarket(config, () => { const file = lab.kernel.setting('ca.cert'); return typeof file === 'string' && file ? file : null }),
      })
    },
  }
}
