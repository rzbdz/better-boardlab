/** Release identity checks shared by the release builder and its tests. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const VERSION_PATTERN = /^0\.\d+\.\d+(?:rc[1-9]\d*)?$/
export const CORE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/
export const REVISION_PATTERN = /^[0-9a-f]{40}$/

export function releaseVersion(packageVersion, requested = packageVersion) {
  if (requested !== packageVersion) {
    throw new Error(`--version ${requested} does not match package.json ${packageVersion}; update package.json first`)
  }
  if (!VERSION_PATTERN.test(requested)) {
    throw new Error(`unsupported release version ${requested}; use 0.<minor>.<patch> or 0.<minor>.<patch>rc<N>`)
  }
  return requested
}

export function releaseMetadata({ version, revision, file, sha256, core }) {
  if (!VERSION_PATTERN.test(version) || !REVISION_PATTERN.test(revision)) {
    throw new Error('release metadata needs a supported version and a full source revision')
  }
  if (file !== `boardlab-${version}.tar.gz` || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('release metadata has an invalid artifact name or sha256')
  }
  if (!core || !CORE_VERSION_PATTERN.test(core.version) || !REVISION_PATTERN.test(core.revision) || core.tag !== `v${core.version}`) {
    throw new Error('release metadata needs the tagged core version and full revision')
  }
  return { version, revision, file, sha256, core: { version: core.version, revision: core.revision, tag: core.tag } }
}

/** Stable publication never creates, replaces or deletes a source version tag. */
export function verifyStablePublication({ root, release, git }) {
  if (!VERSION_PATTERN.test(release.version) || release.version.includes('rc')) {
    throw new Error('publish.mjs publishes stable 0.<minor>.<patch> releases only')
  }
  const run = git ?? ((...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim())
  if (run('rev-parse', 'HEAD') !== release.revision) {
    throw new Error('release.json revision does not match the source checkout')
  }
  const tag = `v${release.version}`
  if (run('rev-parse', `${tag}^{commit}`) !== release.revision) {
    throw new Error(`${tag} must already identify the released source revision`)
  }
  run('verify-tag', tag)
  return tag
}

/** Run the packaged CLI without consulting a user's configured boardd. */
export function verifyStagedRelease({ stage, version, revision, core, run = execFileSync }) {
  const read = file => readFileSync(join(stage, file), 'utf8').trim()
  const manifest = JSON.parse(read('package.json'))
  if (read('VERSION') !== version || read('REVISION') !== revision || manifest.name !== 'boardlab' || manifest.version !== version) {
    throw new Error('staged VERSION, REVISION and package.json do not agree')
  }
  if (core && (read('CORE_VERSION') !== core.version || read('CORE_REVISION') !== core.revision)) {
    throw new Error('staged core provenance does not match the verified submodule')
  }
  const temporary = mkdtempSync(join(tmpdir(), 'boardlab-release-check-'))
  try {
    const env = { ...process.env, HOME: temporary, BOARDS_STATE_DIR: join(temporary, 'state'), NODE_NO_WARNINGS: '1' }
    delete env.BOARDS_REMOTE
    delete env.BOARDS_HOLDER
    const output = run(process.execPath, [join(stage, 'dist/cli.js'), 'version', '--json'], { encoding: 'utf8', env, timeout: 30_000 })
    const identity = JSON.parse(output).cli
    if (identity?.version !== version || identity?.revision !== revision) {
      throw new Error(`packaged CLI reports ${identity?.version ?? 'missing'} (${identity?.revision ?? 'missing'}), expected ${version} (${revision})`)
    }
    return identity
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
