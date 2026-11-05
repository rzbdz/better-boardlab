/** boards CLI. Talks to boardd over its Unix socket; `boards serve` runs boardd itself. */
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { BoardsApiError, BoardsClient, DEFAULT_PORT, defaultStateDir, socketPathFor } from '../shared/client.ts'
import type { Board, Scan, State } from '../shared/types.ts'

const USAGE = `用法：boards <命令> [参数] [--json] [--as <持有人>]

  list                                 板子、芯片、槽位和锁
  show <board>                         详情、最近的操作和锁记录
  lock <board> --for <用途> [--wait]    锁没有时间限制；--wait 排队直到拿到
  queue <board> --for <用途>            加入排队，先到先得；轮到你时自动拿到锁
  unqueue <board> | unlock <board>
  steal <board> --reason <原因>         仅限人
  reset <board> | fastboot <board>     需要持有锁
  console <board>[.<die>]              只读串口输出（Ctrl-C 退出）
  send <board>[.<die>] <text> [--wait <正则>] [--timeout 10s] [--raw]
  log <board>[.<die>] [--lines 200]
  stage <board>[.<die>] <固件名>       往内存加载 boardd 自带的固件，例如 minor-board-info
  boot <board>[.<die>] <固件名|文件>... 按顺序把 FSBL、U-Boot/OpenSBI、内核加载到内存启动，不写板子；
                                       只改内核时：boot <board> fsbl u-boot-opensbi <Image.itb>
  scan [--boards a,b] [--slots 0,1] [--yes]
  proposals [apply|reject] [<id>...|--all] [--name <板名>]   只能复位的槽位上的新板子要用 --name 起名
  ha set <url> [--token-stdin] | ha test   验证通过后自动从 HA 同步槽位
  slot set <n> --reset-script <文件|-> [--fastboot-script <文件>] [--label <名称>]
                                       自定义槽位；没有 fastboot 脚本就只能复位
  slot remove <n>
  firmware                             列出 boardd 自带的固件（仓库的 firmware/）
  remove <board> | export
  serve [--port ${DEFAULT_PORT}] [--host <额外监听地址,…>] [--state-dir <dir>]

持有人默认是 user:$USER；agent 用 --as claude:<会话> 或环境变量 BOARDS_HOLDER。`

interface Args { positional: string[], flags: Map<string, string | true> }

export function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  const booleans = new Set(['json', 'wait', 'yes', 'raw', 'all', 'confirm', 'token-stdin', 'help'])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) { positional.push(arg); continue }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined]
    // `lock --wait` is a switch; `send --wait <pattern>` takes the pattern.
    const isSwitch = booleans.has(name) && !(name === 'wait' && positional[0] === 'send')
    if (inline !== undefined) flags.set(name, inline)
    else if (isSwitch || i + 1 >= argv.length) flags.set(name, true)
    else flags.set(name, argv[++i]!)
  }
  return { positional, flags }
}

export function parseDuration(text: string): number {
  const match = text.match(/^(\d+)(s|m|h)?$/)
  if (!match) throw new Error(`时长格式不对：${text}（例如 30m、2h、90s）`)
  return Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[(match[2] ?? 'm') as 's' | 'm' | 'h']
}

const splitTarget = (target: string) => { const [board, die] = target.split('.', 2) as [string, string | undefined]; return { board, die } }

/** Lease tokens this user's CLI obtained, so later commands of the same holder can prove the lease. */
class TokenStore {
  constructor(private readonly file: string) {}
  private read(): Record<string, string> { try { return JSON.parse(readFileSync(this.file, 'utf8')) } catch { return {} } }
  private write(data: Record<string, string>) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    writeFileSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 })
    chmodSync(this.file, 0o600)
  }
  get(holder: string, board: string) { return this.read()[`${holder} ${board}`] ?? null }
  set(holder: string, board: string, token: string | null) {
    const data = this.read()
    if (token) data[`${holder} ${board}`] = token; else delete data[`${holder} ${board}`]
    this.write(data)
  }
}

/** While the lock is held only this token gets input past the board's serial-mux gate. */
function gateHint(gateToken: string | null) {
  if (gateToken) console.log(`直接用 smtty 输入时带上 --token ${gateToken}（或设 SERIAL_MUX_TOKEN）；不带的只能看输出`)
}

function leaseText(board: Board) {
  const queue = board.waiters.length ? `；排队：${board.waiters.map((waiter, index) => `${index + 1}. ${waiter.holder}`).join(' ')}` : ''
  return board.lease ? `${board.lease.holder} 使用中（${board.lease.purpose}）${queue}` : `空闲${queue}`
}

