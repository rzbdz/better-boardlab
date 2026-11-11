/**
 * The system module: an installed boardlab knows its version and where its releases come from, asks there at most
 * every few hours (or when asked), and says when a newer one is out; one run from source has nothing to check.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from 'boardlab-core/core/db.ts'
import { BoardLab } from 'boardlab-core/core/lab.ts'
import { system } from '../src/modules/system/index.ts'
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

  it('has nothing to check when run from source, and says so when asked to update', async () => {
    const lab = new BoardLab({ db: openDatabase(join(dir, 'b.sqlite')), modules: [system({ root: null })] })
    expect(await call(lab, 'GET', '/api/system/version')).toMatchObject({ version: 'dev', source: null, newer: false })
    await expect(call(lab, 'POST', '/api/system/update', {})).rejects.toThrow(/不是用 install.sh 装的/)
  })
})
