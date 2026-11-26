/**
 * A site's submodules: the code a provider vendors (`providers/<name>/vendor/<kit>`, or the same under its old
 * `modules/` name) and anything else a site records as one. `git clone` leaves a submodule directory empty, and a
 * provider is useless without the code it vendors, so the site copy checks them out and a bundle refuses one that is
 * missing.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

type Run = (args: string[]) => Promise<{ code: number, stderr: string, stdout: string }>

/**
 * Check out every submodule the copy records. Null when it did, else what git said. A site's submodule may be a plain
 * path (`file://`), which git refuses for a clone unless asked: the site's own code runs here, so that is not a
 * boundary this adds.
 */
export async function checkoutSubmodules(dir: string, git: Run): Promise<string | null> {
  if (!existsSync(join(dir, '.gitmodules'))) return null
  const done = await git(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive', '--quiet'])
  return done.code === 0 ? null : (done.stderr || done.stdout).trim().split('\n').slice(-2).join(' / ')
}

/** Vendor directories (`providers/<name>/vendor/<kit>`, or under `modules/`) a site records but has not checked out. */
export function emptyVendors(dir: string): string[] {
  const out: string[] = []
  for (const root of ['providers', 'modules']) {
    const at = join(dir, root)
    if (!existsSync(at)) continue
    for (const provider of readdirSync(at).sort()) {
      const vendor = join(at, provider, 'vendor')
      if (!existsSync(vendor)) continue
      for (const kit of readdirSync(vendor).sort()) {
        // A README or a note beside the submodules is a file, not a vendor directory.
        const kitDir = join(vendor, kit)
        if (!statSync(kitDir).isDirectory()) continue
        // A submodule that was never initialised is an empty directory, and its own .git is not there.
        if (!existsSync(join(kitDir, '.git')) && !readdirSync(kitDir).length) out.push(`${root}/${provider}/vendor/${kit}`)
      }
    }
  }
  return out
}
