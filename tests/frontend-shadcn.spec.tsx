// @vitest-environment jsdom
/**
 * The shadcn frontend against the mock boardd: the board list and workspace, the lock with a one-click purpose, the
 * log search with download and wget, settings with the frontend switch, and discovery with rebuild.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { calls } from './frontend-setup.ts'

vi.mock('../src/ui/console.tsx', () => ({ SerialConsole: () => null, STATUS_TEXT: { connecting: '连接中', live: '实时', closed: '已关闭', retry: '重连中' } }))

const wait = { timeout: 4000 }
const row = async (name: string) => (await screen.findAllByText(name, {}, wait)).map(el => el.closest('tr')).find(Boolean)!
const button = async (label: string, within_: HTMLElement = document.body) => {
  const visible = (el: Element) => (el.textContent ?? '').replace(/\s/g, '') === label
  await waitFor(() => expect(within(within_).getAllByRole('button').some(visible)).toBe(true), wait)
  return within(within_).getAllByRole('button').find(visible)!
}
/** A page of the sidebar (its label also titles the page once open). */
const nav = async (label: string) => {
  // A nav item may carry a count after its label (`发现1`).
  await waitFor(() => expect([...document.querySelectorAll('aside nav button')].some(el => el.textContent?.startsWith(label))).toBe(true), wait)
  fireEvent.click([...document.querySelectorAll('aside nav button')].find(el => el.textContent?.startsWith(label))!)
}

beforeAll(async () => {
  document.body.innerHTML = '<div id="root"></div>'
  const { MODULE_UIS } = await import('../src/uis.ts')
  const { mountPage } = await import('../frontends/shadcn/main.tsx')
  mountPage(MODULE_UIS)
})

describe('shadcn frontend', () => {
  it('lists every board with its state, beside the chosen board\'s workspace', async () => {
    expect(await row('bsp-k1-musecard')).toBeTruthy()
    expect(screen.getByText('bob 在用')).toBeTruthy()
    expect(screen.getByText('串口不见了')).toBeTruthy()
    expect(screen.getByText('等人操作')).toBeTruthy()
    expect(await screen.findByRole('tab', { name: /串口/ }, wait)).toBeTruthy()
    expect(screen.getByRole('tab', { name: /日志/ })).toBeTruthy()
  })

  it('takes a lock with a one-click purpose', async () => {
    fireEvent.click(await row('bsp-k1-musecard'))
    fireEvent.click(await button('拿锁'))
    const dialog = await screen.findByRole('dialog', {}, wait)
    fireEvent.click(within(dialog).getByText('临时开发任务'))
    fireEvent.click(await button('拿锁', dialog))
    await waitFor(() => expect(calls.find(call => call.path === 'api/lock' && call.body && (call.body as { board: string }).board === 'bsp-k1-musecard')?.body)
      .toEqual({ board: 'bsp-k1-musecard', purpose: '临时开发任务' }), wait)
  })

  it('searches a board\'s log, and offers download and wget', async () => {
    fireEvent.click(await row('bsp-k3-cm1'))
    fireEvent.mouseDown(await screen.findByRole('tab', { name: /日志/ }, wait))
    expect(await screen.findByText(/mmc0 timeout/, {}, wait)).toBeTruthy()
    expect(calls.filter(call => call.path.startsWith('api/logs?')).at(-1)!.path).toMatch(/board=bsp-k3-cm1&die=die0&since=/)
    expect(await button('下载')).toBeTruthy()
    expect(await button('wget')).toBeTruthy()
  })

  it('shows the modules\' settings, and switches the frontend boardd serves', async () => {
    await nav('设置')
    expect(await screen.findByText('Home Assistant', {}, wait)).toBeTruthy()
    expect(await screen.findByText('米家插座 · 工位 3', {}, wait)).toBeTruthy()
    fireEvent.click(await screen.findByText('TroyMitchellDefault', {}, wait))
    await waitFor(() => expect(calls.some(call => call.method === 'POST' && call.path === 'api/frontends?name=troy-mitchell-default')).toBe(true), wait)
  })

  it('offers discovery, rebuilding a host, and the proposals', async () => {
    await nav('发现')
    expect(await screen.findByText('实验室 bsp', {}, wait)).toBeTruthy()
    expect(await button('重建')).toBeTruthy()
    expect(screen.getByText(/槽位 2 上的新板子/)).toBeTruthy()
    expect(await screen.findByText('扫描本机槽位', {}, wait)).toBeTruthy()
    // Boards are locked in this lab, which holds back discovering by reset lines; a person pairing a board by hand
    // resets nothing, so that stays open.
    const card = screen.getByText('人工复位的板子').closest('div.rounded-md') as HTMLElement
    expect((await button('开始', card) as HTMLButtonElement).disabled).toBe(false)
    // Discovering by reset lines stays held back while boards are locked.
    const pulse = screen.getByText('发现新板子').closest('div.rounded-md') as HTMLElement
    expect((await button('开始', pulse) as HTMLButtonElement).disabled).toBe(true)
  })
})
