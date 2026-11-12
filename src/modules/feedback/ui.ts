/**
 * The feedback module's part of the page: the requests agents filed about boardlab itself, with what each one needs,
 * and buttons to close one (fixed or not taken). People can file one too; the CLI is how an agent does it.
 */
import { call } from '../../ui/api.ts'
import { action, text, type ModuleUi, type PageState, type View } from '../../ui/contract.ts'

interface Feedback {
  id: number
  at: string
  actor: string
  kind: string
  subject: string
  body: string
  status: string
  resolution: string | null
  resolvedAt: string | null
}

interface Inbox { open: number, items: Feedback[] }

const KIND: Record<string, string> = { bug: '缺陷', api: '接口', design: '设计', feature: '功能', other: '其他' }
const within = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}…` : text
const resolve = (id: number, status: 'fixed' | 'declined') => call<{ message: string }>('POST', 'api/feedback/resolve', { id, status })

export const ui: ModuleUi = {
  module: 'feedback',
  views(state: PageState): View[] {
    const inbox = (state as PageState & { feedback?: Inbox }).feedback
    const items = inbox?.items ?? []
    return [{
      id: 'feedback', slot: 'page', title: '意见箱',
      status: inbox ? { tone: inbox.open ? 'info' : 'ok', text: inbox.open ? `${inbox.open} 条待处理` : '没有待处理' } : undefined,
      body: [
        text('使用这个 boardlab 的 AI 发现架构、接口或设计不够用时，可以提在这里（命令行 boardlab feedback）；维护的人看到后修复或说明不采纳，关掉就不再待处理。'),
        {
          kind: 'form', submitLabel: '提意见',
          fields: [
            { kind: 'text', id: 'subject', label: '标题', placeholder: '一句话说清（不填就用第一行）' },
            { kind: 'choice', id: 'kind', label: '类别', initial: 'api', options: [
              { value: 'api', label: '接口' }, { value: 'design', label: '设计' }, { value: 'bug', label: '缺陷' }, { value: 'feature', label: '功能' }, { value: 'other', label: '其他' },
            ] },
            { kind: 'code', id: 'body', label: '哪里不够用、你需要什么', required: true, rows: 5, placeholder: '正在做什么、现在只能怎么绕开、希望 boardlab 提供什么' },
          ],
          submit: action('submit', '提意见', async input => {
            const item = await call<Feedback>('POST', 'api/feedback', {
              subject: String(input.subject ?? ''), kind: String(input.kind ?? 'other'), body: String(input.body ?? ''),
            })
            return `已记录 #${item.id}：${item.subject}`
          }, { intent: 'primary' }),
        },
        {
          kind: 'list', empty: '没有待处理的意见',
          items: items.map(item => ({
            key: String(item.id),
            title: `#${item.id} ${item.subject}`,
            description: [`${KIND[item.kind] ?? item.kind} · ${item.actor} · ${new Date(item.at).toLocaleString()}`, within(item.body, 800)].join(' — '),
            actions: [
              action(`fixed-${item.id}`, '已修复', async () => (await resolve(item.id, 'fixed')).message, { intent: 'primary' }),
              action(`declined-${item.id}`, '不采纳', async () => (await resolve(item.id, 'declined')).message),
            ],
          })),
        },
      ],
    }]
  },
}
