/** Offers the bsp module to boardd: bsp board hosts and the SDK, through the bsp CLI. */
import { instances, text, type CatalogEntry } from 'boardlab-core/server/catalog.ts'
import { bsp } from './index.ts'

export const entry: CatalogEntry = {
  id: 'bsp', about: 'bsp 板卡主机和 SDK（instances；bin：bsp 命令行）',
  // The board controller CLI: the settings' bin, else $BOARDS_BSP, else the `boardctrl` this distribution ships in
  // externals/bsp (falling back to its old `bin/bsp`), else `boardctrl` on PATH (an older install only has `bsp`).
  create: (settings, context) => bsp({
    bin: text(settings, 'bin') ?? process.env.BOARDS_BSP ?? context.shipped('externals/bsp/bin/boardctrl')
      ?? context.shipped('externals/bsp/bin/bsp') ?? undefined,
    stateDir: context.stateDir, instances: settings.instances === undefined ? [] : instances(settings, 'bsp'),
    tree: context.shipped('externals/bsp/deploy/bspd-install.sh')?.replace(/\/deploy\/bspd-install\.sh$/, '') ?? null,
  }),
}
