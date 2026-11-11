/**
 * The bsp site's endpoints, `/api/bsp/site/...`: what the site is (its source, revision, SDKs, build servers, SoC
 * profiles, what each host has), changing it (its source, pulling and pushing, SDKs and build servers, any catalog
 * document as YAML, taking one out), and syncing it to every bsp host, streamed like an install.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventStream, type Endpoint } from 'boardlab-core/core/api.ts'
import { BoardError } from 'boardlab-core/core/errors.ts'
import type { BoardLab } from 'boardlab-core/core/lab.ts'
import type { Hosts } from '../hosts/ssh.ts'
import { SiteSyncError, syncHost } from './provision.ts'
import type { Site } from './site.ts'

/** The labs that are bsp board hosts. */
const bspLabs = (lab: BoardLab) => lab.backends.labSettings().filter(item => item.addedAs === 'bsp')

export function siteEndpoints(lab: BoardLab, site: Site, hosts: Hosts | null): Endpoint[] {
  const done = <T>(holder: string, what: string, run: () => Promise<T>, say: (out: T) => string = out => String(out)) => run().then(
    out => { lab.kernel.record(holder, null, 'bsp-site', what, true, say(out).slice(0, 200)); return out },
    error => { lab.kernel.record(holder, null, 'bsp-site', what, false, (error as Error).message.slice(0, 200)); throw error })
  const text = (value: unknown) => typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)

  /** Bundle the site once, then ship it to each lab in turn; every host is tried, each result kept. */
  const sync = async (holder: string, only: string | null, out: (line: string) => void) => {
    if (!hosts) throw new BoardError('invalid', '这个 boardd 不能连主机')
    const labs = bspLabs(lab).filter(item => !only || item.id === only)
    if (only && !labs.length) throw new BoardError('not-found', `没有 bsp 主机 ${only}`)
    if (!labs.length) throw new BoardError('invalid', '还没有 bsp 主机：先添加一台')
    const problems = site.problems()
    if (problems.length) throw new BoardError('invalid', `站点有问题，主机读不进：${problems.join('；')}`)
    if (site.syncing) throw new BoardError('conflict', '已经在同步了，等它完成')
    site.syncing = true
    const dir = mkdtempSync(join(tmpdir(), 'boardlab-site-'))
    try {
      // What is shipped is the site as it is now, its images fetched first (one that is not there does not stop the
      // sync: it is said); edits while it goes out wait for the next sync.
      const bundle = join(dir, 'site.tgz')
      const { revision, images } = await site.ship(bundle, out)
      out(`站点 ${revision}，同步到 ${labs.map(item => item.id).join('、')}`)
      const results: Array<{ lab: string, ok: boolean, message: string, unknown?: boolean }> = []
      for (const item of labs) {
        out(`— ${item.id}`)
        try {
          const message = await lab.kernel.doing([`lab:${item.id}`], 'site-sync', '同步站点中', holder, line =>
            syncHost(hosts, item.url, bundle, text => { out(`  ${text}`); line(text) }))
          out(`  ${message}`)
          results.push({ lab: item.id, ok: true, message })
        } catch (error) {
          out(`  失败：${(error as Error).message}`)
          results.push({ lab: item.id, ok: false, message: (error as Error).message, ...(error instanceof SiteSyncError && error.left === 'unknown' ? { unknown: true } : {}) })
        }
        const last = results.at(-1)!
        // A host that failed has the revision it had put back: say what it has (not known when putting it back
        // failed too), and that the last try did not take.
        const had = site.hostSync(item.id)
        site.recordHost(item.id, { revision: last.ok ? revision : last.unknown ? '?' : had?.revision ?? '', at: new Date().toISOString(), ok: last.ok, message: last.message })
        lab.kernel.record(holder, null, 'bsp-site', `sync ${item.id} ${revision}`, last.ok, last.message.slice(0, 200))
      }
      return { revision, results, images }
    } finally {
      site.syncing = false
      rmSync(dir, { recursive: true, force: true })
    }
  }

  return [{
    method: 'GET', path: '/api/bsp/site', about: 'bsp 站点：来源、版本、SDK、编译服务器、编译方式、源码树、SoC 资料、问题，和每台主机上的站点版本',
    handle: () => site.status(bspLabs(lab).map(item => item.id)),
  }, {
    method: 'POST', path: '/api/bsp/site/source', about: '换站点的来源（source：managed 在这里管，或 git 加 url、branch：现在就取下来；这里的站点有它没有的改动时拒绝，discard=true 才丢掉）',
    handle: async ({ body, caller }) => ({ message: await done(caller.holder, `source ${text(body.source)} ${text(body.url)}`, () => site.setSource(caller.holder, { source: text(body.source), url: text(body.url), branch: text(body.branch), discard: body.discard === true })) }),
  }, {
    method: 'POST', path: '/api/bsp/site/pull', about: '从 git 来源拉取站点（这里的提交排在拉下来的之后；冲突时什么都不变）',
    handle: ({ caller }) => done(caller.holder, 'pull', () => site.pull(caller.holder), out => out.message),
  }, {
    method: 'POST', path: '/api/bsp/site/push', about: '把这里对站点的提交推送到 git 来源',
    handle: async ({ caller }) => ({ message: await done(caller.holder, 'push', () => site.push()) }),
  }, {
    method: 'POST', path: '/api/bsp/site/sdk', about: '添加或修改一个 SDK（id、family、server+path 或 workspace、soc、description、boot 的 YAML；改名或修改时给 original）',
    handle: ({ body, caller }) => done(caller.holder, `sdk ${text(body.id)}`, () => site.putSdk(caller.holder, {
      id: text(body.id), family: text(body.family), server: text(body.server), path: text(body.path), workspace: text(body.workspace),
      soc: text(body.soc), description: text(body.description), boot: text(body.boot), original: text(body.original),
    }), out => out.file),
  }, {
    method: 'POST', path: '/api/bsp/site/server', about: '添加或修改一台编译服务器（id、host、user、description；修改时给 original）',
    handle: ({ body, caller }) => done(caller.holder, `server ${text(body.id)}`, () => site.putServer(caller.holder, {
      id: text(body.id), host: text(body.host), user: text(body.user), description: text(body.description), original: text(body.original),
    }), out => out.file),
  }, {
    method: 'POST', path: '/api/bsp/site/doc', about: '用 YAML 写一个 SDK 目录文档（kind：instances|servers|workspaces|families，id，text；修改时给 original）',
    handle: ({ body, caller }) => done(caller.holder, `${text(body.kind)} ${text(body.id)}`, () => site.putDoc(caller.holder, text(body.kind), text(body.id), text(body.text), text(body.original) || undefined), out => out.file),
  }, {
    method: 'POST', path: '/api/bsp/site/remove', about: '从站点删掉一个文档（kind、id）；还有别的在用它时不删',
    handle: async ({ body, caller }) => ({ message: await done(caller.holder, `remove ${text(body.kind)} ${text(body.id)}`, () => site.remove(caller.holder, text(body.kind), text(body.id))) }),
  }, {
    method: 'POST', path: '/api/bsp/site/sync', about: '先取站点的镜像，再把站点（socs、sdk、hooks、.blobs）同步到每台 bsp 主机（或 lab 指定的一台）并让 bspd 重新读它，输出边做边推送',
    handle: ({ body, caller }) => new EventStream(async (emit, end) => {
      try {
        const { revision, results, images } = await sync(caller.holder, text(body.lab) || null, line => emit('out', { text: line }))
        const failed = results.filter(result => !result.ok)
        const message = failed.length ? `${failed.length} 台没同步上：${failed.map(result => `${result.lab}（${result.message}）`).join('；')}` : `${results.length} 台主机都是站点 ${revision} 了`
        emit('exit', { ok: !failed.length, revision, results, images, message: images && !images.ok ? `${message}；${images.message}` : message })
      } catch (error) { emit('exit', { ok: false, message: (error as Error).message }) }
      end()
    }),
  }]
}
