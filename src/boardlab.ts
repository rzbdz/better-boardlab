/** This distribution's `boardlab` CLI (and boardd, `boardlab serve`): the core's commands plus its modules'. */
import { createCli, runIfMain } from 'boardlab-core/cli/main.ts'
import { CATALOG } from './catalog.ts'
import { COMMAND_GROUPS } from './commands.ts'

const cli = createCli({ groups: COMMAND_GROUPS, catalog: CATALOG })
export const main = cli.main
export const usage = cli.usage
runIfMain(cli, import.meta.url)
