#!/usr/bin/env node
/**
 * Make a release of this distribution: one tarball with everything boardd and the CLI need and nothing they don't (the
 * built CLI and pages need only Node itself), plus the bsp tree boardd installs on board hosts, install.sh (the bootstrap
 * that fetches a release) and setup.sh (this release's installer, which install.sh runs).
 *
 *   node scripts/release.mjs [--out release] [--version 0.2.0] [--source <where it is published>]
 *
 * Writes <out>/boardlab-<version>.tar.gz, <out>/install.sh, and <out>/release.json ({version, revision, file, sha256}),
 * which install.sh and `boardlab update` read; scripts/publish.mjs puts it where they fetch it from.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = name => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined }
const out = resolve(option('out') ?? join(root, 'release'))
const version = option('version') ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
// Where this release will be published: install.sh fetches from there when not told otherwise, and boardd looks there
// for newer releases (a release URL directory, or `git@host:group/repo.git#release`).
const source = option('source') ?? ''
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()
const revision = git('rev-parse', '--short', 'HEAD')
// Always from a fresh build of this very tree: a release must never carry an older dist/.
if (!args.includes('--no-build')) { rmSync(join(root, 'dist'), { recursive: true, force: true }); execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' }) }
if (!existsSync(join(root, 'dist/cli.js')) || !existsSync(join(root, 'dist/ui/frontends.json'))) throw new Error('the build made no dist/')
// The built CLI must start: a bundling problem only shows when it runs.
try { execFileSync(process.execPath, [join(root, 'dist/cli.js'), 'help'], { stdio: 'pipe', env: { ...process.env, NODE_NO_WARNINGS: '1' } }) }
catch (error) { throw new Error(`the built CLI does not start: ${String(error.stderr ?? error.message).trim().split('\n').slice(0, 6).join('\n')}`) }
if (git('status', '--porcelain', '--untracked-files=no', '--', 'src', 'core', 'frontends', 'scripts', 'externals')) throw new Error('uncommitted changes: a release is made from a commit')

const stage = join(out, `boardlab-${version}`)
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
const files = ['dist', 'skills', 'docs/help', 'LICENSE', 'README.md'].filter(path => existsSync(join(root, path)))
if (existsSync(join(root, 'firmware'))) files.push('firmware')
// The tools board hosts get beside bspd (src/modules/bsp/host-tools.ts), when this distribution carries any.
if (existsSync(join(root, 'host-tools'))) files.push('host-tools')
// Certificates this distribution carries (the internal one's CA module), if any.
if (existsSync(join(root, 'ca'))) files.push('ca')
execFileSync('tar', ['-cf', '-', ...files], { cwd: root, maxBuffer: 1 << 30 }).length
execFileSync('sh', ['-c', `tar -cf - ${files.join(' ')} | tar -xf - -C '${stage}'`], { cwd: root })
// The bsp tree board hosts are set up from: the files git tracks there, with serial-mux's.
const bsp = join(root, 'externals/bsp')
if (existsSync(join(bsp, 'deploy/bspd-install.sh'))) {
  mkdirSync(join(stage, 'externals/bsp'), { recursive: true })
  execFileSync('sh', ['-c', `git ls-files -z --recurse-submodules | tar --null -cf - -T - | tar -xf - -C '${join(stage, 'externals/bsp')}'`], { cwd: bsp })
  writeFileSync(join(stage, 'externals/bsp/REVISION'), execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: bsp, encoding: 'utf8' }))
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
writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'boardlab', version, type: 'module', private: true }, null, 2))
const file = `boardlab-${version}.tar.gz`
execFileSync('tar', ['-czf', join(out, file), '-C', out, `boardlab-${version}`])
rmSync(stage, { recursive: true, force: true })
const sha256 = createHash('sha256').update(readFileSync(join(out, file))).digest('hex')
writeFileSync(join(out, 'release.json'), JSON.stringify({ version, revision, file, sha256 }, null, 2) + '\n')
writeFileSync(join(out, 'install.sh'), installer, { mode: 0o755 })
console.log(`release ${version} (${revision}): ${join(out, file)} sha256 ${sha256.slice(0, 16)}…`)
