/**
 * The human module's part of the page: what agents need a person at the bench to do — plug or unplug a cable,
 * connect a board, press a button — with 「我做好了」 and 「做不了」 for whoever is there, and the history of what was
 * asked and how it ended. Agents create them with `boardlab ask`, and a board waiting for a person files one from its
 * backend; both land in the same history.
 */
import { call } from '../../ui/api.ts'
import { action, text, type ModuleUi, type PageState, type View } from '../../ui/contract.ts'

interface HumanRequest {
  id: number
  at: string
  actor: string
  kind: string
  title: string
  body: string
  status: string
  resolution: string | null
  resolvedAt: string | null
  resolvedBy: string | null
  subject: string | null
  source: string
}

interface Inbox { open: number, items: HumanRequest[] }

const resolve = (id: number, status: 'done' | 'canceled', note?: string) =>
  call<{ message: string }>('POST', 'api/human/resolve', { id, status, ...(note ? { note } : {}) })

const STATUS_WORD: Record<string, string> = { open: '等人处理', done: '做好了', canceled: '做不了' }
const SOURCE_WORD: Record<string, string> = { ask: 'boardlab ask', relay: '板子等人操作' }
const when = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
const source = (item: HumanRequest) => SOURCE_WORD[item.source] ?? item.source

// The history is read from boardd (open asks already come with the state): a module's view is computed synchronously,
// so the read is started here and the page draws again when `api.call` reports it finished. What was read is kept
// between page states — every refresh makes a new one, and on a board that prints progress that is many a second — so
// the list stays on screen while it is read again, and a page of asks does not fetch its own history on each event.
let past: HumanRequest[] | null = null
let readAt = 0
let reading = false
function history(): HumanRequest[] | null {
  if (!reading && Date.now() - readAt > 10_000) {
    reading = true
    void call<Inbox>('GET', 'api/human/requests?status=all&limit=200')
      .then(out => { past = out.items.filter(item => item.status !== 'open') }, () => undefined)
      .then(() => { reading = false; readAt = Date.now() })
  }
  return past
}

export const ui: ModuleUi = {
  module: 'human',
  views(state: PageState): View[] {
    const inbox = (state as PageState & { human?: Inbox }).human
    const items = inbox?.items ?? []
    const history_now = history()
    return [{
      id: 'human', slot: 'page', title: '人工请求', help: 'human',
      status: inbox ? { tone: inbox.open ? 'warn' : 'ok', text: inbox.open ? `${inbox.open} 件在等人` : '没有等人' } : undefined,
      body: [
        text('需要现场操作的请求（插拔线、接板子、按按钮、按住 BOOT 再按 RESET）由 boardlab ask 创建，说明操作步骤和可验证的完成条件；板子自己停下等人（后端报告「请按 RESET」）也会出现在这里。完成后点「我做好了」；无法完成时点「做不了」并填写原因。请求结果会返回给发起方，物理操作的结果仍需由发起方验证。'),
        {
          kind: 'list', empty: '现在没有需要人做的事',
          items: items.map(item => ({
            key: String(item.id),
            title: `#${item.id} ${item.title}`,
            description: `${item.kind} · ${item.actor} · ${when(item.at)} · 来自${source(item)}${item.body ? `\n${item.body}` : ''}`,
            actions: [
              action(`done-${item.id}`, '我做好了', async () => (await resolve(item.id, 'done')).message, { intent: 'primary' }),
              action(`cancel-${item.id}`, '做不了', async () => (await resolve(item.id, 'canceled', '现场没做')).message),
            ],
          })),
        },
        {
          kind: 'group', title: '历史', layout: 'stack',
          body: history_now === null
            ? [{ kind: 'text', text: '正在读历史…', tone: 'neutral' }]
            : history_now.length
              ? [{ kind: 'timeline', items: history_now.map(item => ({ key: String(item.id), at: item.resolvedAt ?? item.at, tag: STATUS_WORD[item.status] ?? item.status, text: [`#${item.id} ${item.title} `, { muted: `· ${item.kind} · ${item.actor} · ${source(item)}` }, ...(item.resolution ? [` · ${item.resolution}`] : [])], tone: item.status === 'done' ? 'ok' : 'warn' })) }]
              : [{ kind: 'text', text: '还没有处理过的人工请求。', tone: 'neutral' }],
        },
      ],
    }]
  },
}
