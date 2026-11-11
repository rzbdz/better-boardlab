#!/usr/bin/env node
/**
 * Publish a release made by scripts/release.mjs, where install.sh and boardd's update checks fetch it from:
 *
 *   node scripts/publish.mjs git <repository> [--branch release] [--out release]
 *       the release as the only commit of a branch (replaced each time): for a server reached over ssh
 *       (`--source <repository>#release`) or through a git server's project API (`--source <api>/projects/<id>#release`)
 *   node scripts/publish.mjs github <owner/repo> [--out release]
 *       a GitHub release v<version> with the tarball, release.json and install.sh, marked latest
 *       (`--source https://github.com/<owner/repo>/releases/latest/download`)
 *
 * The commit is signed when git is set up to sign (user.signingkey), with this repository's identity and signing
 * settings (gpg.format, gpg.program, gpg.ssh.program).
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [how, where, ...rest] = process.argv.slice(2)
const option = (name, fallback) => { const at = rest.indexOf(`--${name}`); return at >= 0 ? rest[at + 1] : fallback }
const out = resolve(option('out', join(root, 'release')))
if (!how || !where || !['git', 'github'].includes(how)) {
  console.error('usage: publish.mjs git <repository> [--branch release] | publish.mjs github <owner/repo>')
  process.exit(2)
}
const release = JSON.parse(readFileSync(join(out, 'release.json'), 'utf8'))
const files = ['install.sh', 'release.json', release.file].map(file => join(out, file))
for (const file of files) if (!existsSync(file)) throw new Error(`${file} is missing: run scripts/release.mjs first`)
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
const own = name => { try { return git(root, 'config', name) } catch { return '' } }

if (how === 'git') {
  const branch = option('branch', 'release')
  const work = mkdtempSync(join(tmpdir(), 'boardlab-publish-'))
  try {
    git(work, 'init', '-q'); git(work, 'checkout', '-q', '--orphan', branch)
    for (const file of files) copyFileSync(file, join(work, file.split('/').at(-1)))
    writeFileSync(join(work, 'README.md'), `# boardlab ${release.version}

The release boardlab installs and updates from. On the machine that will run boardlab, as root:

    git clone -q --depth 1 -b ${branch} ${where} /tmp/boardlab-release && sh /tmp/boardlab-release/install.sh; rm -rf /tmp/boardlab-release

\`release.json\` names the tarball and its sha256. Each release replaces this branch's one commit.
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
  const notes = option('notes', null)
  execFileSync('gh', ['release', 'create', tag, ...files, '--repo', where, '--title', `boardlab ${release.version}`,
    ...(notes ? ['--notes-file', notes] : ['--notes', `boardlab ${release.version} (${release.revision})`]), '--target', option('target', 'main')], { stdio: 'inherit' })
  console.log(`published ${tag} on ${where}`)
}
