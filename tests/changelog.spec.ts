/**
 * The changelog a release publishes: what changed since the previous release, never "nothing" because the base was
 * the release being made (its own tag is on HEAD already) or its own marker commit.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { previousRelease, subjectsSince } from '../scripts/changelog.mjs'
import { dir, useTempDir } from './fakes.ts'

useTempDir()

const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim()
const commit = (subject: string, file = subject) => { writeFileSync(join(dir, file), subject); git('add', '-A'); git('commit', '-qm', subject); return git('rev-parse', 'HEAD') }

/** A repository with a "previous" release tagged and a work commit after it, then the version's own release commit tagged. */
function repository() {
  git('init', '-q', '-b', 'main')
  const previous = commit('feature: the first thing')
  git('tag', '-a', 'v0.4.1', '-m', 'v0.4.1')
  commit('feature: the second thing')
  commit('release: 0.4.2')
  git('tag', '-a', 'v0.4.2', '-m', 'v0.4.2')
  return { previous, tag: git('rev-parse', 'HEAD') }
}

describe('a release changelog', () => {
  it('counts from the release before this one, not from this release\'s own tag on HEAD', () => {
    const { previous } = repository()
    const base = previousRelease(dir, join(dir, 'nobody-has-this'))
    // The tree's newest tag is the release being made, which is HEAD: without a release.json it must be skipped.
    expect(base).toEqual({ revision: previous, version: '0.4.1' })
    // The marker commit a release is made with is not a change; the work is.
    expect(subjectsSince(base!.revision, 'HEAD', dir)).toEqual(['feature: the second thing'])
    expect(git('rev-parse', 'v0.4.1^{commit}')).toBe(previous)
    expect(git('rev-parse', 'v0.4.2^{commit}')).toBe(git('rev-parse', 'HEAD'))
  })

  it('skips a release.json that names this very commit', () => {
    const { previous } = repository()
    const out = join(dir, 'release')
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '0.4.2', revision: git('rev-parse', 'HEAD') }))
    expect(previousRelease(dir, out)).toEqual({ revision: previous, version: '0.4.1' })
  })

  it('takes the release.json the directory it is making last left, when that is an earlier commit', () => {
    const { previous } = repository()
    const out = join(dir, 'release')
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '0.4.1', revision: previous }))
    expect(previousRelease(dir, out)).toEqual({ revision: previous, version: '0.4.1' })
    writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '0.4.1', revision: 'f'.repeat(40) }))
    expect(previousRelease(dir, out)).toEqual({ revision: previous, version: '0.4.1' })
  })

  it('does not count from a release.json older than the newest tag it has', () => {
    const { previous, tag } = repository()
    commit('feature: the third thing')
    const out = join(dir, 'release')
    mkdirSync(out, { recursive: true })
    // A stale file from a run long ago: an ancestor, but older than the release tagged since.
    writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '0.0.9', revision: previous }))
    expect(previousRelease(dir, out)).toEqual({ revision: tag, version: '0.4.2' })
  })

  it('takes a release.json later than the tag: a run that stopped before tagging', () => {
    const { tag } = repository()
    const later = commit('feature: the fourth thing', 'fourth')
    commit('feature: the fifth thing', 'fifth')          // what a later fix leaves after the file was written
    const out = join(dir, 'release')
    mkdirSync(out, { recursive: true })
    // `v0.4.2` names a commit on HEAD; the file names the commit after it, which is what a run that stopped before
    // tagging leaves — the tag for the new release has not been made yet.
    writeFileSync(join(out, 'release.json'), JSON.stringify({ version: '0.4.3', revision: later }))
    expect(previousRelease(dir, out)).toEqual({ revision: later, version: '0.4.3' })
    expect(git('rev-parse', 'v0.4.2^{commit}')).toBe(tag)
  })

  it('leaves out a marker subject only when it is a version, not a change that starts the same way', () => {
    git('init', '-q', '-b', 'main')
    const made = commit('release: 0.4.2 makes the download retry')
    expect(subjectsSince('', 'HEAD', dir)).toContain('release: 0.4.2 makes the download retry')
    expect(git('rev-parse', 'HEAD')).toBe(made)
  })

  it('has no base for a first release, so the last commit is listed', () => {
    git('init', '-q', '-b', 'main')
    commit('feature: the only thing')
    expect(previousRelease(dir, join(dir, 'nobody-has-this'))).toBeNull()
    expect(subjectsSince('', 'HEAD', dir)).toEqual(['feature: the only thing'])
  })
})
