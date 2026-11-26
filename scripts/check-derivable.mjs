#!/usr/bin/env node
/**
 * The public branch is derived from `<base>` in `distributions/<name>.json`: every commit of this branch after the base
 * has to be the exported tree of one commit, so `scripts/derive.mjs <name> <out> <base> main` replays the branch commit
 * for commit with no conflict. A commit whose tree holds what must not leave has no public form and breaks that promise,
 * so this check fails and names it: the fix is in the source (the material does not belong in this tree), not in the
 * rules, and a new base is the owner's decision.
 *
 *   node scripts/check-derivable.mjs <name>              check `main`
 *   node scripts/check-derivable.mjs <name> <tip>        check another tip
 *
 * It is what `pnpm check`, the build and the release run, so a branch that would need a merge to become public cannot
 * be merged in the first place.
 */
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { distributionRules, exportTree } from './export.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 })

/** The commits of `tip` after the distribution's base, and the first one whose tree has no public form (or null). */
export function checkDerivable(name, tip = 'main') {
  const { spec, excluded } = distributionRules(root, name)
  const base = spec.base?.commit
  if (!base) throw new Error(`${name}: the rules name no base commit (distributions/${name}.json "base"), so a public branch cannot be derived`)
  git('cat-file', '-e', `${base}^{commit}`)
  const commits = git('rev-list', '--reverse', `${base}..${tip}`).trim().split('\n').filter(Boolean)
  for (const commit of commits) {
    const entries = git('ls-tree', '-r', '-z', commit).split('\0').filter(Boolean).map(line => {
      const [meta, path] = line.split('\t')
      const [mode, , object] = meta.split(' ')
      return { mode, object, path }
    })
    try {
      exportTree({ entries, readBlob: object => execFileSync('git', ['-C', root, 'cat-file', 'blob', object], { maxBuffer: 1 << 28 }), name, spec, excluded })
    } catch (error) {
      return { base, commits: commits.length, blocked: { commit, subject: git('log', '-1', '--format=%s', commit).trim(), why: String(error.message).split('\n').slice(0, 6).join('\n') } }
    }
  }
  return { base, commits: commits.length, blocked: null }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [name, tip = 'main'] = process.argv.slice(2)
  if (!name) { console.error('usage: node scripts/check-derivable.mjs <name> [tip]'); process.exitCode = 2 }
  else {
    try {
      const result = checkDerivable(name, tip)
      if (result.blocked) {
        console.error(`${name}: ${result.blocked.commit.slice(0, 7)} ${result.blocked.subject} has no public form, so ${tip} cannot be derived from ${result.base} commit by commit:\n${result.blocked.why}`)
        process.exitCode = 1
      } else console.log(`${name}: derivable from ${result.base} (${result.commits} commits, each with a public tree)`)
    } catch (error) { console.error(error?.message || String(error)); process.exitCode = 1 }
  }
}
