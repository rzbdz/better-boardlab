/**
 * The human module: an agent asks a person at the bench to plug, connect or press something, waits for the answer; the
 * page shows the open requests, and a person marks one done or says it could not be done. Requests live in boardd's
 * database, so they survive restarts.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { openDatabase } from 'boardlab-core/core/db.ts'
import { BoardLab } from 'boardlab-core/core/lab.ts'
import { human, type HumanRequest } from '../src/modules/human/index.ts'
import { dir, useTempDir } from './fakes.ts'

useTempDir()

/** An endpoint called in the process, as the HTTP gateway would (the query in the path). */
async function call(lab: BoardLab, method: 'GET' | 'POST', path: string, body: Record<string, unknown> = {}, holder = 'claude:task-1'): Promise<any> {
  const url = new URL(path, 'http://boardd')
  const found = lab.api.match(method, url.pathname)
  if (!found) throw new Error(`no ${method} ${url.pathname}`)
  return found.endpoint.handle({ query: url.searchParams, params: found.params, body, caller: { holder, local: true } } as never)
}

const inbox = (lab: BoardLab, you = 'user:dana') => (lab.state(you) as unknown as { human: { open: number, items: HumanRequest[] } }).human

describe('the human inbox', () => {
  it('files a request, falls back to its first line as the title, and shows it to everyone as open', async () => {
    const lab = new BoardLab({
      db: openDatabase(join(dir, 'human.sqlite')), now: () => Date.parse('2026-11-13T10:00:00Z'), modules: [human()],
    })
    const filed = await call(lab, 'POST', '/api/human/ask', {
      body: 'Plug the K3 board\'s USB cable into port 2-1.1.\nThe console should print "ROM: usb download handler" when it is in.',
      kind: 'plug', context: { port: '2-1.1' },
    }) as HumanRequest
    expect(filed).toMatchObject({
      id: 1, actor: 'claude:task-1', kind: 'plug', status: 'open',
      title: 'Plug the K3 board\'s USB cable into port 2-1.1.', at: '2026-11-13T10:00:00.000Z',
      context: { port: '2-1.1' }, resolution: null, resolvedAt: null, resolvedBy: null,
    })
    expect(inbox(lab)).toMatchObject({ open: 1, items: [{ id: 1, title: 'Plug the K3 board\'s USB cable into port 2-1.1.' }] })
    expect(await call(lab, 'GET', '/api/human/requests')).toMatchObject({ open: 1, items: [{ id: 1 }] })
    expect((await call(lab, 'GET', '/api/human/requests?status=all')).items).toHaveLength(1)
  })

  it('takes a title of its own and refuses what it cannot understand', async () => {
    const lab = new BoardLab({ db: openDatabase(join(dir, 'human.sqlite')), modules: [human()] })
    const filed = await call(lab, 'POST', '/api/human/ask', { title: '  Connect   the UART  ', body: 'to the test point next to the button', kind: 'connect' }) as HumanRequest
    expect(filed).toMatchObject({ title: 'Connect the UART', kind: 'connect' })
    await expect(call(lab, 'POST', '/api/human/ask', { body: '   ' })).rejects.toThrow(/缺少 title/)
    await expect(call(lab, 'GET', '/api/human/requests?status=wish')).rejects.toThrow(/status 要是/)
    await expect(call(lab, 'GET', '/api/human/request?id=99')).rejects.toThrow(/没有这条人工请求：#99/)
  })

  it('asks once per key while it is open, and again once it was answered', async () => {
    const lab = new BoardLab({ db: openDatabase(join(dir, 'human.sqlite')), modules: [human()] })
    const first = await call(lab, 'POST', '/api/human/ask', { title: 'Press RESET once', key: 'reset-1' }) as HumanRequest
    const again = await call(lab, 'POST', '/api/human/ask', { title: 'Press RESET once', key: 'reset-1' }) as HumanRequest
    expect(again.id).toBe(first.id)
    const other = await call(lab, 'POST', '/api/human/ask', { title: 'Press RESET once', key: 'reset-1' }, 'claude:task-2') as HumanRequest
    expect(other.id).not.toBe(first.id)                                     // another agent's ask is its own
    await call(lab, 'POST', '/api/human/resolve', { id: first.id, status: 'done' }, 'user:dana')
    const third = await call(lab, 'POST', '/api/human/ask', { title: 'Press RESET once', key: 'reset-1' }) as HumanRequest
    expect(third.id).not.toBe(first.id)                                     // answered: the key is free again
  })

  it('is marked done or not done by a person, reopened, and listed by status', async () => {
    const lab = new BoardLab({
      db: openDatabase(join(dir, 'human.sqlite')), now: () => Date.parse('2026-11-13T10:00:00Z'), modules: [human()],
    })
    await call(lab, 'POST', '/api/human/ask', { title: 'Unplug the UART', body: 'the board is powered off first' })
    const done = await call(lab, 'POST', '/api/human/resolve', { id: 1, status: 'done', note: '拔好了' }, 'user:dana') as { message: string, item: HumanRequest }
    expect(done.message).toBe('#1 做好了')
    expect(done.item).toMatchObject({ status: 'done', resolution: '拔好了', resolvedBy: 'user:dana', resolvedAt: '2026-11-13T10:00:00.000Z' })
    expect(inbox(lab)).toEqual({ open: 0, items: [] })
    expect((await call(lab, 'GET', '/api/human/requests?status=done')).items).toMatchObject([{ id: 1 }])

    const reopened = await call(lab, 'POST', '/api/human/resolve', { id: 1, status: 'open' }) as { item: HumanRequest }
    expect(reopened.item).toMatchObject({ status: 'open', resolution: null, resolvedAt: null, resolvedBy: null })
    expect(inbox(lab).open).toBe(1)

    const canceled = await call(lab, 'POST', '/api/human/resolve', { id: 1, status: 'canceled', note: '线不够长' }, 'user:dana') as { item: HumanRequest }
    expect(canceled.item).toMatchObject({ status: 'canceled', resolution: '线不够长' })
    await expect(call(lab, 'POST', '/api/human/resolve', { id: 1, status: 'fixed' })).rejects.toThrow(/status 要是/)
  })

  it('waits for the answer, and gives back the open request when the wait runs out', async () => {
    const lab = new BoardLab({ db: openDatabase(join(dir, 'human.sqlite')), modules: [human()] })
    const filed = await call(lab, 'POST', '/api/human/ask', { title: 'Put the board into download mode' }) as HumanRequest
    const waiting = call(lab, 'GET', `/api/human/request?id=${filed.id}&wait=2`)
    setTimeout(() => void call(lab, 'POST', '/api/human/resolve', { id: filed.id, status: 'done' }, 'user:dana'), 50)
    expect(await waiting).toMatchObject({ id: filed.id, status: 'done', resolvedBy: 'user:dana' })

    const open = await call(lab, 'POST', '/api/human/ask', { title: 'Swap the SD card' }) as HumanRequest
    const started = Date.now()
    expect(await call(lab, 'GET', `/api/human/request?id=${open.id}&wait=0.2`)).toMatchObject({ id: open.id, status: 'open' })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('keeps what was asked across a restart', async () => {
    const file = join(dir, 'human.sqlite')
    const before = new BoardLab({ db: openDatabase(file), modules: [human()] })
    await call(before, 'POST', '/api/human/ask', { title: 'Survive an upgrade', kind: 'plug' })
    const after = new BoardLab({ db: openDatabase(file), modules: [human()] })
    expect(await call(after, 'GET', '/api/human/requests')).toMatchObject({ open: 1, items: [{ title: 'Survive an upgrade', kind: 'plug' }] })
  })
})
