/** Offers the boardctrl module to boardd: boardctrl board hosts and the SDK, through the boardctrl CLI. */
import { instances, text, type CatalogEntry } from 'boardlab-core/server/catalog.ts'
import { boardctrl } from './index.ts'

export const entry: CatalogEntry = {
  id: 'boardctrl', was: ['bsp'], about: 'boardctrl 板卡主机和 SDK（instances；bin：boardctrl 命令行）',
  // The board controller CLI: the settings' bin, else $BOARDS_BOARDCTRL, else the `boardctrl` this distribution ships in
  // externals/boardctrl (falling back to its old `bin/bsp`), else `boardctrl` on PATH (an older install only has `bsp`).
  create: (settings, context) => boardctrl({
    bin: text(settings, 'bin') ?? process.env.BOARDS_BOARDCTRL ?? context.shipped('externals/boardctrl/bin/boardctrl')
      ?? context.shipped('externals/boardctrl/bin/bsp') ?? undefined,
    stateDir: context.stateDir, instances: settings.instances === undefined ? [] : instances(settings, 'boardctrl'),
    tree: context.shipped('externals/boardctrl/deploy/bspd-install.sh')?.replace(/\/deploy\/bspd-install\.sh$/, '') ?? null,
  }),
}
