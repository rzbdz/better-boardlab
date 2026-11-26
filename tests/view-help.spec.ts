import { describe, expect, it, vi } from 'vitest'
import { ui as systemUi } from '../src/modules/system/ui.ts'
import type { Operation, View } from '../src/ui/contract.ts'

describe('module help and update feedback', () => {
  it('links the existing operational help from the corresponding view', () => {
    const state = { boards: [], labs: [], modules: [] } as never
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

