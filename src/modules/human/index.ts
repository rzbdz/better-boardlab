/**
 * The `human` module: work that only a person at the bench can do. An agent asks for it here (`boardlab ask`, or
 * POST /api/human/ask) — plug or unplug a cable, connect a board, press a button, put the board into download mode —
 * and waits; the page shows the request to whoever is there, and they mark it done or say they could not. Requests
 * live in boardd's database, so they survive restarts and updates, and the state carries the open ones to the page.
 *
 * A board whose backend stops and waits for a person (`ACTION NEEDED: press RESET …`) files the same kind of request
 * from the relay's attention event, through the same archive (history.ts): the page shows one history however the ask
 * was made. That is the seam a lab's own helpdesk uses too -- it files asks through `HumanArchive`, not a table of
 * its own.
 */
import { BoardError } from 'boardlab-core/core/errors.ts'
import type { Module } from 'boardlab-core/core/module.ts'
import type { State } from 'boardlab-core/shared/types.ts'
import { cleaned, humanArchive, isStatus, oneLine, STATUSES, type HumanArchive, type HumanInbox, type HumanRequest, type HumanStatus } from './history.ts'

export { STATUSES, type HumanStatus, type HumanRequest, type HumanInbox, type HumanArchive }

export interface HumanOptions {
  /** How many open requests the page state carries (the API lists more on request). */
  openShown?: number
}

export function human(options: HumanOptions = {}): Module<{ inbox(): HumanInbox, list(): HumanRequest[], find(id: number): HumanRequest, archive: HumanArchive }> {
  const shown = options.openShown ?? 50
  return {
    id: 'human',
    title: '人工请求',
    setup(lab) {
      const archive = humanArchive(lab.kernel)
      const inbox = (): HumanInbox => archive.inbox(shown)
      const list = (status: HumanStatus | null = 'open', limit = 100): HumanRequest[] => archive.list(status, limit)
      const find = (id: number): HumanRequest => {
        const item = archive.find(id)
        if (!item) throw new BoardError('not-found', `没有这条人工请求：#${id}`)
        return item
      }

      // A board whose backend waits for a person files one ask per board, keyed by the board: the same "press RESET"
      // said again updates it, and the board no longer asking closes it. The ask is the same row `boardlab ask`
      // writes, so the page's history is one list.
      lab.kernel.events.on('event', event => {
        const e = event as { type?: string, board?: string, message?: string | null, holder?: string | null }
        if (e.type === 'renamed') {
          const { from, to } = e as { from: string, to: string }
          archive.rename(from, to)
          return
        }
        if (e.type !== 'attention' || !e.board) return
        const subject = `board:${e.board}`
        if (!e.message) { archive.close(subject, 'done', 'user:boardd', '板子不再等人了'); return }
        // No kind: the attention event says what the board waits for in its own words, and a board's reset button is
        // not the only thing it can wait for (a cable, a switch, a jumper). Labelling every ask "按键" would be this
        // module inventing something the backend did not say.
        archive.file({ actor: e.holder ?? 'user:boardd', title: `${e.board}：等人操作`, body: e.message, subject, source: 'relay', context: { request: (e as { request?: string | null }).request ?? null } })
      })

      lab.addState(() => ({ human: inbox() }) as unknown as Partial<State>)
      lab.api.add('human', [
        {
          method: 'POST', path: '/api/human/ask',
          about: '请人做一件板子外面的事：title（要做什么）、body（怎么做：哪根线、哪块板、做完什么样）、kind（插拔、接线、按键…，可选）、context（附带的 JSON）、key（同一件事的重试键，可选：同一个人同一个 key 还在等人时返回原来那条）',
          handle: ({ body, caller }) => {
            const text = typeof body?.body === 'string' ? cleaned(body.body) : ''
            const title = (typeof body?.title === 'string' ? oneLine(body.title) : '').slice(0, 200)
              || oneLine(text.split('\n')[0] ?? '').slice(0, 120)
            if (!title) throw new BoardError('invalid', '缺少 title：一句话说清要人做什么（或者写在 body 的第一行）')
            return archive.file({
              actor: caller.holder, title, body: text,
              kind: typeof body?.kind === 'string' ? body.kind : undefined,
              context: body?.context,
              key: typeof body?.key === 'string' ? body.key : null,
              source: 'ask',
            })
          },
        },
        {
          method: 'GET', path: '/api/human/requests',
          about: '看人工请求（也是历史）：status=open|done|canceled|all（默认 open）、limit（默认 100）；每条带 source（ask、relay、模块 id）和 subject（关于哪块板，若有）',
          handle: ({ query }) => {
            const status = query.get('status') ?? 'open'
            if (status !== 'all' && !isStatus(status)) throw new BoardError('invalid', 'status 要是 open、done、canceled 或 all')
            const limit = Math.min(1000, Math.max(1, Number(query.get('limit') ?? 100) || 100))
            return { open: archive.count(), items: archive.list(status === 'all' ? null : status, limit) }
          },
        },
        {
          method: 'GET', path: '/api/human/request',
          about: '等一条人工请求的结果：id，wait（最多等这么多秒，0–60，默认 0）；人做完或被取消后返回，超时也返回当前状态',
          handle: async ({ query }) => {
            const id = Number(query.get('id'))
            if (!Number.isInteger(id) || id <= 0) throw new BoardError('invalid', '缺少 id')
            const wait = Math.min(60, Math.max(0, Number(query.get('wait') ?? 0) || 0))
            const deadline = Date.now() + wait * 1000
            let item = find(id)
            while (item.status === 'open' && Date.now() < deadline) {
              await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now()))))
              item = find(id)
            }
            return item
          },
        },
        {
          method: 'POST', path: '/api/human/resolve',
          about: '处理一条人工请求：id、status=done|canceled|open（open 是重新打开）、note（说明，可选，例如「插好了」「线不够长」）',
          handle: async ({ body, caller }) => {
            const id = Number(body?.id)
            if (!Number.isInteger(id) || id <= 0) throw new BoardError('invalid', '缺少 id')
            const status = String(body?.status ?? 'done')
            if (!isStatus(status)) throw new BoardError('invalid', `status 要是 ${STATUSES.join('、')}`)
            const before = find(id)
            const note = typeof body?.note === 'string' && body.note.trim() ? cleaned(String(body.note)) : null
            const done = archive.resolve(id, status, caller.holder, note)
            // A board that stopped for a person has to be told too, or it stays '等人操作' with its run still waiting for
            // an answer nobody will give. The request it waits on is the one it filed (`context.request`).
            const board = before.source === 'relay' && before.subject?.startsWith('board:') ? before.subject.slice(6) : null
            let delivered: string | null = null
            if (board && status !== 'open') {
              const request = (before.context as { request?: string | null } | null)?.request ?? null
              delivered = await lab.relay.confirm(board, caller.holder, note ?? '', request).catch((error: unknown) => `板子那边没确认上：${(error as Error).message}`)
            }
            return { message: `#${id} ${status === 'open' ? '重新打开' : status === 'done' ? '做好了' : '做不了'}${delivered ? `；${delivered}` : ''}`, item: done }
          },
        },
      ])
      return { inbox, list: () => archive.list('open', 1000), find, archive }
    },
  }
}
