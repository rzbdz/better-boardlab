/**
 * The human module's part of the page: what agents need a person at the bench to do — plug or unplug a cable,
 * connect a board, press a button — with 「我做好了」 and 「做不了」 for whoever is there. Agents create them with
 * `boardlab ask`; the page is how a person answers.
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
}

interface Inbox { open: number, items: HumanRequest[] }

const resolve = (id: number, status: 'done' | 'canceled', note?: string) =>
  call<{ message: string }>('POST', 'api/human/resolve', { id, status, ...(note ? { note } : {}) })

export const ui: ModuleUi = {
  module: 'human',
  views(state: PageState): View[] {
    const inbox = (state as PageState & { human?: Inbox }).human
    const items = inbox?.items ?? []
    return [{
      id: 'human', slot: 'page', title: '人工请求', help: 'human',
      status: inbox ? { tone: inbox.open ? 'warn' : 'ok', text: inbox.open ? `${inbox.open} 件在等人` : '没有等人' } : undefined,
      body: [
        text('需要现场操作的请求（插拔线、接板子、按按钮、按住 BOOT 再按 RESET）由 boardlab ask 创建，说明操作步骤和可验证的完成条件。完成后点「我做好了」；无法完成时点「做不了」并填写原因。请求结果会返回给发起方，物理操作的结果仍需由发起方验证。'),
        {
          kind: 'list', empty: '现在没有需要人做的事',
          items: items.map(item => ({
            key: String(item.id),
            title: `#${item.id} ${item.title}`,
            description: `${item.kind} · ${item.actor} · ${new Date(item.at).toLocaleString()}${item.body ? `\n${item.body}` : ''}`,
            actions: [
              action(`done-${item.id}`, '我做好了', async () => (await resolve(item.id, 'done')).message, { intent: 'primary' }),
              action(`cancel-${item.id}`, '做不了', async () => (await resolve(item.id, 'canceled', '现场没做')).message),
            ],
          })),
        },
      ],
    }]
  },
}
