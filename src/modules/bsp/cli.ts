/**
 * The bsp module's commands, boardlab's wrapper of the bsp CLI: SDK work (`sdk`), the registry's SDK catalog
 * (`registry`), and any bsp command (`bsp`), each run by the bsp on boardd's machine, so this one needs no bsp; and the
 * site boardd keeps for its board hosts (`site`).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { BoardsApiError, type BoardsClient } from 'boardlab-core/shared/client.ts'
import { write, type Command, type CommandContext, type CommandGroup } from 'boardlab-core/cli/command.ts'

/** Where each agent reads skills from, under the home directory; the agent counts as installed when its own directory exists (as in `boardlab install -g`). */
const AGENT_SKILLS: Array<{ agent: string, home: string, skills: string }> = [
  { agent: 'Claude Code', home: '.claude', skills: '.claude/skills' },
  { agent: 'codex', home: '.codex', skills: '.codex/skills' },
  { agent: 'opencode', home: '.config/opencode', skills: '.config/opencode/skill' },
  { agent: 'hermes', home: '.hermes', skills: '.hermes/skills/embedded' },
]

interface SkillSummary { id: string, layer: string, file: string, title: string }
interface SkillText { id: string, layer: string, text: string }

/**
 * `boardlab sdk skill …`: an SDK's own SKILL.md from the site, printed or installed where an agent working in that
 * SDK's repository will read it. Before any bsp argument, so `skill` is not passed on to bsp.
 */
async function sdkSkill(client: BoardsClient, raw: string[], json: boolean, out: CommandContext['out']) {
  const words: string[] = []
  let install = false, global = false, dir: string | undefined
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i]!
    if (arg === '--install') install = true
    else if (arg === '-g' || arg === '--global') { global = true; install = true }
    else if (arg === '--json') continue
    else if (arg === '--as') i++
    else if (arg.startsWith('--as=')) continue
    else if (arg === '--dir') dir = raw[++i]
    else if (arg.startsWith('--dir=')) dir = arg.slice('--dir='.length)
    else if (!arg.startsWith('-')) words.push(arg)
  }
  const [what] = words
  const skills = async () => (await client.call<{ skills: SkillSummary[] }>('GET', '/api/bsp/site/skills')).skills ?? []
  if (what === 'list') {
    const found = await skills()
    return out(found, () => { for (const skill of found) console.log(`${skill.id}${skill.layer === 'site' ? '' : `  （${skill.layer}）`}${skill.title && skill.title !== skill.id ? `  ${skill.title}` : ''}`) })
  }
  if (!what || what === 'help' || what === '--help') {
    console.log(`用法：
  boardlab sdk skill list                    有哪些 SDK 带自己的 SKILL.md
  boardlab sdk skill <sdk>                   打印那个 SDK 的 SKILL.md
  boardlab sdk skill <sdk> --install [--dir <目录>]
                                             写到 <目录>/.claude/skills/<sdk>/SKILL.md（默认当前目录）
  boardlab sdk skill <sdk> --install -g      写到这台机器上每个装了的 agent 的 skill 目录（Claude Code、codex、opencode、hermes）
  全局选项 --json 放在 sdk 前面或后面都可以。`)
    return
  }
  const id = what
  let found: SkillText
  try {
    found = await client.call<SkillText>('GET', `/api/bsp/site/skill?id=${encodeURIComponent(id)}`)
  } catch (error) {
    if (error instanceof BoardsApiError && error.status === 404) {
      const available = (await skills()).map(skill => skill.id)
      throw new BoardsApiError(404, `没有 SDK 的 skill：${id}${available.length ? `（有：${available.join('、')}）` : '（站点里还没有 skill）'}`, 'not-found')
    }
    throw error
  }
  if (!install && dir === undefined) return out(found, () => process.stdout.write(found.text.endsWith('\n') ? found.text : `${found.text}\n`))
  const text = found.text.endsWith('\n') ? found.text : `${found.text}\n`
  const put = (file: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
  const installed: string[] = []
  if (global) {
    const home = process.env.HOME ?? homedir()
    const agents = AGENT_SKILLS.filter(agent => existsSync(join(home, agent.home)))
    if (!agents.length) throw new BoardsApiError(400, `这台机器上没找到 agent（${AGENT_SKILLS.map(agent => `~/${agent.home}`).join('、')} 都不存在）；去掉 -g 装到当前目录`, 'invalid')
    for (const agent of agents) { const file = join(home, agent.skills, id, 'SKILL.md'); put(file); installed.push(file) }
  } else {
    const file = join(resolve(dir ?? '.'), '.claude', 'skills', id, 'SKILL.md')
    put(file); installed.push(file)
  }
  out({ installed }, () => { for (const file of installed) console.log(`已安装 skill ${id} -> ${file}`) })
}

