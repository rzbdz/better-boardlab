/** A fresh scratch directory for each test of a file that calls this: `dir` is it, removed after. */
import { afterAll, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export let dir: string
/** Remove test state even when a worker exits before afterEach (for example an installer assertion). */
process.on('exit', () => { if (dir) rmSync(dir, { recursive: true, force: true }) })

export function useTempDir() {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boards-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); dir = '' })
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
}
