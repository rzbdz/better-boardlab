import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dir, useTempDir } from './fakes.ts'
import { releaseMetadata, releaseVersion, verifyStagedRelease, verifyStablePublication } from '../scripts/release-metadata.mjs'
import { distributionIdentity } from '../src/release.ts'

useTempDir()
const revision = 'a'.repeat(40)
const coreRevision = 'b'.repeat(40)
const sha256 = 'c'.repeat(64)
const core = { version: '0.2.0', revision: coreRevision, tag: 'v0.2.0' }

describe('release metadata', () => {
  it('uses the distribution manifest as the only requested version source', () => {
    expect(releaseVersion('0.4.6rc1')).toBe('0.4.6rc1')
    expect(() => releaseVersion('0.4.6rc1', '0.4.5')).toThrow(/does not match/)
    for (const version of ['0.4.6rc0', '1.0.0', '0.4.6-beta', 'v0.4.6']) {
      expect(() => releaseVersion(version)).toThrow(/unsupported release version/)
    }
  })

  it('records full distribution and tagged core provenance', () => {
    expect(releaseMetadata({ version: '0.4.6rc1', revision, file: 'boardlab-0.4.6rc1.tar.gz', sha256, core })).toEqual({
      version: '0.4.6rc1', revision, file: 'boardlab-0.4.6rc1.tar.gz', sha256, core,
    })
    expect(() => releaseMetadata({ version: '0.4.6rc1', revision: 'abc1234', file: 'boardlab-0.4.6rc1.tar.gz', sha256, core })).toThrow(/full source revision/)
    expect(() => releaseMetadata({ version: '0.4.6rc1', revision, file: 'other.tar.gz', sha256, core })).toThrow(/artifact name/)
    expect(() => releaseMetadata({ version: '0.4.6rc1', revision, file: 'boardlab-0.4.6rc1.tar.gz', sha256, core: { ...core, tag: 'v0.1.0' } })).toThrow(/tagged core/)
  })

  it('finds installed distribution identity without confusing it with core', () => {
    const installed = join(dir, 'releases/0.4.6rc1')
    mkdirSync(join(installed, 'dist'), { recursive: true })
    writeFileSync(join(installed, 'VERSION'), '0.4.6rc1\n')
    writeFileSync(join(installed, 'REVISION'), `${revision}\n`)
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'boardlab', version: 'wrong' }))
    expect(distributionIdentity(join(installed, 'dist'))).toEqual({ version: '0.4.6rc1', revision })
    const source = join(dir, 'source/core')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'boardlab-core', version: '0.2.0' }))
    expect(distributionIdentity(source)).toEqual({ version: 'dev', revision: 'dev' })
    writeFileSync(join(dir, 'source/package.json'), JSON.stringify({ name: 'boardlab', version: '0.4.6rc1' }))
    expect(distributionIdentity(source)).toEqual({ version: 'dev', revision: 'dev' })
    mkdirSync(join(dir, 'source/.git'))
    expect(distributionIdentity(source)).toEqual({ version: '0.4.6rc1', revision: 'dev' })
  })

  it('requires an existing signed stable tag at the released revision', () => {
    const calls: string[][] = []
    const git = (...args: string[]) => {
      calls.push(args)
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return revision
      if (args[0] === 'rev-parse') return revision
      return ''
    }
    expect(verifyStablePublication({ release: { version: '0.4.6', revision }, git })).toBe('v0.4.6')
    expect(calls).toContainEqual(['verify-tag', 'v0.4.6'])
    expect(() => verifyStablePublication({ release: { version: '0.4.6rc1', revision }, git })).toThrow(/stable/)
    expect(() => verifyStablePublication({ release: { version: '0.4.6', revision: 'b'.repeat(40) }, git })).toThrow(/source checkout/)
  })

  it('runs the staged CLI in an isolated home and requires matching identity', () => {
    const stage = join(dir, 'staged')
    mkdirSync(join(stage, 'dist'), { recursive: true })
    writeFileSync(join(stage, 'VERSION'), '0.4.6rc1\n')
    writeFileSync(join(stage, 'REVISION'), `${revision}\n`)
    writeFileSync(join(stage, 'CORE_VERSION'), '0.2.0\n')
    writeFileSync(join(stage, 'CORE_REVISION'), `${coreRevision}\n`)
    writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'boardlab', version: '0.4.6rc1' }))
    writeFileSync(join(stage, 'dist/cli.js'), 'console.log(JSON.stringify({cli:{version:"0.4.6rc1",revision:"' + revision + '"}}))')
    const run = (_command: string, args: string[], options: import('node:child_process').ExecFileSyncOptionsWithStringEncoding) => {
      expect(args).toEqual([join(stage, 'dist/cli.js'), 'version', '--json'])
      expect(options.env?.BOARDS_REMOTE).toBeUndefined()
      return JSON.stringify({ cli: { version: '0.4.6rc1', revision } })
    }
    expect(verifyStagedRelease({ stage, version: '0.4.6rc1', revision, core, run })).toEqual({ version: '0.4.6rc1', revision })
    expect(() => verifyStagedRelease({ stage, version: '0.4.6rc1', revision, core, run: () => JSON.stringify({ cli: { version: '0.4.6rc1', revision: 'dev' } }) })).toThrow(/packaged CLI reports/)
    writeFileSync(join(stage, 'CORE_VERSION'), '0.1.0\n')
    expect(() => verifyStagedRelease({ stage, version: '0.4.6rc1', revision, core, run })).toThrow(/core provenance/)
  })
})
