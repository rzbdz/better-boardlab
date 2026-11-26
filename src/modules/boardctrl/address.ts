/**
 * A lab's address, as boardlab writes it and as an older boardlab wrote it.
 *
 * A lab on a board host is one boardctrld, reached directly or over ssh: `boardctrld+http://127.0.0.1:8765` where boardd
 * and the host are the same machine, `boardctrld+ssh://root@host:8765` otherwise (a tunnel to its loopback port). The
 * prefix marks the address as one host rather than a registry listing several; what follows it is the boardctrl CLI's
 * own URL.
 *
 * `bspd+` is the same shape under the daemon's earlier name. It is read, never written: a lab added before the rename
 * keeps its address until someone edits it, and must not start looking like a registry address.
 */

import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The prefixes that mark "one boardctrld, not a registry": the one written now, and the one an older boardlab wrote. */
export const HOST_SCHEMES = ['boardctrld+', 'bspd+'] as const

/** Whether an address names one boardctrld rather than a registry. */
export const isHostUrl = (url: string | null | undefined): boolean => !!url && HOST_SCHEMES.some(scheme => url.startsWith(scheme))

/** One boardctrld's address, without the prefix (`ssh://root@host:8765`); anything else is itself. */
export function hostUrl(url: string): string {
  const scheme = HOST_SCHEMES.find(candidate => url.startsWith(candidate))
  return scheme ? url.slice(scheme.length) : url
}

/** The address as it is written now: an older prefix becomes `boardctrld+`. */
export function writtenUrl(url: string): string { return isHostUrl(url) ? `boardctrld+${hostUrl(url)}` : url }

/**
 * The directory this module keeps at the state directory (`boardctrl`), as it had it before the rename (`bsp`).
 *
 * The names of the directories are the earlier ones': a machine that already has a site clone there keeps using it,
 * rather than boardd starting a second site beside the one the hosts were synced from. A machine that has only the new
 * directory is left alone, so the move happens once.
 */
export function statePath(stateDir: string, name: string): string {
  const path = join(stateDir, name), older = join(stateDir, name.replace(/^boardctrl/, 'bsp'))
  // `bsp/site` and `bsp` are two directories under one parent: moving `bsp` takes the site with it.
  if (older !== path && !existsSync(path) && existsSync(older)) {
    try { mkdirSync(dirname(path), { recursive: true }); renameSync(older, path) } catch { return older }
  }
  return path
}
