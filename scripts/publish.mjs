#!/usr/bin/env node
/**
 * Publish a release made by scripts/release.mjs, where install.sh and boardd's update checks fetch it from:
 *
 *   node scripts/publish.mjs git <repository> [--branch release] [--out release]
 *       the release as the only commit of a branch (replaced each time), with its CHANGELOG.md. The source's signed
 *       v<version> tag must already identify release.json's full revision; publication never creates or moves it:
 *       for a server reached over ssh (`--source <repository>#release`) or through a git server's project API
 *       (`--source <api>/projects/<id>#release`)
 *   node scripts/publish.mjs github <owner/repo> [--out release] [--keep 3]
 *       a GitHub release v<version> with the tarball, release.json, install.sh and the changelog as its notes, marked
 *       latest, and deletes release assets beyond the newest `keep` (3) without deleting their immutable source tags
 *
 * The commit is signed when git is set up to sign (user.signingkey), with this repository's identity and signing
 * settings (gpg.format, gpg.program, gpg.ssh.program).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { changelog, subjectsSince } from './changelog.mjs'
import { verifyStablePublication } from './release-metadata.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [how, where, ...rest] = process.argv.slice(2)
const option = (name, fallback) => { const at = rest.indexOf(`--${name}`); return at >= 0 ? rest[at + 1] : fallback }
const out = resolve(option('out', join(root, 'release')))
if (!how || !where || !['git', 'github'].includes(how)) {
  console.error('usage: publish.mjs git <repository> [--branch release] | publish.mjs github <owner/repo>')
  process.exit(2)
}
const release = JSON.parse(readFileSync(join(out, 'release.json'), 'utf8'))
verifyStablePublication({ root, release })
const files = ['install.sh', 'release.json', release.file].map(file => join(out, file))
for (const file of files) if (!existsSync(file)) throw new Error(`${file} is missing: run scripts/release.mjs first`)
// The tarball is what gets installed: published only if it is the file release.json names. A copy that ended early
// or was edited after the release would otherwise be published as a release every install then refuses.
const digest = createHash('sha256').update(readFileSync(join(out, release.file))).digest('hex')
if (digest !== release.sha256) throw new Error(`${release.file} is not the file release.json names (sha256 ${digest}, expected ${release.sha256}): make the release again`)
// What release.mjs wrote beside the tarball; a release made before changelog.mjs existed falls back to a line.
const notesFile = join(out, 'CHANGELOG.md')
const notes = existsSync(notesFile) ? readFileSync(notesFile, 'utf8') : `# boardlab ${release.version}\n\n${release.revision}\n`
if (!existsSync(notesFile)) writeFileSync(notesFile, notes)
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
const own = name => { try { return git(root, 'config', name) } catch { return '' } }

if (how === 'git') {
  const branch = option('branch', 'release')
  const work = mkdtempSync(join(tmpdir(), 'boardlab-publish-'))
  try {
    git(work, 'init', '-q'); git(work, 'checkout', '-q', '--orphan', branch)
    for (const file of files) copyFileSync(file, join(work, file.split('/').at(-1)))
    writeFileSync(join(work, 'CHANGELOG.md'), notes)
    // Never write a credentialed URL (CI's job token) into the published README; the push above still uses it.
    const shown = where.replace(/(^|\/\/)[^/@\s]+@/, '$1')
    writeFileSync(join(work, 'README.md'), `# boardlab ${release.version}

The release boardlab installs and updates from. On the machine that will run boardlab, as root:

    git clone -q --depth 1 -b ${branch} ${shown} /tmp/boardlab-release && sh /tmp/boardlab-release/install.sh; rm -rf /tmp/boardlab-release

\`release.json\` names the tarball and its sha256. [CHANGELOG.md](CHANGELOG.md) says what changed since the previous
release; the signed \`v${release.version}\` source tag identifies the revision it was built from. Each release replaces this branch's one commit.
`)
    git(work, 'add', '-A')
    // The key and how to sign with it (an ssh key, a gpg program of its own), as this repository has them.
    const identity = ['user.name', 'user.email', 'user.signingkey', 'gpg.format', 'gpg.program', 'gpg.ssh.program'].flatMap(name => own(name) ? ['-c', `${name}=${own(name)}`] : [])
    const sign = own('user.signingkey') ? ['-S'] : []
    const signoff = own('user.name') && own('user.email') ? ['-m', `Signed-off-by: ${own('user.name')} <${own('user.email')}>`] : []
    git(work, ...identity, 'commit', '-q', ...sign, '-m', `release ${release.version} (${release.revision})`, ...signoff)
    git(work, 'push', '-q', '-f', where, `${branch}:${branch}`)
    console.log(`published ${release.version} (${release.revision}) as ${where} ${branch}`)
  } finally { rmSync(work, { recursive: true, force: true }) }
} else {
  const tag = `v${release.version}`
  // A checkout prepared for the public distribution may have no previous release.json or tag: ask the releases already
  // there, so the changelog still covers what changed since the last one.
  try {
    const previousTag = execFileSync('gh', ['api', `repos/${where}/releases/latest`, '--jq', '.tag_name'], { encoding: 'utf8' }).trim()
    if (previousTag) {
      const commit = execFileSync('gh', ['api', `repos/${where}/commits/${previousTag}`, '--jq', '.sha'], { encoding: 'utf8' }).trim()
      writeFileSync(notesFile, changelog(release.version, release.revision, subjectsSince(commit, 'HEAD', root), { since: previousTag.replace(/^v/, '') }))
    }
  } catch (error) {
    console.log(`could not build the changelog from the previous GitHub release (${String(error.stderr ?? error.message).trim().split('\n')[0]}); using the one release.mjs wrote`)
  }
  execFileSync('gh', ['release', 'create', tag, ...files, '--repo', where, '--title', `boardlab ${release.version}`,
    '--notes-file', notesFile, '--verify-tag', '--target', option('target', 'main')], { stdio: 'inherit' })
  console.log(`published ${tag} on ${where}`)
  // Storage is not free: retain the newest release assets, but never delete source version tags.
  const keep = Math.max(1, Number(option('keep', '3')) || 3)
  const listed = JSON.parse(execFileSync('gh', ['api', `repos/${where}/releases?per_page=100`], { encoding: 'utf8' }))
  const old = listed.filter(item => !item.draft).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(keep)
  for (const item of old) {
    // Delete the release through the API: gh 2.4 has no --cleanup-tag, and no version deletes the source tag with
    // this call.
    execFileSync('gh', ['api', '-X', 'DELETE', `repos/${where}/releases/${item.id}`], { stdio: 'inherit' })
  }
  if (old.length) console.log(`kept the newest ${keep} releases; deleted ${old.map(item => item.tag_name).join(', ')}`)
}
