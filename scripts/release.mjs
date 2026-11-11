#!/usr/bin/env node
/**
 * Make a release of this distribution: one tarball with everything boardd and the CLI need and nothing they don't (the
 * built CLI and pages need only Node itself), plus the bsp tree boardd installs on board hosts and install.sh.
 *
 *   node scripts/release.mjs [--out release] [--version 0.2.0] [--source <where it is published>]
 *
 * Writes <out>/boardlab-<version>.tar.gz, <out>/install.sh, and <out>/release.json ({version, revision, file, sha256}),
 * which install.sh and `boardlab update` read. Run `pnpm run build` first.
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
if (!existsSync(join(root, 'dist/cli.js')) || !existsSync(join(root, 'dist/ui/frontends.json'))) throw new Error('build first: pnpm run build')

const stage = join(out, `boardlab-${version}`)
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
const files = ['dist', 'skills', 'LICENSE', 'README.md'].filter(path => existsSync(join(root, path)))
if (existsSync(join(root, 'firmware'))) files.push('firmware')
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
const installer = readFileSync(join(root, 'scripts/install.sh'), 'utf8').replace('@RELEASE_SOURCE@', source)
writeFileSync(join(stage, 'install.sh'), installer, { mode: 0o755 })
writeFileSync(join(stage, 'REVISION'), `${revision}\n`)
writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'boardlab', version, type: 'module', private: true }, null, 2))
const file = `boardlab-${version}.tar.gz`
execFileSync('tar', ['-czf', join(out, file), '-C', out, `boardlab-${version}`])
rmSync(stage, { recursive: true, force: true })
const sha256 = createHash('sha256').update(readFileSync(join(out, file))).digest('hex')
writeFileSync(join(out, 'release.json'), JSON.stringify({ version, revision, file, sha256 }, null, 2) + '\n')
writeFileSync(join(out, 'install.sh'), installer, { mode: 0o755 })
console.log(`release ${version} (${revision}): ${join(out, file)} sha256 ${sha256.slice(0, 16)}…`)