function printState(state: State) {
  for (const board of state.boards) {
    const place = board.lab ? `[实验室 ${board.lab.id} ${board.lab.device}]` : board.slot === null ? '  -' : `[${board.slot}]`
    console.log(`${place} ${board.name}  ${board.product ?? '型号未知'}  ${leaseText(board)}`)
    for (const chip of board.chips) {
      if (board.lab) { console.log(`      ${chip.die}: 串口 BMC ${chip.serialPath ?? '-'}（${chip.online ? '在线' : '没有连上'}）  下载口 跳板机 ${chip.downloadUsbPath ?? '-'}`); continue }
      console.log(`      ${chip.die}: 串口 ${chip.serialPath ?? '-'}${chip.alias ? `（serial-mux ${chip.alias}${chip.online ? '' : '，未绑定设备'}）` : ''}  下载口 ${chip.downloadUsbPath ?? '-'}${chip.usbId ? ` (${chip.usbId})` : ''}`)
    }
  }
  const empty = state.slots.filter(slot => !state.boards.some(board => board.slot === slot.slot))
  for (const slot of empty) console.log(`[${slot.slot}] （空槽位）`)
  if (state.proposals.length) console.log(`\n${state.proposals.length} 条扫描改动建议待确认：boards proposals`)
}

function printScan(scan: Scan) {
  console.log(`扫描 ${scan.id.slice(0, 8)}：${scan.status}${scan.message ? `（${scan.message}）` : ''}`)
  for (const row of scan.result) {
    console.log(`  槽位 ${row.slot} ${row.board ?? '（未登记）'}`)
    for (const chip of row.chips) console.log(`    ${chip.die}${chip.pending ? '（待人确认）' : ''}: 串口 ${chip.serialPath ?? '-'}  下载口 ${chip.downloadUsbPath ?? '-'}  型号 ${chip.product ?? '未知'}`)
    for (const flag of row.flags) console.log(`    ! ${flag}`)
  }
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`${question} [y/N] `)
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}

function streamConsole(client: BoardsClient, board: string, die?: string): Promise<void> {
  const path = `/api/console?board=${encodeURIComponent(board)}${die ? `&die=${encodeURIComponent(die)}` : ''}`
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: client.socketPath, path, headers: client.holder ? { 'x-boards-holder': client.holder } : {} }, response => {
      if (response.statusCode !== 200) {
        let text = ''
        response.on('data', chunk => { text += chunk })
        response.on('end', () => reject(new Error(JSON.parse(text).error ?? text)))
        return
      }
      let buffer = ''
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
          if (event === 'history') process.stdout.write((value as string[]).join('\n') + '\n')
          else if (event === 'output') process.stdout.write(value)
          else if (event === 'closed') process.stdout.write(`\n[串口关闭：${value}]\n`)
        }
      })
      response.on('end', resolve)
    })
    req.on('error', reject)
    process.once('SIGINT', () => { req.destroy(); resolve() })
    req.end()
  })
}

