/** This distribution's release identity, shared by its CLI, boardd and system module. */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ReleaseIdentity { version: string, revision: string }

const read = (path: string): string | null => {
  try { return readFileSync(path, 'utf8').trim() || null } catch { return null }
}

/** Installed metadata wins; source runs use the distribution package, never core's package. */
export function distributionIdentity(directory = dirname(fileURLToPath(import.meta.url))): ReleaseIdentity {
  let current = directory
  for (let up = 0; up < 6; up++) {
    const version = read(join(current, 'VERSION'))
    if (version) return { version, revision: read(join(current, 'REVISION')) ?? 'dev' }
    const manifest = join(current, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string, version?: string }
        // A staged package has a generated manifest but no repository: only VERSION/REVISION identify it.
        if (parsed.name === 'boardlab' && parsed.version && existsSync(join(current, '.git'))) {
          return { version: parsed.version, revision: 'dev' }
        }
      } catch {}
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return { version: 'dev', revision: 'dev' }
}
