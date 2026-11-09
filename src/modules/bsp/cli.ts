/**
 * The bsp module's commands, boardlab's wrapper of the bsp CLI: SDK work (`sdk`), the registry's SDK catalog
 * (`registry`), and any bsp command (`bsp`), each run by the bsp on boardd's machine, so this one needs no bsp.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { BoardsClient } from 'boardlab-core/shared/client.ts'
import { write, type Command, type CommandGroup } from 'boardlab-core/cli/command.ts'

/**
 * `boardlab sdk <bsp sdk arguments>`: SDK work on the build servers, run by boardd's bsp. Local files given to `put` are
 * sent first, and `get -o FILE` comes back into FILE. Global options (--json, --as) go before `sdk`.
 */
async function sdkCommand(client: BoardsClient, raw: string[], json: boolean) {
  const args = [...raw]
  if (!args.length || args[0] === 'help' || args[0] === '--help') {
    console.log(`用法：boardlab sdk <操作> …，和 bsp sdk 一样（由 boardd 那边的 bsp 执行）：
  list | show <sdk> | status <sdk> | plan <sdk> [<组件>] [--boot load|download]
  acquire <sdk> --task <名字> | release <sdk> | build <sdk> <组件> [--clean] [--no-wait] | jobs <sdk> | job <sdk> <id> [--follow]
  exec <sdk> [--cwd DIR] -- <命令> | get <sdk> <路径> [-o 本机文件] | put <sdk> <路径> <本机文件>`)
    return
  }
  if (args[0] === 'put' && args[3] && args[3] !== '-') args[3] = `@${await client.sendFile(resolve(args[3]))}`
  const out = args.findIndex((arg, index) => index > 0 && ['-o', '--output'].includes(args[index - 1]!))
  const target = out >= 0 ? resolve(args[out]!) : null
  if (out >= 0) args[out] = '@download'
  const result = await client.sdk(args, json, write)
  if (target && result.download) await client.fetchFile(result.download, target)
  process.exitCode = result.code
}

/**
 * `boardlab registry sdk <bsp catalog arguments>`: the SDK catalog the registry keeps and hands to every board host —
 * SDKs with their load and flash recipes, build servers, families. Run by boardd's bsp; `-f FILE` is sent from here,
 * `get -o FILE` comes back here. `boardlab registry hosts` shows the hosts and the catalog revision each has.
 */
async function registryCommand(client: BoardsClient, raw: string[], json: boolean) {
  const [what, ...rest] = raw.filter(arg => arg !== '--json')
  if (what === 'hosts') return runCatalog(client, ['status'], json)
  if (what === 'refresh') return runCatalog(client, ['refresh'], json)
  if (what !== 'sdk' || !rest.length || rest[0] === 'help' || rest[0] === '--help') {
    console.log(`用法：
  boardlab registry hosts                              板卡主机、各自拿到的 SDK 目录版本，以及被目录盖住、没有生效的本地改动
  boardlab registry refresh                            清掉所有缓存的目录副本（boardd 这边和每台主机），马上重新拿，列出每台主机的版本
  boardlab registry sdk list [--kind sdk|family|server|workspace]
  boardlab registry sdk get <sdk> [-o 文件]            文档（YAML）；-o 写到文件，第一行记着版本号，改完原样 put 回去
  boardlab registry sdk put <sdk> -f 文件 [--check] [-m 说明] [--force]
                                                       新增或修改；整个目录带着这个改动加载、所有 ready 的启动流程都排一遍，不通过就不写
  boardlab registry sdk recipe <sdk> load|download -f 文件 [--check] [-m 说明]
                                                       只改一个启动方式（load 内存启动 / download 刷机）：步骤列表，或 {status, steps, notes, variants}
  boardlab registry sdk rm <sdk> --base <版本> | history <sdk> | rollback <sdk> <版本> | import | status
  文档也可以是 family/<id>、server/<id>、workspace/<id>。改动立刻推到各板卡主机，不用重启；谁改的、为什么，都记在 history 里。`)
    return
  }
  return runCatalog(client, rest, json)
}

async function runCatalog(client: BoardsClient, raw: string[], json: boolean) {
  const args = [...raw]
  // A file given with -f is sent to boardd first (stdin is read here for -f -).
  const file = args.findIndex((arg, index) => index > 0 && ['-f', '--file'].includes(args[index - 1]!))
  if (file >= 0) {
    let path = resolve(args[file]!)
    if (args[file] === '-') {
      path = join(mkdtempSync(join(tmpdir(), 'boardlab-')), 'stdin.yaml')
      writeFileSync(path, readFileSync(0))
    }
    args[file] = `@${await client.sendFile(path)}`
  }
  const out = args.findIndex((arg, index) => index > 0 && ['-o', '--output'].includes(args[index - 1]!))
  const target = out >= 0 ? resolve(args[out]!) : null
  if (out >= 0) args[out] = '@download'
  const result = await client.sdk(args, json, write, 'catalog')
  if (target && result.download) await client.fetchFile(result.download, target)
  process.exitCode = result.code
}

const sdk: Command = {
  name: 'sdk', noBoard: true, usage: ['sdk <操作> …\tSDK：在构建服务器上租源码树、编译、读写文件、跑命令（boardd 那边的 bsp sdk 执行，见 boardlab sdk help）'],
  run: ({ client, argv, json }) => sdkCommand(client, argv, json),
}

const registry: Command = {
  name: 'registry', noBoard: true, usage: ['registry sdk <操作> … | registry hosts\tSDK 目录（SDK、启动和刷机流程、构建服务器）：看、改、回滚，改动推到各板卡主机（见 boardlab registry help）'],
  run: ({ client, argv, json }) => registryCommand(client, argv, json),
}

const bsp: Command = {
  name: 'bsp', noBoard: true, usage: ['bsp <bsp 命令> …\t任何 bsp 命令，在 boardd 那边执行（本机不用装 bsp），例如 boardlab bsp hosts'],
  async run({ client, argv, json }) {
    // Any bsp command, run by boardd's bsp: the whole lab without installing or configuring bsp here.
    const args = argv.filter(arg => arg !== '--json')
    if (!args.length) return console.log('用法：boardlab bsp <bsp 的命令和参数>，例如 boardlab bsp hosts、boardlab bsp dut status <dut>、boardlab bsp job get <id> -r <主机>\n经 boardd 那边的 bsp 执行；拿板子请用 boardlab lock（直接在 bsp 里租的板子在 boardlab 里显示为实验室占用）。')
    const result = await client.sdk(args, json, write, 'raw')
    process.exitCode = result.code
  },
}

export const commands: CommandGroup = { title: 'bsp：SDK 和构建', commands: [sdk, registry, bsp] }
