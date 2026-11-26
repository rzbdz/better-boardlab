#!/usr/bin/env node
/**
 * `pnpm check`: the checks a checkout carries. The registries, the layering and the core's provenance are the same
 * everywhere; then every `scripts/check-*.mjs` this tree has runs in turn, so a checkout that brings more of them
 * (a distribution's own, kept out of the trees that are published) checks them the same way, and one that brings fewer
 * runs what it has.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const node = (script, args = []) => execFileSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' })

node(join(root, 'scripts/modules.mjs'), ['--check'])
node(join(root, 'core/scripts/check-architecture.mjs'))
for (const file of readdirSync(join(root, 'scripts')).filter(name => /^check-.*\.mjs$/.test(name) && name !== 'check.mjs').sort()) {
  node(join(root, 'scripts', file), file.startsWith('check-derivable.') ? ['github'] : [])
}
