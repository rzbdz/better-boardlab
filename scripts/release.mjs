#!/usr/bin/env node
/**
 * Make a release of this distribution: one tarball with everything boardd and the CLI need and nothing they don't (the
 * built CLI and pages need only Node itself), plus the boardctrl tree boardd installs on board hosts, install.sh (the bootstrap
 * that fetches a release) and setup.sh (this release's installer, which install.sh runs).
 *
 *   node scripts/release.mjs [--out release] [--version 0.2.0] [--source <where it is published>] [--since <ref>]
 *
 * Writes <out>/boardlab-<version>.tar.gz, <out>/install.sh, <out>/CHANGELOG.md (what changed since the previous release,
 * which publish.mjs puts on the release) and <out>/release.json ({version, revision, file, sha256, core}), which
 * install.sh and `boardlab update` read; scripts/publish.mjs puts it where they fetch it from.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { changelog, previousRelease, subjectsSince } from './changelog.mjs'
import { checkCoreVersion } from './check-core-version.mjs'
import { releaseMetadata, releaseVersion, uncommittedInputs, verifyStagedRelease } from './release-metadata.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = name => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined }
const out = resolve(option('out') ?? join(root, 'release'))
const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const version = releaseVersion(packageVersion, option('version'))
// Where this release will be published: install.sh fetches from there when not told otherwise, and boardd looks there
// for newer releases (a release URL directory, or `git@host:group/repo.git#release`).
const source = option('source') ?? ''
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()
const revision = git('rev-parse', 'HEAD')
if (!version.includes('rc')) {
  const tag = `v${version}`
  const tagged = git('rev-parse', `${tag}^{commit}`)
  if (tagged !== revision) throw new Error(`${tag} must identify HEAD ${revision} for a stable release`)
  execFileSync('git', ['verify-tag', tag], { cwd: root, stdio: 'inherit' })
}
const core = checkCoreVersion({ root })
// A release is what the public branch is derived from, so every commit after the base must be able to leave. The check
// and the rules it applies are internal (they never reach a public checkout, which imports neither), so it runs where
// it exists — this repository — and a checkout that has no such script has no public branch to derive either.
const derivable = join(root, 'scripts/check-derivable.mjs')
if (existsSync(derivable)) {
  const { checkDerivable } = await import(pathToFileURL(derivable).href)
  const derivation = checkDerivable('github')
  if (derivation.blocked) throw new Error(`a release cannot be cut: ${derivation.blocked.commit.slice(0, 7)} ${derivation.blocked.subject} has no public form, so the public branch cannot be derived from ${derivation.base} commit by commit (${derivation.blocked.why.split('\n')[0]})`)
}
// Always from a fresh build of this very tree: a release must never carry an older dist/.
if (!args.includes('--no-build')) { rmSync(join(root, 'dist'), { recursive: true, force: true }); execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' }) }
if (!existsSync(join(root, 'dist/cli.js')) || !existsSync(join(root, 'dist/ui/frontends.json'))) throw new Error('the build made no dist/')
// The built CLI must start: a bundling problem only shows when it runs.
try { execFileSync(process.execPath, [join(root, 'dist/cli.js'), 'help'], { stdio: 'pipe', env: { ...process.env, NODE_NO_WARNINGS: '1' } }) }
catch (error) { throw new Error(`the built CLI does not start: ${String(error.stderr ?? error.message).trim().split('\n').slice(0, 6).join('\n')}`) }
// Every input, not only what the tarball carries: a dirty manifest, lockfile or module list would otherwise build into
// a release that names HEAD's version.
const dirty = uncommittedInputs({ root })
if (dirty.length) throw new Error(`uncommitted changes: a release is made from a commit\n${dirty.slice(0, 20).join('\n')}`)

const stage = join(out, `boardlab-${version}`)
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
// The built client and pages (generated output, so not in git) beside the committed inputs, which are taken from the git
// index rather than the worktree: an ignored or untracked file under one of those directories — a key, a token, a log —
// is in the worktree but is not part of the release, and must never travel in it.
const dirs = ['skills', 'docs/help', 'firmware'].filter(path => existsSync(join(root, path)))
if (existsSync(join(root, 'host-tools'))) dirs.push('host-tools')      // tools board hosts get beside boardctrld
execFileSync('sh', ['-c', `tar -cf - dist | tar -xf - -C '${stage}'`], { cwd: root })
const tracked = dirs.concat('LICENSE', 'README.md')
execFileSync('sh', ['-c', `git ls-files -z -- ${tracked.join(' ')} | tar --null -cf - -T - | tar -xf - -C '${stage}'`], { cwd: root })
// The boardctrl tree board hosts are set up from: the files git tracks there, with serial-mux's.
const boardctrl = join(root, 'externals/boardctrl')
if (existsSync(join(boardctrl, 'deploy/install.sh'))) {
  mkdirSync(join(stage, 'externals/boardctrl'), { recursive: true })
  execFileSync('sh', ['-c', `git ls-files -z --recurse-submodules | tar --null -cf - -T - | tar -xf - -C '${join(stage, 'externals/boardctrl')}'`], { cwd: boardctrl })
  writeFileSync(join(stage, 'externals/boardctrl/REVISION'), execFileSync('git', ['rev-parse', 'HEAD'], { cwd: boardctrl, encoding: 'utf8' }))
}
writeFileSync(join(stage, 'VERSION'), `${version}\n`)
// Modules this distribution has on top of the shared ones (the internal one's CA module), for the installer to load.
if (existsSync(join(root, 'modules.offered'))) writeFileSync(join(stage, 'dist/modules.offered'), readFileSync(join(root, 'modules.offered')))
// install.sh is the thin bootstrap (fetch a release, run its setup.sh); setup.sh is this release's own installer. Both
// ship in the tarball: an installed machine keeps install.sh and every update runs the fetched release's setup.sh.
const installer = readFileSync(join(root, 'scripts/install.sh'), 'utf8').replace('@RELEASE_SOURCE@', source)
writeFileSync(join(stage, 'install.sh'), installer, { mode: 0o755 })
writeFileSync(join(stage, 'setup.sh'), readFileSync(join(root, 'scripts/setup.sh'), 'utf8'), { mode: 0o755 })
writeFileSync(join(stage, 'REVISION'), `${revision}\n`)
writeFileSync(join(stage, 'CORE_VERSION'), `${core.version}\n`)
writeFileSync(join(stage, 'CORE_REVISION'), `${core.revision}\n`)
writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'boardlab', version, type: 'module', private: true }, null, 2))
verifyStagedRelease({ stage, version, revision, core })
const file = `boardlab-${version}.tar.gz`
execFileSync('tar', ['-czf', join(out, file), '-C', out, `boardlab-${version}`])
rmSync(stage, { recursive: true, force: true })
const sha256 = createHash('sha256').update(readFileSync(join(out, file))).digest('hex')
// What changed since the previous release, for the release itself to publish (publish.mjs puts it in its notes and the
// git release branch). The previous release is the newest version tag below this commit, or a release.json in `out`
// naming something later than it (for a stable release, the newest stable one of either); `--since` says otherwise,
// and then is what the header names too.
const previous = previousRelease(root, out, version)
const given = option('since')
const since = given ?? previous?.revision ?? ''
writeFileSync(join(out, 'CHANGELOG.md'), changelog(version, revision, subjectsSince(since, 'HEAD', root), { since: given ?? previous?.version }))
writeFileSync(join(out, 'release.json'), JSON.stringify(releaseMetadata({ version, revision, file, sha256, core }), null, 2) + '\n')
writeFileSync(join(out, 'install.sh'), installer, { mode: 0o755 })
console.log(`release ${version} (${revision}): ${join(out, file)} sha256 ${sha256.slice(0, 16)}…`)
