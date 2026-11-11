// @vitest-environment jsdom
/**
 * The Ant Design frontend against the mock boardd: what a person sees and what the page asks boardd to do. Queries go
 * by visible text and role, and every lookup waits for the page to render.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { calls } from './frontend-setup.ts'

// The serial console needs a canvas; its own behaviour is the console's to test, not the page's.
vi.mock('../src/ui/console.tsx', () => ({ SerialConsole: () => null, reconnectConsole: () => {}, STATUS_TEXT: { connecting: '连接中', live: '实时', closed: '已断开，重连中', retry: '重连中' } }))

const wait = { timeout: 4000 }
/** A board's row in the list (its name also heads the workspace beside it). */
const row = async (name: string) => (await screen.findAllByText(name, {}, wait)).map(el => el.closest('tr')).find(Boolean)!
/** antd spaces out two-character Chinese button labels (`重 建`): match buttons ignoring spaces. */
const button = async (label: string) => {
  // A button's accessible name includes its icon's label (`lock 拿锁`): match the text a person sees.
  const visible = (el: Element) => (el.textContent ?? '').replace(/\s/g, '') === label
  await waitFor(() => expect(screen.getAllByRole('button').some(visible)).toBe(true), wait)
  return screen.getAllByRole('button').find(visible)!
}
/** Text anywhere in an element, whichever pieces it is split into. */
const text = (value: string | RegExp) => screen.findAllByText((_, el) => !!el && el.children.length === 0 ? false : !!el?.textContent && (typeof value === 'string' ? el.textContent.includes(value) : value.test(el.textContent)), {}, wait)

beforeAll(async () => {
  document.body.innerHTML = '<div id="root"></div>'
  const { MODULE_UIS } = await import('../src/uis.ts')
  const { mountPage } = await import('../frontends/antd/main.tsx')
  mountPage(MODULE_UIS)
})

const goTo = async (page: string) => { location.hash = page; fireEvent.click(await screen.findByRole('menuitem', { name: new RegExp(page === 'boards' ? '板子' : page === 'discover' ? '发现' : page === 'history' ? '历史' : '设置') }, wait)) }

// Ant Design renders slowly under jsdom; a loaded machine running the whole suite needs more than the default time.
describe('Ant Design frontend', { timeout: 30_000 }, () => {
  it('lists every board with who has it, beside the chosen board\'s workspace', async () => {
    expect(await row('bsp-k1-musecard')).toBeTruthy()
    expect(screen.getAllByText('你在使用').length).toBeGreaterThan(0)
    expect(screen.getByText('bob 在用')).toBeTruthy()
    expect(screen.getByText('串口不见了')).toBeTruthy()
    expect(screen.getByText('等人操作')).toBeTruthy()
    expect(screen.getByText('空槽位 host-b/s6')).toBeTruthy()
    // The workspace shows the first board, with its console, log and history tabs.
    expect(await screen.findByRole('tab', { name: /串口/ }, wait)).toBeTruthy()
    expect(screen.getByRole('tab', { name: /日志/ })).toBeTruthy()
  })

  it('takes a lock with a one-click purpose, from the workspace', async () => {
    fireEvent.click(await row('bsp-k1-musecard'))
    fireEvent.click(await button('拿锁'))
    fireEvent.click(await screen.findByText('boardlab 调试', {}, wait))
    const dialog = await screen.findByRole('dialog', {}, wait)
    fireEvent.click(within(dialog).getAllByRole('button').find(el => (el.textContent ?? '').replace(/\s/g, '') === '拿锁')!)
    await waitFor(() => expect(calls.find(call => call.path === 'api/lock')?.body).toEqual({ board: 'bsp-k1-musecard', purpose: 'boardlab 调试' }), wait)
  })

  it('searches a board\'s log over a range, and offers download and wget', async () => {
    fireEvent.click(await row('bsp-k3-cm1'))
    fireEvent.click(await screen.findByRole('tab', { name: /日志/ }, wait))
    expect(await screen.findByText(/mmc0 timeout/, {}, wait)).toBeTruthy()
    const search = calls.filter(call => call.path.startsWith('api/logs?')).at(-1)!
    expect(search.path).toMatch(/board=bsp-k3-cm1&die=die0&since=\d{4}-\d\d-\d\d\+\d\d%3A\d\d%3A\d\d&until=/)
    expect(await button('下载')).toBeTruthy()
    expect(await button('wget')).toBeTruthy()
  })

  it('shows each module\'s settings as cards, and switching the frontend', async () => {
    await goTo('settings')
    expect(await screen.findByText('Home Assistant', {}, wait)).toBeTruthy()
    expect(await screen.findByText('米家插座 · 工位 3', {}, wait)).toBeTruthy()
    expect(await screen.findByText('TroyMitchellDefault', {}, wait)).toBeTruthy()
    // Switching asks boardd to serve the other frontend.
    fireEvent.click(await screen.findByText('TroyMitchellDefault', {}, wait))
    await waitFor(() => expect(calls.some(call => call.method === 'POST' && call.path === 'api/frontends?name=troy-mitchell-default')).toBe(true), wait)
    // jsdom has no Notification: the card says why it cannot turn them on.
    expect(await screen.findByText('这个页面不能发系统通知', {}, wait)).toBeTruthy()
  })

  it('offers discovery, rebuilding a host, and the proposals waiting', async () => {
    await goTo('discover')
    expect((await text('实验室 bsp')).length).toBeGreaterThan(0)
    expect(await button('重建')).toBeTruthy()
    expect(screen.getByText(/槽位 2 上的新板子/)).toBeTruthy()
    expect(await screen.findByText('扫描本机槽位', {}, wait)).toBeTruthy()
    // Boards are locked in this lab, which holds back discovering by reset lines; a person pairing a board by hand
    // resets nothing, so that stays open.
    const start = await button('开始')
    expect((start as HTMLButtonElement).disabled).toBe(false)
  })
})