export async function main(argv: string[]) {
  const { positional, flags } = parseArgs(argv)
  const [command, ...rest] = positional
  const json = flags.has('json')
  const flag = (name: string) => { const value = flags.get(name); return typeof value === 'string' ? value : undefined }
  const out = (value: unknown, text: () => void) => json ? console.log(JSON.stringify(value, null, 2)) : text()
  if (!command || flags.has('help') || command === 'help') return console.log(USAGE)

  const stateDir = resolve(flag('state-dir') ?? defaultStateDir())
  if (command === 'serve') {
    const { startBoardd } = await import('../server/main.ts')
    const here = dirname(fileURLToPath(import.meta.url))
    const uiDir = [join(here, 'ui'), join(here, '../../dist/ui')].find(dir => existsSync(join(dir, 'index.html'))) ?? null
    // dist/ and src/cli/ both sit at the repository root.
    const firmwareDir = [join(here, '../firmware'), join(here, '../../firmware')].find(dir => existsSync(join(dir, 'firmware.json')))
    const hosts = (flag('host') ?? process.env.BOARDS_HOSTS)?.split(',').map(host => host.trim()).filter(Boolean)
    const boardd = await startBoardd({ stateDir, port: flag('port') ? Number(flag('port')) : undefined, hosts, uiDir, firmwareDir })
    console.log(`boardd 已启动：${boardd.hosts.map(host => `http://${host}:${boardd.port}/`).join('  ')}  socket ${socketPathFor(stateDir)}${uiDir ? '' : '（网页未构建）'}`)
    const stop = async () => { await boardd.close(); process.exit(0) }
    process.on('SIGINT', stop); process.on('SIGTERM', stop)
    return
  }

  const holder = flag('as') ?? process.env.BOARDS_HOLDER ?? `user:${process.env.USER ?? 'unknown'}`
  const client = new BoardsClient(socketPathFor(stateDir), holder)
  const tokens = new TokenStore(join(stateDir, 'cli-tokens.json'))
  const target = rest[0] ? splitTarget(rest[0]) : null
  const need = () => { if (!target) throw new Error('缺少板名'); return target }
  const token = () => tokens.get(holder, need().board)

  switch (command) {
    case 'list': { const state = await client.state(); return out(state, () => printState(state)) }
    case 'show': {
      const detail = await client.board(need().board)
      return out(detail, () => {
        printState({ boards: [detail.board], slots: [], proposals: [], now: new Date().toISOString() } as unknown as State)
        if (detail.board.notes) console.log(`\n备注：\n${detail.board.notes}`)
        console.log('\n最近操作：')
        for (const action of detail.actions.slice(0, 15)) console.log(`  ${action.at}  ${action.actor}  ${action.kind}${action.detail ? ` ${action.detail}` : ''}${action.ok ? '' : `  失败：${action.message}`}`)
      })
    }
    case 'lock': {
      const purpose = flag('for')
      if (!purpose) throw new Error('请用 --for 写明用途')
      if (flags.has('wait') && !json) console.error(`排队等待 ${need().board} …`)
      const abort = new AbortController()
      process.once('SIGINT', () => abort.abort())
      const result = await client.lock(need().board, purpose, flags.has('wait') ? 'wait' : 'none', abort.signal)
      tokens.set(holder, need().board, result.token)
      return out(result, () => { console.log(`已拿到 ${need().board} 的锁，用完请 boards unlock ${need().board}`); gateHint(result.gateToken) })
    }
    case 'queue': {
      const purpose = flag('for')
      if (!purpose) throw new Error('请用 --for 写明用途')
      const result = await client.lock(need().board, purpose, 'join')
      if (result.token) tokens.set(holder, need().board, result.token)
      return out(result, () => { console.log(result.lease ? `${need().board} 空闲，已直接拿到锁` : `已排队，第 ${result.queued!.position} 位；轮到你时自动拿到锁，再运行 boards lock 取凭证`); gateHint(result.gateToken) })
    }
    case 'unqueue': await client.unqueue(need().board); return out({ ok: true }, () => console.log(`已退出 ${need().board} 的排队`))
    case 'unlock': {
      await client.unlock(need().board, token())
      tokens.set(holder, need().board, null)
      return out({ ok: true }, () => console.log(`已释放 ${need().board}`))
    }
    case 'steal': {
      const reason = flag('reason')
      if (!reason) throw new Error('抢锁要用 --reason 写明原因')
      const result = await client.steal(need().board, reason)
      tokens.set(holder, need().board, result.token)
      return out(result, () => { console.log(`已抢到 ${need().board} 的锁`); gateHint(result.gateToken) })
    }
    case 'reset': await client.reset(need().board, token()); return out({ ok: true }, () => console.log(`${need().board} 已复位`))
    case 'fastboot': await client.fastboot(need().board, token()); return out({ ok: true }, () => console.log(`${need().board} 已进入 fastboot`))
    case 'console': return streamConsole(client, need().board, need().die)
    case 'send': {
      const text = rest[1]
      if (text === undefined) throw new Error('缺少要发送的内容')
      const result = await client.send(need().board, {
        die: need().die, text, newline: !flags.has('raw'), wait: flag('wait'), timeoutMs: flag('timeout') ? parseDuration(flag('timeout')!) : undefined, token: token(),
      })
      out(result, () => process.stdout.write(result.output + (result.output.endsWith('\n') ? '' : '\n')))
      if (flag('wait') && !result.matched) process.exitCode = 2
      return
    }
    case 'log': { const result = await client.log(need().board, need().die, Number(flag('lines') ?? 200)); return out(result, () => console.log(result.lines.join('\n'))) }
    case 'stage': {
      if (!rest[1]) throw new Error('缺少固件名，例如 minor-board-info')
      const result = await client.stage(need().board, rest[1], need().die, token())
      return out(result, () => console.log(result.output))
    }
    case 'boot': {
      const files = rest.slice(1)
      if (!files.length) throw new Error('缺少启动文件，例如 boards boot com260 fsbl u-boot-opensbi Image.itb')
      // Bare names like fsbl are boardd's own firmware; anything with a dot or slash is a file here.
      const result = await client.boot(need().board, files.map(file => /^[a-z0-9][a-z0-9-]*$/.test(file) ? file : resolve(file)), need().die, token())
      return out(result, () => console.log(result.output))
    }
    case 'scan': {
      const list = (name: string) => flag(name)?.split(',').map(item => item.trim()).filter(Boolean)
      const scope = { boards: list('boards'), slots: list('slots')?.map(Number) }
      if (!flags.has('yes') && !(await confirm(`扫描会逐个按 fastboot、往内存加载诊断镜像并复位${scope.boards ? ` ${scope.boards.join(', ')}` : scope.slots ? `槽位 ${scope.slots.join(', ')}` : '所有槽位'}。继续？`))) {
        throw new Error('扫描需要确认（交互确认或 --yes）')
      }
      let scan = await client.scan({ ...scope, confirmed: true })
      let shown = 0
      while (scan.status === 'running') {
        await new Promise(done => setTimeout(done, 1000))
        scan = await client.scanStatus(scan.id)
        if (!json) for (const step of scan.steps.slice(shown)) console.error(`  ${step.slot === null ? '' : `[${step.slot}] `}${step.summary}`)
        shown = scan.steps.length
      }
      out(scan, () => printScan(scan))
      if (scan.status !== 'done') process.exitCode = 1
      return
    }
    case 'proposals': {
      const state = await client.state()
      const decision = rest[0]
      if (decision !== 'apply' && decision !== 'reject') {
        return out(state.proposals, () => state.proposals.length
          ? state.proposals.forEach(item => console.log(`${item.id.slice(0, 8)}  [${item.slot}] ${item.summary}`))
          : console.log('没有待确认的改动建议'))
      }
      const ids = flags.has('all') ? state.proposals.map(item => item.id) : rest.slice(1).map(prefix => {
        const found = state.proposals.filter(item => item.id.startsWith(prefix))
        if (found.length !== 1) throw new Error(`找不到唯一的建议：${prefix}`)
        return found[0]!.id
      })
      const name = flag('name')
      if (name && ids.length !== 1) throw new Error('--name 只能配一条建议')
      await client.resolveProposals(ids, decision, name ? { [ids[0]!]: name } : undefined)
      return out({ ok: true }, () => console.log(`已${decision === 'apply' ? '应用' : '拒绝'} ${ids.length} 条建议`))
    }
    case 'ha': {
      const sub = rest[0]
      if (sub === 'set') {
        if (!rest[1]) throw new Error('缺少 Home Assistant 地址')
        const secret = flags.has('token-stdin') ? readFileSync(0, 'utf8').trim() : undefined
        const result = await client.configureHa(rest[1], secret)
        return out(result, () => console.log(result.verifyOk ? `已连接：${result.verifyMessage}` : `保存了，但验证失败：${result.verifyMessage}`))
      }
      if (sub === 'test') { const result = await client.testHa(); return out(result, () => console.log(result.verifyOk ? `正常：${result.verifyMessage}` : `失败：${result.verifyMessage}`)) }
      throw new Error('ha 子命令：set、test')
    }
    case 'slot': {
      const sub = rest[0]
      const slot = Number(rest[1])
      if ((sub !== 'set' && sub !== 'remove') || !Number.isInteger(slot)) throw new Error('slot 子命令：set <n> --reset-script <文件>、remove <n>')
      if (sub === 'remove') { await client.removeScriptSlot(slot); return out({ ok: true }, () => console.log(`已删除槽位 ${slot}`)) }
      const script = (path: string | undefined) => path === undefined ? null : readFileSync(path === '-' ? 0 : path, 'utf8')
      const resetScript = script(flag('reset-script'))
      if (!resetScript) throw new Error('请用 --reset-script 给出复位脚本（- 表示从标准输入读）')
      const saved = await client.saveScriptSlot({ slot, label: flag('label') ?? null, resetScript, fastbootScript: script(flag('fastboot-script')) })
      return out(saved, () => console.log(`已保存槽位 ${slot}${saved.canFastboot ? '' : '（只能复位）'}`))
    }
    case 'firmware': {
      const { firmware } = await client.state()
      return out(firmware, () => console.log(firmware.map(item => `${item.soc}\t${item.purpose}\t${item.path}\t${item.sha256.slice(0, 16)}…${item.note ? `\t${item.note}` : ''}`).join('\n') || '没有自带固件'))
    }
    case 'remove': await client.removeBoard(need().board); return out({ ok: true }, () => console.log(`已移除 ${need().board}`))
    case 'export': return process.stdout.write(await client.exportToml())
    default: throw new Error(`未知命令：${command}\n\n${USAGE}`)
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof BoardsApiError || error instanceof Error ? error.message : String(error))
    process.exit(error instanceof BoardsApiError && error.status === 423 ? 3 : 1)
  })
}
