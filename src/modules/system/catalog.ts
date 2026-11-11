/** Offers the system module to boardd: its version, newer releases, and updating to them. */
import type { CatalogEntry } from 'boardlab-core/server/catalog.ts'
import { system } from './index.ts'

export const entry: CatalogEntry = {
  id: 'system', about: '这个 boardlab 的版本、检查和安装新版',
  // The installed program's directory: where VERSION sits beside dist/ (null when run from source).
  create: (_settings, context) => system({ root: context.shipped('VERSION')?.replace(/\/VERSION$/, '') ?? null }),
}
