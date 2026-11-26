import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

/** The public module market, when it is beside this checkout or named: the frontend tests draw its page parts, as a page does. */
const market = process.env.BOARDLAB_PUB_MARKET ?? resolve(import.meta.dirname, '../boardlab-modules-pub')

export default defineConfig({
  resolve: {
    alias: [
      // A market module's page part imports the SDK by the name the page's import map gives it.
      { find: /^boardlab\/ui$/, replacement: resolve(import.meta.dirname, 'src/sdk.browser.ts') },
    ],
  },
  server: { fs: { allow: [import.meta.dirname, market] } },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    // Frontend tests run in jsdom against the mock boardd (tests/frontend-setup.ts); the rest in Node.
    setupFiles: ['tests/setup.ts'],
    testTimeout: 10_000,
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
  },
})
