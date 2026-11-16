import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Declare the JavaScript helper's interface immediately below.
import { checkCoreVersion as check } from '../scripts/check-core-version.mjs'

const checkCoreVersion = check as (options?: {
  root?: string
  index?: boolean
  skipSignature?: boolean
  git?: (cwd: string, args: string[]) => string
  readPackage?: (path: string) => { version?: string }
}) => { version: string, revision: string, tag: string }

const revision = 'a'.repeat(40)
const otherRevision = 'b'.repeat(40)

type FixtureTag = { name: string, target?: string, annotated?: boolean }

function fixture({
  gitlink = revision,
  stagedGitlink = gitlink,
  checkout = revision,
  version = '1.2.3',
  tags = [{ name: 'v1.2.3' }] as FixtureTag[],
  signatureError,
}: {
  gitlink?: string
  stagedGitlink?: string
  checkout?: string
  version?: string
  tags?: FixtureTag[]
  signatureError?: Error
} = {}) {
  const calls: { cwd: string, args: string[] }[] = []
  const git = (cwd: string, args: string[]) => {
    calls.push({ cwd, args })
    if (args[0] === 'ls-tree') return `160000 commit ${gitlink}\tcore\n`
    if (args[0] === 'ls-files') return `160000 ${stagedGitlink} 0\tcore\n`
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return `${checkout}\n`
    if (args[0] === 'for-each-ref') {
      return tags.map(tag => `refs/tags/${tag.name}\0${tag.annotated === false ? 'commit' : 'tag'}\n`).join('')
    }
    if (args[0] === 'rev-parse' && args[1]?.endsWith('^{}')) {
      const name = args[1].slice('refs/tags/'.length, -'^{}'.length)
      const tag = tags.find(candidate => candidate.name === name)
      if (!tag) throw new Error('unknown tag')
      return `${tag.target ?? checkout}\n`
    }
    if (args[0] === 'verify-tag') {
      if (signatureError) throw signatureError
      return ''
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  }
  return { calls, git, readPackage: () => ({ version }) }
}

describe('core release provenance', () => {
  it('accepts matching full revisions, package version, and signed annotated tag', () => {
    const fake = fixture()
    expect(checkCoreVersion({ root: '/distribution', ...fake })).toEqual({ version: '1.2.3', revision, tag: 'v1.2.3' })
    expect(fake.calls.map(call => call.args)).toEqual([
      ['ls-tree', 'HEAD', '--', 'core'],
      ['rev-parse', 'HEAD'],
      ['for-each-ref', '--format=%(refname)%00%(objecttype)', 'refs/tags/'],
      ['rev-parse', 'refs/tags/v1.2.3^{}'],
      ['verify-tag', 'refs/tags/v1.2.3'],
    ])
  })

  it('checks a staged export gitlink instead of the previous committed gitlink', () => {
    const fake = fixture({ stagedGitlink: otherRevision, checkout: otherRevision })
    expect(checkCoreVersion({ root: '/distribution', index: true, ...fake })).toEqual({
      version: '1.2.3', revision: otherRevision, tag: 'v1.2.3',
    })
    expect(fake.calls[0]?.args).toEqual(['ls-files', '--stage', '--', 'core'])
    expect(fake.calls.some(call => call.args[0] === 'ls-tree')).toBe(false)
  })

  it('rejects a staged gitlink that differs from the core checkout', () => {
    const fake = fixture({ stagedGitlink: otherRevision })
    expect(() => checkCoreVersion({ index: true, ...fake })).toThrow(
      `core gitlink ${otherRevision} does not match core checkout ${revision}; check out the gitlink revision in core`,
    )
  })

  it('rejects an untagged core and says which signed tag is needed', () => {
    const fake = fixture({ tags: [] })
    expect(() => checkCoreVersion({ ...fake })).toThrow(`no annotated core vX.Y.Z tag peels to HEAD ${revision}; create signed annotated tag v1.2.3 at this revision`)
    expect(fake.calls.some(call => call.args[0] === 'verify-tag')).toBe(false)
  })

  it('rejects lightweight tags as release tags', () => {
    const fake = fixture({ tags: [{ name: 'v1.2.3', annotated: false }] })
    expect(() => checkCoreVersion({ ...fake })).toThrow(/no annotated core vX.Y.Z tag/)
  })

  it('rejects a non-release package version', () => {
    const fake = fixture({ version: '1.2' })
    expect(() => checkCoreVersion({ ...fake })).toThrow('core/package.json version "1.2" is not a release version X.Y.Z')
  })

  it('rejects a package version that disagrees with the tag at core HEAD', () => {
    const fake = fixture({ version: '1.2.3', tags: [{ name: 'v9.8.7' }] })
    expect(() => checkCoreVersion({ ...fake })).toThrow('core/package.json version 1.2.3 disagrees with annotated tag(s) at HEAD: v9.8.7; use tag v1.2.3 or correct the package version')
  })

  it('rejects a core checkout that differs from the superproject gitlink', () => {
    const fake = fixture({ checkout: otherRevision })
    expect(() => checkCoreVersion({ ...fake })).toThrow(`core gitlink ${revision} does not match core checkout ${otherRevision}; check out the gitlink revision in core`)
    expect(fake.calls.some(call => call.args[0] === 'for-each-ref')).toBe(false)
  })

  it('rejects duplicate matching version tags', () => {
    const fake = fixture({ tags: [{ name: 'v1.2.3' }, { name: 'v1.2.3' }] })
    expect(() => checkCoreVersion({ ...fake })).toThrow(`expected exactly one annotated tag v1.2.3 peeled to ${revision}, found 2; remove duplicate release tags`)
  })

  it('ignores another version tag while requiring the package version tag', () => {
    const fake = fixture({ tags: [{ name: 'v1.2.2', target: otherRevision }, { name: 'v1.2.3' }] })
    expect(checkCoreVersion({ ...fake }).tag).toBe('v1.2.3')
  })

  it('reports an invalid OpenPGP signature by default', () => {
    const fake = fixture({ signatureError: Object.assign(new Error('verify failed'), { stderr: 'error: no signature found\n' }) })
    expect(() => checkCoreVersion({ ...fake })).toThrow(/tag v1.2.3 .* does not have a valid OpenPGP signature; sign the annotated tag.*error: no signature found/)
  })

  it('checks a real temporary superproject and core without changing global git configuration', () => {
    const root = mkdtempSync(join(tmpdir(), 'boardlab-core-version-'))
    const core = join(root, 'core')
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    }
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' })
    try {
      mkdirSync(core)
      git(root, 'init', '-q')
      git(core, 'init', '-q')
      writeFileSync(join(core, 'package.json'), '{"name":"fixture-core","version":"1.2.3"}\n')
      git(core, 'add', 'package.json')
      git(core, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture core')
      git(core, 'tag', '-a', 'v1.2.3', '-m', 'fixture core 1.2.3')
      git(root, 'add', 'core')
      git(root, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture distribution')

      const committed = git(core, 'rev-parse', 'HEAD').toString().trim()
      expect(checkCoreVersion({ root, skipSignature: true })).toEqual({
        version: '1.2.3',
        revision: committed,
        tag: 'v1.2.3',
      })
      expect(() => checkCoreVersion({ root })).toThrow(/does not have a valid OpenPGP signature/)

      writeFileSync(join(core, 'package.json'), '{"name":"fixture-core","version":"1.2.4"}\n')
      git(core, 'add', 'package.json')
      git(core, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'prepare core export')
      git(core, 'tag', '-a', 'v1.2.4', '-m', 'fixture core 1.2.4')
      git(root, 'add', 'core')
      const exported = git(core, 'rev-parse', 'HEAD').toString().trim()
      expect(exported).not.toBe(committed)
      expect(checkCoreVersion({ root, index: true, skipSignature: true })).toEqual({
        version: '1.2.4', revision: exported, tag: 'v1.2.4',
      })
      expect(() => checkCoreVersion({ root, skipSignature: true })).toThrow(
        `core gitlink ${committed} does not match core checkout ${exported}; check out the gitlink revision in core`,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
