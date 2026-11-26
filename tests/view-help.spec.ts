import { describe, expect, it, vi } from 'vitest'
import { ui as bspUi } from '../src/modules/bsp/ui.ts'
import { ui as humanUi } from '../src/modules/human/ui.ts'
import { ui as systemUi } from '../src/modules/system/ui.ts'
import type { Operation, View } from '../src/ui/contract.ts'

describe('module help and update feedback', () => {
  it('links the existing operational help from the corresponding views', () => {
    const state = { boards: [], labs: [], modules: [] } as never
    expect(bspUi.views(state, {}).map((view: View) => [view.id, view.help])).toContainEqual(['bsp-hosts', 'board-hosts'])
    expect(humanUi.views(state, {}).map((view: View) => [view.id, view.help])).toContainEqual(['human', 'human'])
    expect(systemUi.views(state, {}).map((view: View) => [view.id, view.help])).toContainEqual(['version', 'release-source'])
  })

  it('does not describe a failed update lookup as up to date', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      version: '0.4.6rc1', revision: 'a'.repeat(40), source: 'https://example.test/release',
      latest: null, checkedAt: '2026-11-16T00:00:00Z', error: 'lookup failed', updating: false, newer: false,
    })))
    const version = systemUi.views({ boards: [], labs: [], modules: [] } as never, {}).find(view => view.id === 'version')
    const actions = version?.body.find(element => element.kind === 'actions')
    const check = actions?.kind === 'actions' ? actions.actions.find(action => action.id === 'check') : undefined
    expect(check?.kind).toBe('action')
    const outcome = await (check as Operation & { kind: 'action' }).run({})
    expect(outcome?.message).toContain('查新版失败：lookup failed')
    expect(outcome?.message).not.toContain('已经是最新')
    vi.unstubAllGlobals()
  })
})


describe('the human page keeps its history while the page refreshes', () => {
  const historyOf = (view: View | undefined) => view?.body.find(element => element.kind === 'group' && element.title === '历史')
  it('shows the history it already read on the next state, and reads it once', async () => {
    // What the module read is kept between page states: every refresh makes a new one, so a list that hung on the state
    // it was read for would go back to "reading" (and read again) on every event.
    const asked: string[] = []
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      asked.push(String(url))
      return Response.json({ open: 0, items: [{ id: 7, at: '2026-11-25T10:00:00Z', actor: 'claude:a', kind: 'plug', title: '拔线', body: '', status: 'done', resolution: '拔好了', resolvedAt: '2026-11-25T10:05:00Z', resolvedBy: 'user:dana', subject: null, source: 'ask' }] })
    }))
    vi.resetModules()
    const { ui: fresh } = await import('../src/modules/human/ui.ts')
    const page = () => ({ boards: [], labs: [], modules: [], human: { open: 0, items: [] } } as never)
    const view = () => historyOf(fresh.views(page(), {}).find((item: View) => item.id === 'human'))
    expect(view()).toMatchObject({ body: [{ kind: 'text', text: '正在读历史…' }] })
    await new Promise(done => setTimeout(done, 20))
    expect(view()).toMatchObject({ body: [{ kind: 'timeline', items: [{ tag: '做好了' }] }] })
    // A later state draws the same list from what was read, and does not ask again.
    expect(view()).toMatchObject({ body: [{ kind: 'timeline' }] })
    expect(asked.filter(url => url.includes('api/human/requests')).length).toBe(1)
    vi.unstubAllGlobals()
  })
})

describe('guidance', () => {
  it('the site view carries the guidance help page', () => {
    const state = { boards: [], labs: [], modules: [] } as never
    const site = bspUi.views(state, {}).find((view: View) => view.id === 'bsp-site')
    expect(site?.extra).toEqual({ 'bsp.guidanceHelp': 'guidance' })
  })
})
