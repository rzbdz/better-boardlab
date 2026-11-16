#!/usr/bin/env node
/**
 * Check that the distribution's core gitlink is a checkout with one signed,
 * annotated release tag agreeing with core/package.json.
 *
 *   node scripts/check-core-version.mjs [--index]
 *
 * --index checks a prepared export's staged gitlink instead of the last commit.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const distributionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const revisionPattern = /^[0-9a-f]{40}$/
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function readPackage(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function detail(error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
  return stderr || error?.message || String(error)
}

function fail(message) {
  throw new Error(`core provenance: ${message}`)
}

/**
 * Return the verified core release as {version, revision, tag}.
 *
 * `skipSignature` is only for unsigned temporary repositories in tests. The
 * production CLI never sets it. `git` and `readPackage` are injectable so the
 * comparison rules can be tested without creating commits and tags.
 */
export function checkCoreVersion({
  root = distributionRoot,
  index = false,
  skipSignature = false,
  git = runGit,
  readPackage: readCorePackage = readPackage,
} = {}) {
  const core = join(root, 'core')
  const source = index ? 'index' : 'HEAD'
  let tree
  try {
    tree = git(root, index
      ? ['ls-files', '--stage', '--', 'core']
      : ['ls-tree', 'HEAD', '--', 'core'])
  } catch (error) {
    fail(`cannot read the core gitlink from ${source}: ${detail(error)}`)
  }
  const match = index
    ? /^160000 ([0-9a-f]{40}) 0\tcore$/.exec(tree.trim())
    : /^160000 commit ([0-9a-f]{40})\tcore$/.exec(tree.trim())
  if (!match) {
    fail(`${source} has no ${index ? 'stage-zero ' : ''}core gitlink with a full commit revision; update the core submodule gitlink.`)
  }
  const gitlink = match[1]

  let revision
  try {
    revision = git(core, ['rev-parse', 'HEAD']).trim()
  } catch (error) {
    fail(`cannot resolve the core checkout HEAD: ${detail(error)}`)
  }
  if (!revisionPattern.test(revision)) fail(`core rev-parse HEAD returned ${JSON.stringify(revision)}, not a full commit revision.`)
  if (gitlink !== revision) {
    fail(`core gitlink ${gitlink} does not match core checkout ${revision}; check out the gitlink revision in core.`)
  }

  let manifest
  try {
    manifest = readCorePackage(join(core, 'package.json'))
  } catch (error) {
    fail(`cannot read core/package.json: ${detail(error)}`)
  }
  const version = manifest?.version
  if (typeof version !== 'string' || !versionPattern.test(version)) {
    fail(`core/package.json version ${JSON.stringify(version)} is not a release version X.Y.Z; set it to the core release.`)
  }
  const tag = `v${version}`

  let listing
  try {
    listing = git(core, ['for-each-ref', '--format=%(refname)%00%(objecttype)', 'refs/tags/'])
  } catch (error) {
    fail(`cannot list core release tags: ${detail(error)}`)
  }
  const annotated = listing.split('\n').filter(Boolean).flatMap(line => {
    const [ref, type] = line.split('\0')
    if (!ref?.startsWith('refs/tags/') || type !== 'tag') return []
    const name = ref.slice('refs/tags/'.length)
    return versionPattern.test(name.slice(1)) && name.startsWith('v') ? [{ name, ref }] : []
  })

  const atHead = []
  for (const candidate of annotated) {
    let target
    try {
      target = git(core, ['rev-parse', `${candidate.ref}^{}`]).trim()
    } catch (error) {
      fail(`cannot peel annotated core tag ${candidate.name}: ${detail(error)}`)
    }
    if (!revisionPattern.test(target)) fail(`core tag ${candidate.name} does not peel to a full commit revision.`)
    if (target === revision) atHead.push(candidate)
  }

  if (atHead.length === 0) {
    fail(`no annotated core vX.Y.Z tag peels to HEAD ${revision}; create signed annotated tag ${tag} at this revision.`)
  }
  const matching = atHead.filter(candidate => candidate.name === tag)
  if (matching.length === 0) {
    fail(`core/package.json version ${version} disagrees with annotated tag(s) at HEAD: ${atHead.map(candidate => candidate.name).join(', ')}; use tag ${tag} or correct the package version.`)
  }
  if (matching.length !== 1) {
    fail(`expected exactly one annotated tag ${tag} peeled to ${revision}, found ${matching.length}; remove duplicate release tags.`)
  }

  if (!skipSignature) {
    try {
      git(core, ['verify-tag', matching[0].ref])
    } catch (error) {
      fail(`tag ${tag} at ${revision} does not have a valid OpenPGP signature; sign the annotated tag and run git -C core verify-tag ${tag}. ${detail(error)}`)
    }
  }
  return { version, revision, tag }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.some(argument => argument !== '--index') || new Set(args).size !== args.length) {
    console.error('usage: node scripts/check-core-version.mjs [--index]')
    process.exitCode = 2
  } else {
    try {
      const provenance = checkCoreVersion({ index: args.includes('--index') })
      console.log(`core ${provenance.version} ${provenance.revision} ${provenance.tag} (signed annotated tag verified)`)
    } catch (error) {
      console.error(error?.message || String(error))
      process.exitCode = 1
    }
  }
}
