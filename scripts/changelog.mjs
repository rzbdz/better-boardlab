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
 * The release this tree last made: the newest version tag reachable from HEAD that is not HEAD itself (a release tag
 * marks the release commit, so the one being made is already on HEAD and is not a base), or a release.json this output
 * directory holds that names a later ancestor than that tag — releasing twice into one directory with no tag in
 * between counts from the previous run. A release.json older than the newest tag is a stale file from an old run and
 * is ignored. Null when there is none.
 *
 * `version` is the release being made. A stable one counts from the previous stable release: its changelog covers the
 * whole line since then, not just what changed since its last release candidate, so rc tags and an rc release.json are
 * passed over. An rc (or no version) counts from the previous release of either kind.
 */
export function previousRelease(cwd = root, out = join(cwd, 'release'), version = null) {
  const stable = !!version && !isCandidate(version)
  const head = git(cwd, 'rev-parse', 'HEAD')
  const commitOf = ref => { try { return git(cwd, 'rev-parse', `${ref}^{commit}`) } catch { return null } }
  /** A commit a release may be counted from: one on HEAD, and not HEAD itself. */
  const usable = ref => { const commit = ref && commitOf(ref); return commit && commit !== head && isAncestor(commit, cwd) ? commit : null }
  let best = null
  try {
    const tag = git(cwd, 'tag', '--merged', 'HEAD', '--sort=-v:refname', '--list', 'v[0-9]*').split('\n').filter(Boolean)
      .find(name => !(stable && isCandidate(name)) && usable(name))
    if (tag) best = { revision: commitOf(tag), version: tag.replace(/^v/, '') }
  } catch {}
  try {
    const previous = JSON.parse(readFileSync(join(out, 'release.json'), 'utf8'))
    const commit = stable && isCandidate(String(previous.version ?? '')) ? null : usable(previous.revision)
    // Later than the tag, or nothing else: a run that stopped before tagging left this. Earlier: stale, keep the tag.
    if (commit && (!best || after(commit, best.revision, cwd))) best = { revision: commit, version: previous.version }
  } catch {}
  return best
}

/** Whether a version (or a `v<version>` tag) is a release candidate (`0.4.49rc6`) rather than a stable release. */
export const isCandidate = version => /rc\d+$/.test(version)

/** Whether revision `a` is `later` or comes after `b` (either may be anything git resolves, such as a short hash). */
function after(a, later, cwd) {
  const commitOf = ref => { try { return git(cwd, 'rev-parse', `${ref}^{commit}`) } catch { return null } }
  const from = commitOf(a), to = commitOf(later)
  if (!from || !to) return false
  if (from === to) return true
  try { execFileSync('git', ['merge-base', '--is-ancestor', to, from], { cwd, stdio: 'ignore' }); return true } catch { return false }
}

/** The subjects of the commits since `from` (or of the last commit when there is no base), oldest first. */
export function subjectsSince(from, to = 'HEAD', cwd = root) {
  const args = ['log', '--no-merges', '--reverse', '--pretty=format:%s']
  if (from) args.push(`${from}..${to}`); else args.push('-1', to)
  return git(cwd, ...args).split('\n').map(line => line.trim()).filter(Boolean)
    // A release's marker commit (`release: 0.4.27`) is not a change; nor is the older `boardlab 0.4.6` spelling.
    .filter(subject => !/^(?:boardlab |release: )\d+\.\d+\.\d+(?:rc\d+)?$/.test(subject))
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
  const previous = previousRelease(root, option('out') ? dirname(resolve(option('out'))) : join(root, 'release'), version)
  const given = option('since')
  const since = given ?? previous?.revision ?? ''
  const revision = option('revision') ?? git(root, 'rev-parse', '--short', 'HEAD')
  const text = changelog(version, revision, subjectsSince(since, 'HEAD', root), { since: given ?? previous?.version })
  if (option('out')) { writeFileSync(resolve(option('out')), text); console.log(`wrote ${resolve(option('out'))}`) }
  else process.stdout.write(text)
}
