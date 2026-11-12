/**
 * `boardlab feedback`: file a request about boardlab itself when its architecture, an API or a design cannot do what
 * the work needs; read what is open; close what has been fixed or will not be done. What is filed stays in boardd's
 * database, so the people maintaining boardlab find it on their next visit.
 */
import type { Command, CommandGroup } from 'boardlab-core/cli/command.ts'

/** The shape of a request, as `GET /api/feedback` and `POST /api/feedback` return it. */
interface Feedback {
  id: number
  at: string
  actor: string
  kind: string
  subject: string
  body: string
  status: string
  resolution: string | null
}

interface Inbox { open: number, items: Feedback[] }

const line = (item: Feedback) => `#${item.id}  [${item.kind}] ${item.subject}\n    ${item.actor}，${new Date(item.at).toLocaleString()}${item.status === 'open' ? '' : ` · ${item.status === 'fixed' ? '已修复' : '不采纳'}${item.resolution ? `：${item.resolution}` : ''}`}\n    ${item.body.replace(/\n/g, '\n    ')}`

const feedback: Command = {
  name: 'feedback', noBoard: true,
  usage: [
    'feedback <内容>\t提一条意见或请求：哪里不够用、你需要什么（--subject 标题，--kind bug|api|design|feature|other，--context JSON）',
    'feedback list [--all]\t看待处理的意见（--all 连已处理的）',
    'feedback resolve <id> [--status fixed|declined|open] [--note 说明]\t处理一条意见（open 是重新打开）',
  ],
  async run({ args, client, flag, flags, json, out }) {
    const [what, ...rest] = args
    // `list` and `resolve <id>` are subcommands; anything else is the request itself (`list the boards …` is text).
    const resolving = what === 'resolve' && rest.length > 0 && Number.isInteger(Number(rest[0])) && Number(rest[0]) > 0
    if (what === 'list' && !rest.length) {
      const inbox = await client.call<Inbox>('GET', `/api/feedback?status=${flags.has('all') ? 'all' : 'open'}`)
      out(inbox, () => {
        if (!inbox.items.length) return console.log(flags.has('all') ? '没有意见' : '没有待处理的意见')
        console.log(flags.has('all') ? `共 ${inbox.items.length} 条，${inbox.open} 条待处理：` : `${inbox.open} 条待处理（list --all 也看已处理的）：`)
        for (const item of inbox.items) console.log(`\n${line(item)}`)
      })
      return
    }
    if (resolving) {
      const id = Number(rest[0])
      const status = flag('status') ?? 'fixed'
      if (!['fixed', 'declined', 'open'].includes(status)) throw new Error('--status 要是 fixed、declined 或 open')
      const result = await client.call<{ message: string, item: Feedback }>('POST', '/api/feedback/resolve', {
        id, status, ...(flag('note') ? { resolution: flag('note') } : {}),
      })
      out(result, () => console.log(`${result.message}：${result.item.subject}`))
      return
    }
    const body = args.join(' ').trim()
    if (!body) throw new Error('要写意见或请求的内容，例如：boardlab feedback "想按槽位查板子的串口名"')
    let context: unknown
    if (flags.has('context')) {
      const given = flag('context')!
      try { context = JSON.parse(given) } catch { context = given }
    }
    const item = await client.call<Feedback>('POST', '/api/feedback', {
      body, kind: flag('kind') ?? 'other', ...(flag('subject') ? { subject: flag('subject') } : {}), ...(context === undefined ? {} : { context }),
    })
    out(item, () => console.log(`已记录 #${item.id}：${item.subject}`))
  },
}

export const commands: CommandGroup = { id: 'feedback', summary: '给 boardlab 提意见、看和关闭意见', title: '反馈', commands: [feedback] }
