// @vitest-environment jsdom
/**
 * The Ant Design frontend against the mock boardd: what a person sees and what the page asks boardd to do. Queries go
 * by visible text and role, and every lookup waits for the page to render.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { calls } from './frontend-setup.ts'

// The serial console needs a canvas; its own behaviour is the console's to test, not the page's.
vi.mock('../frontends/antd/console.tsx', () => ({ SerialConsole: () => null, STATUS_TEXT: { connecting: '连接中', live: '实时', closed: '已关闭', retry: '重连中' } }))

const wait = { timeout: 4000 }
/** antd spaces out two-character Chinese button labels (`重 建`): match buttons ignoring spaces. */
const button = (label: string) => screen.findByRole('button', { name: (name: string) => name.replace(/\s/g, '') === label }, wait)
/** Text anywhere in an element, whichever pieces it is split into. */
const text = (value: string | RegExp) => screen.findAllByText((_, el) => !!el && el.children.length === 0 ? false : !!el?.textContent && (typeof value === 'string' ? el.textContent.includes(value) : value.test(el.textContent)), {}, wait)

beforeAll(async () => {
  document.body.innerHTML = '<div id="root"></div>'
  const { MODULE_UIS } = await import('../src/uis.ts')
  const { mountPage } = await import('../frontends/antd/main.tsx')
  mountPage(MODULE_UIS)
})

const goTo = async (page: string) => { location.hash = page; fireEvent.click(await screen.findByRole('menuitem', { name: new RegExp(page === 'boards' ? '板子' : page === 'discover' ? '发现' : page === 'history' ? '历史' : '设置') }, wait)) }

describe('Ant Design frontend', () => {
  it('lists every board with who has it, and the boards needing attention', async () => {
    expect(await screen.findByText('bsp-k1-musecard', {}, wait)).toBeTruthy()
    expect(screen.getAllByText('你在使用').length).toBeGreaterThan(0)
    expect(screen.getByText('bob 在用')).toBeTruthy()
    expect(screen.getByText('槽位串口不见了')).toBeTruthy()
    expect(screen.getByText('空槽位 host-b/s6')).toBeTruthy()
  })

  it('takes a lock with a one-click purpose', async () => {
    const row = (await screen.findByText('bsp-k1-musecard', {}, wait)).closest('tr')!
    fireEvent.click(row.querySelector('button')!)
    fireEvent.click(await screen.findByText('boardlab 调试', {}, wait))
    const dialog = await screen.findByRole('dialog', {}, wait)
    fireEvent.click(within(dialog).getByRole('button', { name: (name: string) => name.replace(/\s/g, '') === '拿锁' }))
    await waitFor(() => expect(calls.find(call => call.path === 'api/lock')?.body).toEqual({ board: 'bsp-k1-musecard', purpose: 'boardlab 调试' }), wait)
  })

  it('shows each module\'s settings as cards, and switching the frontend', async () => {
    await goTo('settings')
    expect(await screen.findByText('Home Assistant', {}, wait)).toBeTruthy()
    expect(await screen.findByText('米家插座 · 工位 3', {}, wait)).toBeTruthy()
    expect(await screen.findByText('TroyMitchellDefault', {}, wait)).toBeTruthy()
    // jsdom has no Notification: the card says why it cannot turn them on.
    expect(await screen.findByText('这个页面不能发系统通知', {}, wait)).toBeTruthy()
  })

  it('offers discovery, rebuilding a host, and the proposals waiting', async () => {
    await goTo('discover')
    expect((await text('实验室 bsp')).length).toBeGreaterThan(0)
    expect(await button('重建')).toBeTruthy()
    expect(screen.getByText(/槽位 2 上的新板子/)).toBeTruthy()
    expect(await screen.findByText('扫描本机槽位', {}, wait)).toBeTruthy()
  })
})
