/**
 * The feedback module: agents file requests about boardlab itself, the open ones reach the page, and a maintainer closes
 * them fixed or not taken. They live in boardd's database, so they survive restarts.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { openDatabase } from 'boardlab-core/core/db.ts'
import { BoardLab } from 'boardlab-core/core/lab.ts'
import { feedback, type Feedback } from '../src/modules/feedback/index.ts'
import { dir, useTempDir } from './fakes.ts'

useTempDir()

/** An endpoint called in the process, as the HTTP gateway would (the query in the path). */
async function call(lab: BoardLab, method: 'GET' | 'POST', path: string, body: Record<string, unknown> = {}, holder = 'claude:task-1'): Promise<any> {
  const url = new URL(path, 'http://boardd')
  const found = lab.api.match(method, url.pathname)
  if (!found) throw new Error(`no ${method} ${url.pathname}`)
  return found.endpoint.handle({ query: url.searchParams, params: found.params, body, caller: { holder, local: true } } as never)
}

const inbox = (lab: BoardLab, you = 'user:dana') => (lab.state(you) as unknown as { feedback: { open: number, items: Feedback[] } }).feedback

describe('the feedback inbox', () => {
  it('files a request, derives its subject and shows it to everyone as open', async () => {
    const lab = new BoardLab({
      db: openDatabase(join(dir, 'feedback.sqlite')), now: () => Date.parse('2026-11-12T10:00:00Z'), modules: [feedback()],
    })
    const filed = await call(lab, 'POST', '/api/feedback', {
      body: 'The board API has no slot field.\nI have to list slots and match serial numbers by hand.', kind: 'api',
      context: { api: '/api/board' },
    }) as Feedback
    expect(filed).toMatchObject({
      id: 1, actor: 'claude:task-1', kind: 'api', status: 'open',
      subject: 'The board API has no slot field.', at: '2026-11-12T10:00:00.000Z',
      context: { api: '/api/board' }, resolution: null, resolvedAt: null, resolvedBy: null,
    })
    expect(inbox(lab)).toMatchObject({ open: 1, items: [{ id: 1, subject: 'The board API has no slot field.' }] })
    expect(await call(lab, 'GET', '/api/feedback')).toMatchObject({ open: 1, items: [{ id: 1 }] })
    expect((await call(lab, 'GET', '/api/feedback?status=all')).items).toHaveLength(1)
  })

  it('takes a subject, a kind and context of its own, and refuses what it cannot understand', async () => {
    const lab = new BoardLab({ db: openDatabase(join(dir, 'feedback.sqlite')), modules: [feedback()] })
    const filed = await call(lab, 'POST', '/api/feedback', {
      body: 'Let me look a console up by slot.', subject: '  Console by   slot ', kind: 'design', context: 'a note',
    }) as Feedback
    expect(filed).toMatchObject({ subject: 'Console by slot', kind: 'design', context: 'a note' })
    await expect(call(lab, 'POST', '/api/feedback', { body: '   ' })).rejects.toThrow(/缺少 body/)
    await expect(call(lab, 'POST', '/api/feedback', { body: 'x', kind: 'wish' })).rejects.toThrow(/kind 要是/)
    await expect(call(lab, 'GET', '/api/feedback?status=wish')).rejects.toThrow(/status 要是/)
  })

  it('closes a request fixed or not taken, reopens it, and says when it does not exist', async () => {
    const lab = new BoardLab({
      db: openDatabase(join(dir, 'feedback.sqlite')), now: () => Date.parse('2026-11-12T10:00:00Z'), modules: [feedback()],
    })
    await call(lab, 'POST', '/api/feedback', { body: 'A way to list consoles by slot.' })
    const fixed = await call(lab, 'POST', '/api/feedback/resolve', { id: 1, status: 'fixed', resolution: 'GET /api/consoles takes slot=' }, 'user:dana') as { message: string, item: Feedback }
    expect(fixed.message).toBe('#1 已修复')
    expect(fixed.item).toMatchObject({ status: 'fixed', resolution: 'GET /api/consoles takes slot=', resolvedBy: 'user:dana', resolvedAt: '2026-11-12T10:00:00.000Z' })
    expect(inbox(lab)).toEqual({ open: 0, items: [] })
    expect((await call(lab, 'GET', '/api/feedback?status=fixed')).items).toMatchObject([{ id: 1 }])

    const reopened = await call(lab, 'POST', '/api/feedback/resolve', { id: 1, status: 'open' }) as { item: Feedback }
    expect(reopened.item).toMatchObject({ status: 'open', resolution: null, resolvedAt: null, resolvedBy: null })
    expect(inbox(lab).open).toBe(1)

    const declined = await call(lab, 'POST', '/api/feedback/resolve', { id: 1, status: 'declined' }) as { item: Feedback }
    expect(declined.item.status).toBe('declined')
    await expect(call(lab, 'POST', '/api/feedback/resolve', { id: 99, status: 'fixed' })).rejects.toThrow(/没有这条意见：#99/)
    await expect(call(lab, 'POST', '/api/feedback/resolve', { id: 1, status: 'done' })).rejects.toThrow(/status 要是/)
  })

  it('keeps what was filed across a restart', async () => {
    const file = join(dir, 'feedback.sqlite')
    const before = new BoardLab({ db: openDatabase(file), modules: [feedback()] })
    await call(before, 'POST', '/api/feedback', { body: 'Survive an upgrade.', kind: 'feature' })
    const after = new BoardLab({ db: openDatabase(file), modules: [feedback()] })
    expect(await call(after, 'GET', '/api/feedback')).toMatchObject({ open: 1, items: [{ subject: 'Survive an upgrade.', kind: 'feature' }] })
  })
})
