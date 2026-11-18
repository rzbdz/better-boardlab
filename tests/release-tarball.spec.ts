/**
 * What a release tarball carries: the committed inputs, and only those. A file that is in the worktree but not in the
 * git index — a key, a token, a log left there by hand, all of them gitignored — is never part of a release; `dist/`,
 * which is generated, is the one thing taken from the worktree.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dir, useTempDir } from './fakes.ts'

useTempDir()

const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: dir, encoding: 'utf8' }).trim()

describe('a release tarball', () => {
  it('carries what the commit has and nothing else lying beside it', () => {
    git('init', '-q', '-b', 'main')
    mkdirSync(join(dir, 'skills'), { recursive: true })
    mkdirSync(join(dir, 'docs/help'), { recursive: true })
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(join(dir, 'skills/SKILL.md'), 'skill')
    writeFileSync(join(dir, 'docs/help/site.md'), 'help')
    writeFileSync(join(dir, 'README.md'), 'readme')
    writeFileSync(join(dir, 'dist/cli.js'), 'built')
    writeFileSync(join(dir, '.gitignore'), '*.key\n*.log\ndist/\n')
    git('add', '-A'); git('commit', '-qm', 'release inputs')
    // Beside the tracked files: a key and a log that are ignored, and a note nobody added. `dist/` is ignored too, and
    // is the one thing that must still travel.
    writeFileSync(join(dir, 'docs/help/host.key'), 'PRIVATE')
    writeFileSync(join(dir, 'skills/build.log'), 'log')
    writeFileSync(join(dir, 'skills/notes.md'), 'untracked')

    // The commands release.mjs runs to fill its stage.
    const stage = join(dir, 'stage')
    mkdirSync(stage, { recursive: true })
    // The commands release.mjs runs to fill its stage: the generated client from the worktree, the inputs from the
    // index.
    execFileSync('sh', ['-c', `tar -cf - dist | tar -xf - -C '${stage}'`], { cwd: dir })
    execFileSync('sh', ['-c', `git ls-files -z -- skills docs/help LICENSE README.md | tar --null -cf - -T - | tar -xf - -C '${stage}'`], { cwd: dir })

    const taken = execFileSync('find', ['.', '-type', 'f'], { cwd: stage, encoding: 'utf8' }).split('\n').filter(Boolean).map(path => path.replace(/^\.\//, '')).sort()
    expect(taken).toEqual(['README.md', 'dist/cli.js', 'docs/help/site.md', 'skills/SKILL.md'])
    expect(readFileSync(join(stage, 'docs/help/site.md'), 'utf8')).toBe('help')
  })
})
