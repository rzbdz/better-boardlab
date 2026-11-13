/**
 * The `human` module: work that only a person at the bench can do. An agent asks for it here (`boardlab ask`, or
 * POST /api/human/ask) — plug or unplug a cable, connect a board, press a button, put the board into download mode —
 * and waits; the page shows the request to whoever is there, and they mark it done or say they could not. Requests
 * live in boardd's database, so they survive restarts and updates, and the state carries the open ones to the page.
 */
import { BoardError } from 'boardlab-core/core/errors.ts'
import type { Module } from 'boardlab-core/core/module.ts'
import { str, type Row } from 'boardlab-core/core/text.ts'
import type { State } from 'boardlab-core/shared/types.ts'

export const STATUSES = ['open', 'done', 'canceled'] as const
export type HumanStatus = typeof STATUSES[number]

/** One thing an agent needs a person to do. */
export interface HumanRequest {
  id: number
  at: string
  updatedAt: string
  /** Who asked (`claude:…`, `user:…`). */
  actor: string
  /** A short label for the kind of work (plug, unplug, connect, press, …), free text. */
  kind: string
  title: string
  /** What to do, in the agent's words: which cable, which board, what to watch for. */
  body: string
  /** Whatever the agent attached: JSON, or null. */
  context: unknown | null
  status: HumanStatus
  /** How it ended, and who ended it. */
  resolution: string | null
  resolvedAt: string | null
  resolvedBy: string | null
}

/** The open requests, for the page and `GET /api/human/requests`. */
export interface HumanInbox { open: number, items: HumanRequest[] }

const toRequest = (row: Row): HumanRequest => ({
  id: Number(row.id), at: String(row.at), updatedAt: String(row.updated_at), actor: String(row.actor),
  kind: String(row.kind), title: String(row.title), body: String(row.body),
  context: row.context === null || row.context === undefined ? null : JSON.parse(String(row.context)),
  status: row.status as HumanStatus,
  resolution: str(row.resolution), resolvedAt: str(row.resolved_at), resolvedBy: str(row.resolved_by),
})

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()
const cleaned = (text: string) => text.replace(/\r\n?/g, '\n').trim()
const isStatus = (value: string): value is HumanStatus => (STATUSES as readonly string[]).includes(value)

export interface HumanOptions {
  /** How many open requests the page state carries (the API lists more on request). */
  openShown?: number
}

export function human(options: HumanOptions = {}): Module<{ inbox(): HumanInbox, list(): HumanRequest[], find(id: number): HumanRequest }> {
  const shown = options.openShown ?? 50
  return {
    id: 'human',
    title: '人工请求',
    setup(lab) {
      lab.kernel.schema(`
        CREATE TABLE IF NOT EXISTS human_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL, updated_at TEXT NOT NULL, actor TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'task', title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
          context TEXT, task_key TEXT, status TEXT NOT NULL DEFAULT 'open',
          resolution TEXT, resolved_at TEXT, resolved_by TEXT
        );
        CREATE INDEX IF NOT EXISTS human_requests_status ON human_requests(status, id);
        CREATE UNIQUE INDEX IF NOT EXISTS human_requests_key ON human_requests(actor, task_key)
          WHERE task_key IS NOT NULL AND status = 'open';
      `)
      const rows = (status: HumanStatus | null, limit: number) => (status
        ? lab.kernel.db.prepare('SELECT * FROM human_requests WHERE status=? ORDER BY id DESC LIMIT ?').all(status, limit)
        : lab.kernel.db.prepare('SELECT * FROM human_requests ORDER BY id DESC LIMIT ?').all(limit)) as Row[]
      const count = () => Number((lab.kernel.db.prepare(`SELECT count(*) AS n FROM human_requests WHERE status='open'`).get() as Row | undefined)?.n ?? 0)
      const list = (status: HumanStatus | null = 'open', limit = 100): HumanRequest[] => rows(status, limit).map(toRequest)
      const inbox = (): HumanInbox => ({ open: count(), items: list('open', shown) })
      const find = (id: number): HumanRequest => {
        const row = lab.kernel.db.prepare('SELECT * FROM human_requests WHERE id=?').get(id) as Row | undefined
        if (!row) throw new BoardError('not-found', `没有这条人工请求：#${id}`)
        return toRequest(row)
      }
      const openWithKey = (actor: string, key: string): HumanRequest | null => {
        const row = lab.kernel.db.prepare(`SELECT * FROM human_requests WHERE actor=? AND task_key=? AND status='open' ORDER BY id DESC LIMIT 1`).get(actor, key) as Row | undefined
        return row ? toRequest(row) : null
      }

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
            const kind = (typeof body?.kind === 'string' && body.kind.trim() ? oneLine(body.kind) : 'task').slice(0, 40)
            const context = body?.context === undefined || body?.context === null ? null : JSON.stringify(body.context)
            const key = typeof body?.key === 'string' && body.key.trim() ? body.key.trim().slice(0, 120) : null
            if (key) {
              const existing = openWithKey(caller.holder, key)
              if (existing) return existing           // a retry of the same ask: one request, not two
            }
            const now = lab.kernel.iso()
            const result = lab.kernel.db.prepare('INSERT INTO human_requests(at, updated_at, actor, kind, title, body, context, task_key) VALUES(?,?,?,?,?,?,?,?)')
              .run(now, now, caller.holder, kind, title, text, context, key)
            lab.kernel.changed(null)
            return find(Number(result.lastInsertRowid))
          },
        },
        {
          method: 'GET', path: '/api/human/requests',
          about: '看人工请求：status=open|done|canceled|all（默认 open）、limit（默认 100）',
          handle: ({ query }) => {
            const status = query.get('status') ?? 'open'
            if (status !== 'all' && !isStatus(status)) throw new BoardError('invalid', 'status 要是 open、done、canceled 或 all')
            const limit = Math.min(1000, Math.max(1, Number(query.get('limit') ?? 100) || 100))
            return { open: count(), items: list(status === 'all' ? null : status, limit) }
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
          handle: ({ body, caller }) => {
            const id = Number(body?.id)
            if (!Number.isInteger(id) || id <= 0) throw new BoardError('invalid', '缺少 id')
            const status = String(body?.status ?? 'done')
            if (!isStatus(status)) throw new BoardError('invalid', `status 要是 ${STATUSES.join('、')}`)
            const before = find(id)
            const note = typeof body?.note === 'string' && body.note.trim() ? cleaned(String(body.note)) : null
            const now = lab.kernel.iso()
            const open = status === 'open'
            lab.kernel.db.prepare('UPDATE human_requests SET status=?, resolution=?, resolved_at=?, resolved_by=?, updated_at=? WHERE id=?')
              .run(status, open ? null : note ?? before.resolution, open ? null : now, open ? null : caller.holder, now, id)
            lab.kernel.changed(null)
            return { message: `#${id} ${open ? '重新打开' : status === 'done' ? '做好了' : '做不了'}`, item: find(id) }
          },
        },
      ])
      return { inbox, list: () => list('open', 1000), find }
    },
  }
}
