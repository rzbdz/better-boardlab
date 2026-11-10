import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    // Frontend tests run in jsdom against the mock boardd (tests/frontend-setup.ts); the rest in Node.
    setupFiles: ['tests/setup.ts'],
    testTimeout: 10_000,
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
  },
})
