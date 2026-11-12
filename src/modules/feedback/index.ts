/**
 * The `feedback` module: an inbox for the agents using this boardlab. When an agent finds that the architecture, an API
 * or a design cannot do what it needs, it files a request here (`boardlab feedback`, or POST /api/feedback), and the
 * people maintaining boardlab read them, fix them, and close them. Requests live in boardd's database, so they survive
 * restarts and updates; the state carries the open ones to the page.
 */
import { BoardError } from 'boardlab-core/core/errors.ts'
import type { Module } from 'boardlab-core/core/module.ts'
import { str, type Row } from 'boardlab-core/core/text.ts'
import type { State } from 'boardlab-core/shared/types.ts'

export const KINDS = ['bug', 'api', 'design', 'feature', 'other'] as const
export type FeedbackKind = typeof KINDS[number]
export const STATUSES = ['open', 'fixed', 'declined'] as const
export type FeedbackStatus = typeof STATUSES[number]

/** A request an agent (or a person) filed about boardlab itself. */
export interface Feedback {
  id: number
  at: string
  updatedAt: string
  /** Who filed it (`claude:…`, `user:…`). */
  actor: string
  kind: FeedbackKind
  subject: string
  body: string
  /** Whatever the agent attached (`{ "api": "/api/…" }`, a version): JSON, or null. */
  context: unknown | null
  status: FeedbackStatus
  /** How it was closed, and by whom. */
  resolution: string | null
  resolvedAt: string | null
  resolvedBy: string | null
}

/** The open requests, for the page and `GET /api/feedback`. */
export interface FeedbackInbox { open: number, items: Feedback[] }

const toFeedback = (row: Row): Feedback => ({
  id: Number(row.id), at: String(row.at), updatedAt: String(row.updated_at), actor: String(row.actor),
  kind: row.kind as FeedbackKind, subject: String(row.subject), body: String(row.body),
  context: row.context === null || row.context === undefined ? null : JSON.parse(String(row.context)),
  status: row.status as FeedbackStatus,
  resolution: str(row.resolution), resolvedAt: str(row.resolved_at), resolvedBy: str(row.resolved_by),
})

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()
const cleaned = (text: string) => text.replace(/\r\n?/g, '\n').trim()
const isStatus = (value: string): value is FeedbackStatus => (STATUSES as readonly string[]).includes(value)
const isKind = (value: string): value is FeedbackKind => (KINDS as readonly string[]).includes(value)

export interface FeedbackOptions {
  /** How many open requests the page state carries (the API lists more on request). */
  openShown?: number
}

export function feedback(options: FeedbackOptions = {}): Module<{ inbox(): FeedbackInbox, list(): Feedback[] }> {
  const shown = options.openShown ?? 50
  return {
    id: 'feedback',
    title: '意见箱',
    setup(lab) {
      lab.kernel.schema(`
        CREATE TABLE IF NOT EXISTS feedback (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL, updated_at TEXT NOT NULL, actor TEXT NOT NULL,
          kind TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, context TEXT,
          status TEXT NOT NULL DEFAULT 'open', resolution TEXT, resolved_at TEXT, resolved_by TEXT
        );
        CREATE INDEX IF NOT EXISTS feedback_status ON feedback(status, id);
      `)
      const rows = (status: FeedbackStatus | null, limit: number) => (status
        ? lab.kernel.db.prepare('SELECT * FROM feedback WHERE status=? ORDER BY id DESC LIMIT ?').all(status, limit)
        : lab.kernel.db.prepare('SELECT * FROM feedback ORDER BY id DESC LIMIT ?').all(limit)) as Row[]
      const count = () => Number((lab.kernel.db.prepare(`SELECT count(*) AS n FROM feedback WHERE status='open'`).get() as Row | undefined)?.n ?? 0)
      const list = (status: FeedbackStatus | null = 'open', limit = 100): Feedback[] => rows(status, limit).map(toFeedback)
      const inbox = (): FeedbackInbox => ({ open: count(), items: list('open', shown) })
      const find = (id: number): Feedback => {
        const row = lab.kernel.db.prepare('SELECT * FROM feedback WHERE id=?').get(id) as Row | undefined
        if (!row) throw new BoardError('not-found', `没有这条意见：#${id}`)
        return toFeedback(row)
      }

      lab.addState(() => ({ feedback: inbox() }) as unknown as Partial<State>)
      lab.api.add('feedback', [
        {
          method: 'POST', path: '/api/feedback',
          about: '提一条意见或请求：body（哪里不够用、你需要什么）、subject（标题，可选）、kind（bug、api、design、feature、other）、context（附带的 JSON）',
          handle: ({ body, caller }) => {
            const text = typeof body?.body === 'string' ? cleaned(body.body) : ''
            if (!text) throw new BoardError('invalid', '缺少 body：写清楚哪里不够用、你需要什么')
            const kind = body?.kind === undefined ? 'other' : String(body.kind)
            if (!isKind(kind)) throw new BoardError('invalid', `kind 要是 ${KINDS.join('、')}`)
            const subject = (typeof body?.subject === 'string' ? oneLine(body.subject) : '').slice(0, 200)
              || oneLine(text.split('\n')[0]!.replace(/^#+\s*/, '')).slice(0, 120)
            const context = body?.context === undefined || body?.context === null ? null : JSON.stringify(body.context)
            const now = lab.kernel.iso()
            const result = lab.kernel.db.prepare('INSERT INTO feedback(at, updated_at, actor, kind, subject, body, context) VALUES(?,?,?,?,?,?,?)')
              .run(now, now, caller.holder, kind, subject, text, context)
            lab.kernel.changed(null)
            return find(Number(result.lastInsertRowid))
          },
        },
        {
          method: 'GET', path: '/api/feedback',
          about: '看意见：status=open|fixed|declined|all（默认 open）、limit（默认 100）',
          handle: ({ query }) => {
            const status = query.get('status') ?? 'open'
            if (status !== 'all' && !isStatus(status)) throw new BoardError('invalid', 'status 要是 open、fixed、declined 或 all')
            const limit = Math.min(1000, Math.max(1, Number(query.get('limit') ?? 100) || 100))
            return { open: count(), items: list(status === 'all' ? null : status, limit) }
          },
        },
        {
          method: 'POST', path: '/api/feedback/resolve',
          about: '处理一条意见：id、status=fixed|declined|open（open 是重新打开）、resolution（说明，可选）',
          handle: ({ body, caller }) => {
            const id = Number(body?.id)
            if (!Number.isInteger(id) || id <= 0) throw new BoardError('invalid', '缺少 id')
            const status = String(body?.status ?? 'fixed')
            if (!isStatus(status)) throw new BoardError('invalid', `status 要是 ${STATUSES.join('、')}`)
            const before = find(id)
            const resolution = typeof body?.resolution === 'string' && body.resolution.trim() ? cleaned(body.resolution) : null
            const now = lab.kernel.iso()
            const open = status === 'open'
            lab.kernel.db.prepare('UPDATE feedback SET status=?, resolution=?, resolved_at=?, resolved_by=?, updated_at=? WHERE id=?')
              .run(status, open ? null : resolution ?? before.resolution, open ? null : now, open ? null : caller.holder, now, id)
            lab.kernel.changed(null)
            return { message: `#${id} ${open ? '重新打开' : status === 'fixed' ? '已修复' : '不采纳'}`, item: find(id) }
          },
        },
      ])
      return { inbox, list: () => list('open', 1000) }
    },
  }
}
