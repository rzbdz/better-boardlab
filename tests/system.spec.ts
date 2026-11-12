/**
 * The system module: an installed boardlab knows its version and where its releases come from, asks there at most
 * every few hours (or when asked), and says when a newer one is out; one run from source has nothing to check.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from 'boardlab-core/core/db.ts'
import { BoardLab } from 'boardlab-core/core/lab.ts'
import { sourcePattern, system } from '../src/modules/system/index.ts'
import { dir, useTempDir } from './fakes.ts'

useTempDir()

/** An endpoint called in the process, as the HTTP gateway would (the query in the path). */
async function call(lab: BoardLab, method: 'GET' | 'POST', path: string, body: Record<string, unknown> = {}) {
  const url = new URL(path, 'http://boardd')
  const found = lab.api.match(method, url.pathname)
  if (!found) throw new Error(`no ${method} ${url.pathname}`)
  return found.endpoint.handle({ query: url.searchParams, params: found.params, body, caller: { holder: 'user:alice', local: true } } as never)
}

function installed(version: string, revision: string, source: string) {
  const prefix = join(dir, 'opt/boardlab'), root = join(prefix, 'releases', `${version}-${revision}`)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'VERSION'), version); writeFileSync(join(root, 'REVISION'), revision)
  writeFileSync(join(prefix, 'release-source'), source); writeFileSync(join(prefix, 'install.sh'), '#!/bin/sh\n')
  return root
}