/**
 * `boardlab sdk <bsp sdk arguments>`: SDK work on the build servers, run by boardd's bsp. Local files given to `put` are
 * sent first, and `get -o FILE` comes back into FILE. Global options (--json, --as) go before `sdk`.
 */
async function sdkCommand({ client, argv, json, out }: CommandContext) {
  const args = [...argv]
  if (args[0] === 'skill') return sdkSkill(client, args.slice(1), json, out)
  if (!args.length || args[0] === 'help' || args[0] === '--help') {
    console.log(`用法：boardlab sdk <操作> …，和 bsp sdk 一样（由 boardd 那边的 bsp 执行）：
  list | show <sdk> | status <sdk> | plan <sdk> [<组件>] [--boot load|download]
  acquire <sdk> --task <名字> | release <sdk> | build <sdk> <组件> [--clean] [--no-wait] | jobs <sdk> | job <sdk> <id> [--follow]
  exec <sdk> [--cwd DIR] -- <命令> | get <sdk> <路径> [-o 本机文件] | put <sdk> <路径> <本机文件>
  skill list | skill <sdk> [--install [--dir <目录>] [-g]]   SDK 自己的 SKILL.md：打印，或装到 agent 读的地方`);
    return
  }
  if (args[0] === 'put' && args[3] && args[3] !== '-') args[3] = `@${await client.sendFile(resolve(args[3]))}`
  const at = args.findIndex((arg, index) => index > 0 && ['-o', '--output'].includes(args[index - 1]!))
  const target = at >= 0 ? resolve(args[at]!) : null
  if (at >= 0) args[at] = '@download'
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

/** What the site endpoints answer; see site.ts. */
interface SiteDoc { kind: string, id: string, file: string, layer: string, text: string, fields: Record<string, string> }
interface SiteStatus {
  source: 'managed' | 'git', url: string, branch: string, ready: boolean, revision: string | null
  commit: { subject: string, at: string } | null, ahead: number, docs: SiteDoc[], skills?: SkillSummary[], socs: Array<{ soc: string, layer: string }>
  problems: string[], hosts: Record<string, { revision: string, at: string, ok: boolean, message: string }>, syncing: boolean
  images: { ok: boolean, message: string, missing: string[], optional?: string[] } | null
}
interface SyncExit { ok: boolean, message: string, revision?: string, results?: Array<{ lab: string, ok: boolean, message: string }> }

/** The words a person uses for a kind of site document, and the kind the site keeps it under. */
const SITE_KINDS: Record<string, string> = { sdk: 'instances', instance: 'instances', server: 'servers', workspace: 'workspaces', family: 'families' }
const SITE_USAGE = `用法：
  boardlab site show [<种类> <id>]        来源、版本、问题、编译服务器和它们上面的 SDK；给出文档时打印它的 YAML
  boardlab site show skill <id>           打印站点里一个 SDK 的 skill（SKILL.md 原文）
  boardlab site pull | push               git 来源：拉取、推送
  boardlab site sync [--lab <主机>]        把站点同步到所有 bsp 主机（或一台）
  boardlab site set <种类> <id> -f <YAML 文件|->
                                          添加或改写一个文档（- 从标准输入读）
  boardlab site set skill <id> -f <Markdown 文件|->
                                          写入一个 SDK 的 skill：skills/<id>.md
  boardlab site remove <种类> <id>         删掉一个文档（还有别的在用它时不删）
  boardlab site remove skill <id>          删掉站点的 skill
  种类：sdk、server、workspace（源码树）、family（编译方式）；skill 是单独的 Markdown 文件。`

function siteKind(word: string | undefined) {
  const kind = word ? SITE_KINDS[word] : undefined
  if (!kind) throw new BoardsApiError(400, `不认识的种类 ${word ?? '（没写）'}：sdk、server、workspace 或 family\n${SITE_USAGE}`, 'invalid')
  return kind
}

function printSite(site: SiteStatus) {
  console.log(`来源  ${site.source === 'git' ? `git ${site.url} 分支 ${site.branch}` : '这台 boardd 管理'}`)
  console.log(`版本  ${site.revision ? `${site.revision}${site.commit ? ` · ${site.commit.subject} · ${site.commit.at}` : ''}` : '（还没有提交）'}${site.ahead ? `（${site.ahead} 个提交还没推送）` : ''}`)
  for (const problem of site.problems) console.log(`问题  ${problem}`)
  const sdks = site.docs.filter(doc => doc.kind === 'instances')
  const workspaces = new Map(site.docs.filter(doc => doc.kind === 'workspaces').map(doc => [doc.id, doc.fields.server ?? '']))
  const serverOf = (sdk: SiteDoc) => sdk.fields.server || workspaces.get(sdk.fields.workspace ?? '') || ''
  const line = (sdk: SiteDoc) => `    ${sdk.id}${sdk.fields.family ? `  ${sdk.fields.family}` : ''}${sdk.fields.workspace ? `  源码树 ${sdk.fields.workspace}` : sdk.fields.path ? `  ${sdk.fields.path}` : ''}${sdk.fields.description ? `  ${sdk.fields.description}` : ''}`
  const servers = site.docs.filter(doc => doc.kind === 'servers')
  console.log(servers.length ? '编译服务器' : '编译服务器  （还没有）')
  for (const server of servers) {
    console.log(`  ${server.id}  ${server.fields.user ? `${server.fields.user}@` : ''}${server.fields.host ?? ''}${server.layer === 'site' ? '' : `  （${server.layer}）`}`)
    for (const sdk of sdks.filter(sdk => serverOf(sdk) === server.id)) console.log(line(sdk))
  }
  const elsewhere = sdks.filter(sdk => !servers.some(server => server.id === serverOf(sdk)))
  if (elsewhere.length) { console.log('别处的 SDK'); for (const sdk of elsewhere) console.log(line(sdk)) }
  const hosts = Object.entries(site.hosts)
  if (site.skills?.length) console.log(`skill  ${site.skills.map(skill => `${skill.id}${skill.layer === 'site' ? '' : `（${skill.layer}）`}`).join('、')}`)
  if (hosts.length) console.log(`主机  ${hosts.map(([lab, host]) => `${lab} ${host.revision || '？'}${host.ok ? '' : '（上次没同步上）'}`).join('，')}`)
  if (site.images && !site.images.ok) console.log(`镜像  ${site.images.message}`)
  if (site.images?.optional?.length) console.log(`可选  ${site.images.optional.join('、')}：没有时发现板子读不到型号`)
}

/** POST the sync and print its lines as they come; resolves with its exit. */
function streamSync(client: BoardsClient, body: unknown, line: (text: string) => void): Promise<SyncExit> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = client.open('POST', '/api/bsp/site/sync', { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Content-Length': String(Buffer.byteLength(payload)) })
    req.on('response', response => {
      if ((response.statusCode ?? 500) >= 400) {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          let message = Buffer.concat(chunks).toString('utf8')
          try { message = JSON.parse(message).error ?? message } catch {}
          reject(new BoardsApiError(response.statusCode ?? 500, message, null))
        })
        return
      }
      let buffer = '', done = false
      response.setEncoding('utf8')
      response.on('data', chunk => {
        buffer += chunk
        let index
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index); buffer = buffer.slice(index + 2)
          const event = block.match(/^event: (.*)$/m)?.[1]
          const data = block.match(/^data: (.*)$/m)?.[1]
          if (!data) continue
          const value = JSON.parse(data)
          if (event === 'out') line(value.text)
          else if (event === 'exit') { done = true; resolve(value) }
        }
      })
      response.on('end', () => { if (!done) reject(new Error('boardd 在同步结束前断开了')) })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

async function siteCommand({ client, args, argv, flag, json, out }: CommandContext) {
  const [what, word, id] = args
  // The short form `-f FILE` (the longer `--file FILE` comes through `flag`).
  const shortFile = () => { const index = argv.indexOf('-f'); return index >= 0 ? argv[index + 1] : undefined }
  if (what === 'show' && word === 'skill') {
    if (!id) throw new BoardsApiError(400, `要给 skill 的 id\n${SITE_USAGE}`, 'invalid')
    const found = await client.call<SkillText>('GET', `/api/bsp/site/skill?id=${encodeURIComponent(id)}`)
    return out(found, () => process.stdout.write(found.text.endsWith('\n') ? found.text : `${found.text}\n`))
  }
  if (what === 'show' && word) {
    const kind = siteKind(word)
    const site = await client.call<SiteStatus>('GET', '/api/bsp/site')
    const doc = site.docs.find(doc => doc.kind === kind && doc.id === id)
    if (!doc) throw new BoardsApiError(404, `站点里没有 ${word} ${id ?? ''}`.trim(), 'not-found')
    return out(doc, () => process.stdout.write(doc.text.endsWith('\n') ? doc.text : `${doc.text}\n`))
  }
  if (what === 'show') {
    const site = await client.call<SiteStatus>('GET', '/api/bsp/site')
    return out(site, () => printSite(site))
  }
  if (what === 'pull' || what === 'push') {
    const result = await client.call<{ message: string }>('POST', `/api/bsp/site/${what}`, {})
    return out(result, () => console.log(result.message))
  }
  if (what === 'sync') {
    const lab = flag('lab')
    const exit = await streamSync(client, lab ? { lab } : {}, text => { if (!json) console.log(text) })
    out(exit, () => console.log(exit.message))
    if (!exit.ok) process.exitCode = 1
    return
  }
  if (what === 'set' && word === 'skill') {
    const file = flag('file') ?? shortFile()
    if (!id || !file) throw new BoardsApiError(400, `要给 skill 的 id 和 -f <文件|->\n${SITE_USAGE}`, 'invalid')
    const text = readFileSync(file === '-' ? 0 : resolve(file), 'utf8')
    // Writing over the site's own skill of that id is an edit; otherwise it takes over from a pack's.
    const site = await client.call<SiteStatus>('GET', '/api/bsp/site')
    const original = site.skills?.some(skill => skill.id === id && skill.layer === 'site') ? id : undefined
    const result = await client.call<{ file: string }>('POST', '/api/bsp/site/skill', { id, text, ...(original ? { original } : {}) })
    return out(result, () => console.log(`写好了 ${result.file}；boardlab sdk skill ${id} 可以装给 agent`))
  }
  if (what === 'set') {
    const kind = siteKind(word)
    const file = flag('file') ?? shortFile()
    if (!id || !file) throw new BoardsApiError(400, `要给 id 和 -f <文件|->\n${SITE_USAGE}`, 'invalid')
    const text = readFileSync(file === '-' ? 0 : resolve(file), 'utf8')
    // Writing over the site's own document of that id is an edit; anything else adds one (or takes over from a pack's).
    const site = await client.call<SiteStatus>('GET', '/api/bsp/site')
    const original = site.docs.some(doc => doc.kind === kind && doc.id === id && doc.layer === 'site') ? id : undefined
    const result = await client.call<{ file: string }>('POST', '/api/bsp/site/doc', { kind, id, text, ...(original ? { original } : {}) })
    return out(result, () => console.log(`写好了 ${result.file}；boardlab site sync 同步到主机`))
  }
  if (what === 'remove' && word === 'skill') {
    if (!id) throw new BoardsApiError(400, `要给 skill 的 id\n${SITE_USAGE}`, 'invalid')
    const result = await client.call<{ message: string }>('POST', '/api/bsp/site/skill/remove', { id })
    return out(result, () => console.log(result.message))
  }
  if (what === 'remove') {
    const kind = siteKind(word)
    if (!id) throw new BoardsApiError(400, `要给 id\n${SITE_USAGE}`, 'invalid')
    const result = await client.call<{ message: string }>('POST', '/api/bsp/site/remove', { kind, id })
    return out(result, () => console.log(result.message))
  }
  console.log(SITE_USAGE)
}

const site: Command = {
  name: 'site', noBoard: true, usage: ['site show | pull | push | sync | set <种类> <id> -f <文件> | remove <种类> <id>\tbsp 站点：SDK、编译服务器和 SoC 资料，boardd 保存、同步到每台板卡主机；skill <id> 是 SDK 自己的 SKILL.md（见 boardlab site help）'],
  run: siteCommand,
}

const sdk: Command = {
  name: 'sdk', noBoard: true, usage: ['sdk <操作> …\tSDK：在构建服务器上租源码树、编译、读写文件、跑命令；skill <sdk> 取 SDK 自己的 SKILL.md（boardd 那边的 bsp sdk 执行，见 boardlab sdk help）'],
  run: sdkCommand,
}

const registry: Command = {
  name: 'registry', noBoard: true, usage: ['registry sdk <操作> … | registry hosts\tSDK 目录（SDK、启动和刷机流程、构建服务器）：看、改、回滚，改动推到各板卡主机（见 boardlab registry help）'],
  run: ({ client, argv, json }) => registryCommand(client, argv, json),
}

const set: Command = {
  name: 'set', usage: ['set <bsp 板子> [--soc <SoC>] [--usb <下载口>] [--fdl button|strapped|unset] [--model <型号>] [--sdks <a,b>] [--reset-pin <P33>] [--pulse-ms <毫秒>] [--fdl-pin <P12>] [--description <说明>]\t补齐或修改实验室里一块 bsp 板子的登记（型号、SoC、下载口、怎么进下载模式）；boardd 拿你持有的锁的那份租约去改，你不用、也拿不到 bsp 的 token'],
  async run({ client, target, flag, out, token }) {
    const { board } = target()
    const body: Record<string, unknown> = { board, token: token(board) }
    for (const [key, name] of [['model', 'model'], ['soc', 'soc'], ['usb', 'usb'], ['fdl', 'fdl'], ['description', 'description'],
      ['resetPin', 'reset-pin'], ['fdlPin', 'fdl-pin']] as const) {
      const value = flag(name)
      if (value !== undefined) body[key] = value
    }
    const sdks = flag('sdks')
    if (sdks !== undefined) body.sdks = sdks
    const pulse = Number(flag('pulse-ms'))
    if (flag('pulse-ms') !== undefined) {
      if (!Number.isInteger(pulse) || pulse <= 0) throw new Error(`--pulse-ms 要是正整数：${flag('pulse-ms')}`)
      body.pulseMs = pulse
    }
    const given = Object.keys(body).filter(key => key !== 'board' && key !== 'token')
    if (!given.length) throw new Error('要给要改的字段，例如 boardlab set <板子> --soc k3 --usb usb:2-1.1.1 --fdl button')
    const result = await client.call<{ message: string }>('POST', '/api/bsp/board', body)
    out(result, () => console.log(`${board}：${result.message}`))
  },
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

export const commands: CommandGroup = { id: 'sdk', summary: 'SDK 构建、站点、SDK 目录、任意 bsp 命令', title: 'bsp：SDK 和构建', commands: [set, sdk, site, registry, bsp] }
