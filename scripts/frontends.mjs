#!/usr/bin/env node
/**
 * Build this distribution's web frontends into dist/ui: each frontends/<name>/ (its page.tsx, index.html and any
 * *.css next to it) into dist/ui/<name>/, and dist/ui/frontends.json listing them, which boardd serves.
 *
 *   node scripts/frontends.mjs [--out dist/ui] [--only <name>]
 */
import { build } from 'esbuild'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = name => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined }
const out = resolve(option('out') ?? join(root, 'dist/ui'))
const list = JSON.parse(await readFile(join(root, 'frontends/frontends.json'), 'utf8'))
const only = option('only')
const require = createRequire(join(root, 'package.json'))

await rm(out, { recursive: true, force: true })
for (const { name } of list.frontends.filter(item => !only || item.name === only)) {
  const src = join(root, 'frontends', name), dest = join(out, name)
  await mkdir(dest, { recursive: true })
  await build({
    entryPoints: [join(src, 'page.tsx')], outfile: join(dest, 'main.js'), bundle: true, format: 'esm', platform: 'browser',
    target: 'es2022', minify: true, sourcemap: true, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning',
  })
  for (const file of await readdir(src)) if (file === 'index.html' || file.endsWith('.css')) await copyFile(join(src, file), join(dest, file))
  // Every frontend has the serial console, drawn with xterm.
  await copyFile(require.resolve('@xterm/xterm/css/xterm.css'), join(dest, 'xterm.css'))
}
await writeFile(join(out, 'frontends.json'), JSON.stringify({ default: list.default, frontends: list.frontends.map(({ name, title }) => ({ name, title })) }, null, 2))
console.log(`Built the frontends ${list.frontends.map(item => item.name).join(', ')} into ${out} (default ${list.default}).`)
