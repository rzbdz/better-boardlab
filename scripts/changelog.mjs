#!/usr/bin/env node
/**
 * The changelog of a release: what changed since the last one, as the markdown a release publishes. release.mjs writes
 * it beside the tarball (CHANGELOG.md); publish.mjs puts it on the release (a GitHub release's notes, the git release
 * branch's CHANGELOG.md and README).
 *
 *   node scripts/changelog.mjs [--since <ref>] [--out <file>]
 *
 * The base is `--since`, else the revision the previous release left in <out>/release.json, else the newest `v<version>`
 * tag reachable from HEAD. With no base (the first release), it lists the last commit. The commits' subjects are the
 * changelog, in the order they were made; a release's own marker commit is left out.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** Whether `ref` is a commit HEAD can be built on (a previous release from another line cannot serve as a base). */
function isAncestor(ref, cwd) {
  if (!ref) return false
  try { execFileSync('git', ['merge-base', '--is-ancestor', ref, 'HEAD'], { cwd, stdio: 'ignore' }); return true } catch { return false }
}

/**
 * The release this tree last made: the revision and version its release.json names while that revision is an ancestor,
 * else the newest version tag reachable from HEAD. Null when there is none.
 */
export function previousRelease(cwd = root, out = join(cwd, 'release')) {
  try {
    const previous = JSON.parse(readFileSync(join(out, 'release.json'), 'utf8'))
    if (isAncestor(previous.revision, cwd)) return { revision: previous.revision, version: previous.version }
  } catch {}
  try {
    const tag = git(cwd, 'tag', '--merged', 'HEAD', '--sort=-v:refname', '--list', 'v[0-9]*').split('\n').filter(Boolean)[0]
    if (tag && isAncestor(tag, cwd)) return { revision: tag, version: tag.replace(/^v/, '') }
  } catch {}
  return null
}

/** The subjects of the commits since `from` (or of the last commit when there is no base), oldest first. */
export function subjectsSince(from, to = 'HEAD', cwd = root) {
  const args = ['log', '--no-merges', '--reverse', '--pretty=format:%s']
  if (from) args.push(`${from}..${to}`); else args.push('-1', to)
  return git(cwd, ...args).split('\n').map(line => line.trim()).filter(Boolean)
    .filter(subject => !/^boardlab \d/.test(subject))
}

/** The markdown for one release: its version and revision, the day, the base, and the subjects. */
export function changelog(version, revision, subjects, options = {}) {
  const date = options.date ?? new Date().toISOString().slice(0, 10)
  const base = options.since ? ` · since ${options.since}` : ''
  const lines = [`# boardlab ${version}${revision ? ` (${revision})` : ''}`, '', `${date}${base}`, '']
  if (subjects.length) {
    lines.push('## Changes', '')
    for (const subject of subjects) lines.push(`- ${subject}`)
    lines.push('')
  } else {
    lines.push('No changes recorded since the last release.', '')
  }
  return lines.join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const option = name => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined }
  const version = option('version') ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const previous = previousRelease(root, option('out') ? dirname(resolve(option('out'))) : join(root, 'release'))
  const since = option('since') ?? previous?.revision ?? ''
  const revision = option('revision') ?? git(root, 'rev-parse', '--short', 'HEAD')
  const text = changelog(version, revision, subjectsSince(since, 'HEAD', root), { since: previous?.version })
  if (option('out')) { writeFileSync(resolve(option('out')), text); console.log(`wrote ${resolve(option('out'))}`) }
  else process.stdout.write(text)
}
