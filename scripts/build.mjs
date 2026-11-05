/** Build the boards CLI (which also runs boardd), its client library and the web page into dist/. */
import { build } from 'esbuild'
import { chmod, copyFile, mkdir } from 'node:fs/promises'

await mkdir('dist/ui', { recursive: true })
await build({ entryPoints: { cli: 'src/cli/main.ts', client: 'src/shared/client.ts' }, outdir: 'dist', bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node24', sourcemap: true, banner: { js: '#!/usr/bin/env node' } })
await chmod('dist/cli.js', 0o755)
await build({ entryPoints: ['src/ui/main.tsx'], outfile: 'dist/ui/main.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, sourcemap: true, define: { 'process.env.NODE_ENV': '"production"' } })
for (const file of ['index.html', 'styles.css']) await copyFile(`src/ui/${file}`, `dist/ui/${file}`)
console.log('Built the boards CLI, its client and the web page.')