describe('the system module', () => {
  it('says when a newer release is out, asking the release source at most once per ttl unless asked to check', async () => {
    let latest = { version: '0.2.0', revision: 'aaa1111' }, asked = 0
    const fetch = async (url: string) => { asked++; expect(url).toBe('https://example.test/boardlab/release.json'); return JSON.stringify(latest) }
    let now = Date.parse('2026-11-11T00:00:00Z')
    const lab = new BoardLab({ db: openDatabase(join(dir, 'b.sqlite')), now: () => now, modules: [system({ root: installed('0.2.0', 'aaa1111', 'https://example.test/boardlab/'), ttlMs: 3600_000, fetch })] })
    const api = (path: string) => call(lab, 'GET', path)
    expect(await api('/api/system/version')).toMatchObject({ version: '0.2.0', revision: 'aaa1111', newer: false, latest: { revision: 'aaa1111' } })
    latest = { version: '0.3.0', revision: 'bbb2222' }
    expect(await api('/api/system/version')).toMatchObject({ newer: false })            // cached
    expect(asked).toBe(1)
    expect(await api('/api/system/version?check=1')).toMatchObject({ newer: true, latest: { version: '0.3.0' } })
    now += 2 * 3600_000
    latest = { version: '0.3.1', revision: 'ccc3333' }
    expect(await api('/api/system/version')).toMatchObject({ newer: true, latest: { version: '0.3.1' } })   // the ttl ran out
    expect(asked).toBe(3)
  })

  it('asks a project API for release.json on its branch, with the kept token', async () => {
    const asked: Array<[string, Record<string, string> | undefined]> = []
    const root = installed('0.2.0', 'aaa1111', 'https://git.example.test/api/v4/projects/7#release')
    writeFileSync(join(dir, 'opt/boardlab/release-token'), 'glpat-x\n')
    const fetch = async (url: string, headers?: Record<string, string>) => { asked.push([url, headers]); return JSON.stringify({ version: '0.3.0', revision: 'bbb2222' }) }
    const lab = new BoardLab({ db: openDatabase(join(dir, 'b.sqlite')), modules: [system({ root, fetch })] })
    expect(await call(lab, 'GET', '/api/system/version?check=1')).toMatchObject({ newer: true, latest: { version: '0.3.0' } })
    expect(asked).toEqual([['https://git.example.test/api/v4/projects/7/repository/files/release.json/raw?ref=release', { 'PRIVATE-TOKEN': 'glpat-x' }]])
  })

  it('switches the release source: checks it first, keeps it and its token readable only by the owner, masks the token', async () => {
    const asked: Array<[string, Record<string, string> | undefined]> = []
    const root = installed('0.2.0', 'aaa1111', 'https://example.test/boardlab/')
    const prefix = join(dir, 'opt/boardlab')
    const fetch = async (url: string, headers?: Record<string, string>) => {
      asked.push([url, headers])
      if (url.includes('missing')) throw new Error(`${url}：404`)
      return JSON.stringify({ version: '0.4.0', revision: 'ddd4444' })
    }
    const lab = new BoardLab({ db: openDatabase(join(dir, 'b.sqlite')), modules: [system({ root, fetch })] })
    expect(await call(lab, 'GET', '/api/system/source')).toEqual({ source: 'https://example.test/boardlab/', token: null })
    const api = 'https://git.example.test/api/v4/projects/9#stable'
    // check: only what is there, nothing kept.
    expect(await call(lab, 'POST', '/api/system/source', { source: api, token: 'glpat-secret1234', check: true })).toMatchObject({ version: '0.4.0', revision: 'ddd4444' })
    expect(asked.at(-1)).toEqual(['https://git.example.test/api/v4/projects/9/repository/files/release.json/raw?ref=stable', { 'PRIVATE-TOKEN': 'glpat-secret1234' }])
    expect(readFileSync(join(prefix, 'release-source'), 'utf8')).toBe('https://example.test/boardlab/')
    expect(existsSync(join(prefix, 'release-token'))).toBe(false)
    // save.
    expect(await call(lab, 'POST', '/api/system/source', { source: api, token: 'glpat-secret1234' })).toMatchObject({ source: api, version: '0.4.0' })
    expect(readFileSync(join(prefix, 'release-source'), 'utf8').trim()).toBe(api)
    expect(readFileSync(join(prefix, 'release-token'), 'utf8').trim()).toBe('glpat-secret1234')
    expect(statSync(join(prefix, 'release-token')).mode & 0o777).toBe(0o600)
    expect(statSync(join(prefix, 'release-source')).mode & 0o777).toBe(0o600)
    const shown = await call(lab, 'GET', '/api/system/source') as { source: string, token: string }
    expect(shown).toEqual({ source: api, token: '••••1234' })
    expect(await call(lab, 'GET', '/api/system/version')).toMatchObject({ source: api, newer: true, latest: { version: '0.4.0' } })
    // No token given: the kept one is used and kept; an empty one removes it.
    await call(lab, 'POST', '/api/system/source', { source: 'https://git.example.test/api/v4/projects/9#release' })
    expect(asked.at(-1)?.[1]).toEqual({ 'PRIVATE-TOKEN': 'glpat-secret1234' })
    await call(lab, 'POST', '/api/system/source', { source: 'git@git.example.test:lab/boardlab.git#release', token: '' })
    expect(existsSync(join(prefix, 'release-token'))).toBe(false)
    expect(asked.at(-1)?.[0]).toBe('git@git.example.test:lab/boardlab.git#release')
    // A source with nothing there, or not a source at all, changes nothing.
    await expect(call(lab, 'POST', '/api/system/source', { source: 'https://example.test/missing/' })).rejects.toThrow(/拿不到 release.json/)
    await expect(call(lab, 'POST', '/api/system/source', { source: 'https://x.test/a; rm -rf /' })).rejects.toThrow(/来源不认识/)
    expect(readFileSync(join(prefix, 'release-source'), 'utf8').trim()).toBe('git@git.example.test:lab/boardlab.git#release')
  })

  it('takes the source forms install.sh takes, and nothing a shell could read more into', () => {
    for (const good of ['https://example.test/boardlab/', 'http://10.0.0.5:8080/rel', 'git@git.example.test:lab/boardlab.git#release',
      'ssh://git@git.example.test:2222/lab/boardlab.git#v1', 'https://git.example.test/lab/boardlab.git#release',
      'https://git.example.test/api/v4/projects/42#release', 'https://git.example.test/api/v4/projects/lab%2Fboardlab#main'])
      expect(sourcePattern.test(good), good).toBe(true)
    for (const bad of ['', 'ftp://x.test/a', 'https://x.test/a b', 'https://x.test/$(id)', 'git@x.test:a.git#b;id', 'https://x.test/`id`', '-oProxyCommand=id', 'file:///etc', 'https://x.test/a\nb'])
      expect(sourcePattern.test(bad), bad).toBe(false)
  })

  it('has nothing to check when run from source, and says so when asked to update', async () => {
    const lab = new BoardLab({ db: openDatabase(join(dir, 'b.sqlite')), modules: [system({ root: null })] })
    expect(await call(lab, 'GET', '/api/system/version')).toMatchObject({ version: 'dev', source: null, newer: false })
    await expect(call(lab, 'POST', '/api/system/update', {})).rejects.toThrow(/不是用 install.sh 装的/)
    await expect(call(lab, 'POST', '/api/system/source', { source: 'https://example.test/boardlab/' })).rejects.toThrow(/不是用 install.sh 装的/)
  })
})
