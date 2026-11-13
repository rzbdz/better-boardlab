/**
 * `boardlab ask`: work that only a person at the bench can do — plug or unplug a cable, connect a board, press a
 * button, hold BOOT and RESET. The agent says exactly what to do, waits for someone to mark it done (or say they could
 * not), and then continues; nothing here touches a board itself.
 */
import { readFileSync } from 'node:fs'
import { parseDuration, type Command, type CommandGroup } from 'boardlab-core/cli/command.ts'

/** The shape of a request, as `GET /api/human/request` and `POST /api/human/ask` return it. */
interface HumanRequest {
  id: number
  at: string
  actor: string
  kind: string
  title: string
  body: string
  status: 'open' | 'done' | 'canceled'
  resolution: string | null
  resolvedAt: string | null
  resolvedBy: string | null
}

interface Inbox { open: number, items: HumanRequest[] }

const STATUS: Record<string, string> = { open: '等人处理', done: '做好了', canceled: '做不了' }
const line = (item: HumanRequest) => `#${item.id}  [${item.kind}] ${item.title}\n    ${item.actor}，${new Date(item.at).toLocaleString()} · ${STATUS[item.status] ?? item.status}${item.resolution ? `：${item.resolution}` : ''}${item.body ? `\n    ${item.body.replace(/\n/g, '\n    ')}` : ''}`

const ask: Command = {
  name: 'ask', noBoard: true,
  usage: [
    'ask <标题> [--body <说明>|--body -] [--kind 插拔|接线|按键|…] [--context <JSON>] [--key <去重键>] [--timeout 10m] [--no-wait]\t请人做一件板子外面的事（插拔线、接板子、按按钮）：登记后等人点「我做好了」，等到结果再继续；--body - 从标准输入读说明；--no-wait 只登记不等待',
    'ask list [--all]\t看人工请求（默认还在等人的）',
    'ask done <id> [--note 说明] | ask cancel <id> [--note 说明]\t替人关掉一条请求（人在页面上点也可以）',
  ],
  async run({ args, client, flag, flags, json, out }) {
    const [what, ...rest] = args
    if (what === 'list' && !rest.length) {
      const inbox = await client.call<Inbox>('GET', `/api/human/requests?status=${flags.has('all') ? 'all' : 'open'}`)
      out(inbox, () => {
        if (!inbox.items.length) return console.log(flags.has('all') ? '没有人工请求' : '没有还在等人的请求')
        console.log(`${inbox.items.length} 条：`)
        for (const item of inbox.items) console.log(`\n${line(item)}`)
      })
      return
    }
    const closing = (what === 'done' || what === 'cancel') && rest.length > 0 && Number.isInteger(Number(rest[0])) && Number(rest[0]) > 0
    if (closing) {
      const id = Number(rest[0])
      const result = await client.call<{ message: string, item: HumanRequest }>('POST', '/api/human/resolve', {
        id, status: what === 'done' ? 'done' : 'canceled', ...(flag('note') ? { note: flag('note') } : {}),
      })
      out(result, () => console.log(`${result.message}：${result.item.title}`))
      return
    }
    const title = args.join(' ').trim()
    if (!title) throw new Error('要写清楚请人做什么，例如：boardlab ask "把 K3 板的 USB 线插到 2-1.1" --body "插好后板上串口会出现 ROM: usb download handler"')
    let body = flag('body') ?? ''
    if (body === '-') body = readFileSync(0, 'utf8')
    let context: unknown
    if (flags.has('context')) {
      const given = flag('context')!
      try { context = JSON.parse(given) } catch { context = given }
    }
    const key = flag('key')
    let item = await client.call<HumanRequest>('POST', '/api/human/ask', {
      title, body, kind: flag('kind') ?? 'task', ...(key ? { key } : {}), ...(context === undefined ? {} : { context }),
    })
    if (flags.has('no-wait')) { out(item, () => console.log(`#${item.id} 已登记，等人处理：${item.title}`)); return }
    const timeout = flag('timeout') ?? '10m'
    const deadline = Date.now() + parseDuration(timeout)
    if (!json) console.error(`#${item.id} 等人处理：${item.title}（人在页面「人工请求」里点「我做好了」）`)
    while (item.status === 'open') {
      if (Date.now() > deadline) {
        throw new Error(`#${item.id} 还在等人处理（等了 ${timeout}）；请求还在，做好后 boardlab ask list 能看到结果${json ? '' : ''}`)
      }
      item = await client.call<HumanRequest>('GET', `/api/human/request?id=${item.id}&wait=20`)
    }
    out(item, () => {
      if (item.status === 'done') console.log(`#${item.id} 做好了${item.resolution ? `：${item.resolution}` : ''}`)
      else console.log(`#${item.id} 做不了${item.resolution ? `：${item.resolution}` : ''}`)
    })
    if (item.status === 'canceled') process.exitCode = 3
  },
}

export const commands: CommandGroup = { id: 'human', summary: '请人做板子外面的事（插拔、接线、按键），看和关请求', title: '人工请求', commands: [ask] }
