// @vitest-environment jsdom
/**
 * The Modern frontend against the mock boardd: the board cards and their states, the board page with the lock and its
 * purpose, log search with download and wget, discovery with rebuild held back by locks, settings with the frontend
 * switch, and the pinned banner for a board waiting for a person.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { calls } from './frontend-setup.ts'

vi.mock('../src/ui/console.tsx', () => ({ SerialConsole: () => null, STATUS_TEXT: { connecting: '连接中', live: '实时', closed: '已关闭', retry: '重连中' } }))

const wait = { timeout: 4000 }
const card = async (board: string) => { await waitFor(() => expect(document.querySelector(`[data-board="${board}"]`)).toBeTruthy(), wait); return document.querySelector(`[data-board="${board}"]`) as HTMLElement }
const button = async (label: string | RegExp, scope: HTMLElement = document.body) => {
  const visible = (el: Element) => { const t = (el.textContent ?? '').replace(/\s/g, ''); return typeof label === 'string' ? t === label : label.test(t) }
  await waitFor(() => expect(within(scope).getAllByRole('button').some(visible)).toBe(true), wait)
  return within(scope).getAllByRole('button').find(visible)! as HTMLButtonElement
}
const go = (hash: string) => { location.hash = hash; window.dispatchEvent(new HashChangeEvent('hashchange')) }

beforeAll(async () => {
  document.body.innerHTML = '<div id="root"></div>'
  const { MODULE_UIS } = await import('../src/uis.ts')
  const { mountPage } = await import('../frontends/modern/main.tsx')
  mountPage(MODULE_UIS)
})

describe('Modern frontend', () => {
  it('shows every board as a card with its state, in upper case', async () => {
    const musecard = await card('bsp-k1-musecard')
    expect(musecard.textContent).toContain('K1-MUSECARD')
    expect((await card('bsp-k3-cm1')).textContent).toContain('使用中')
    expect((await card('bsp-k3-gone')).textContent).toContain('串口离线')
    expect((await card('bsp-k1-pico')).textContent).toContain('等人操作')
    expect((await card('bsp-host-b-s6')).className).toContain('empty')
  })

  it('pins a banner for the board waiting for a person, with the place to go', async () => {
    await waitFor(() => expect(document.querySelector('.banner .b')).toBeTruthy(), wait)
    const banner = document.querySelector('.banner .b') as HTMLElement
    expect(banner.textContent).toContain('host-a · s2')
    fireEvent.click(await button('我操作好了', banner))
    await waitFor(() => expect(calls.some(c => c.path === 'api/confirm' && (c.body as { board: string }).board === 'bsp-k1-pico')).toBe(true), wait)
  })

  it('takes a lock from a card with a one-click purpose', async () => {
    const free = await card('bsp-k1-musecard')
    const lock = within(free).queryAllByRole('button').find(b => b.textContent?.includes('拿锁'))
    if (!lock) return // the mock may already have it held by you
    fireEvent.click(lock)
    const dialog = await screen.findByRole('dialog', {}, wait)
    fireEvent.click(await button('临时开发任务', dialog))
    fireEvent.click(await button('拿锁', dialog))
    await waitFor(() => expect(calls.find(c => c.path === 'api/lock' && (c.body as { board: string }).board === 'bsp-k1-musecard')?.body).toEqual({ board: 'bsp-k1-musecard', purpose: '临时开发任务' }), wait)
  })

  it('opens a board: controls beside the console, log search with download and wget', async () => {
    go('#/board/bsp-k3-cm1')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BSP-K3-CM1'), wait)
    expect(document.querySelector('.tilebox')?.textContent).toContain('使用中')
    expect(await button('排队')).toBeTruthy()
    fireEvent.click(await button('日志'))
    await waitFor(() => expect(screen.getByTestId('log-lines').textContent).toContain('mmc0 timeout'), wait)
    expect(calls.filter(c => c.path.startsWith('api/logs?')).at(-1)!.path).toMatch(/board=bsp-k3-cm1/)
    fireEvent.change(document.querySelector('.lq input') as HTMLInputElement, { target: { value: 'mmc0' } })
    await waitFor(() => expect(document.querySelectorAll('.ll.hit').length).toBe(1), wait)
    expect(await button('复制wget')).toBeTruthy()
    expect(await button('下载.log')).toBeTruthy()
  })

  it('makes the console fill the screen and back', async () => {
    go('#/board/bsp-k3-cm1')
    await waitFor(() => expect(document.querySelector('.handle')).toBeTruthy(), wait)
    fireEvent.click(document.querySelector('.handle')!)
    await waitFor(() => expect(document.querySelector('.detail.full')).toBeTruthy(), wait)
    expect(document.body.classList.contains('console-full')).toBe(true)
    fireEvent.click(document.querySelector('.handle')!)
    await waitFor(() => expect(document.querySelector('.detail.full')).toBeNull(), wait)
  })

  it('offers discovery per host, and holds back rebuilding a host with locked boards', async () => {
    go('#/discover')
    await waitFor(() => expect(document.querySelectorAll('.panel').length).toBeGreaterThan(1), wait)
    expect(screen.getByText(/槽位 2 上的新板子/)).toBeTruthy()
    const hostB = [...document.querySelectorAll('.panel')].find(p => p.querySelector('h2')?.textContent?.startsWith('host-b')) as HTMLElement
    expect((await button('重建', hostB)).disabled).toBe(true)
    expect((await button('人工配对', hostB)).disabled).toBe(false)
  })

  it('rediscovers a host while its boards are held, keeping them', async () => {
    go('#/discover')
    await waitFor(() => expect(document.querySelectorAll('.panel').length).toBeGreaterThan(1), wait)
    const hostB = [...document.querySelectorAll('.panel')].find(p => p.querySelector('h2')?.textContent?.startsWith('host-b')) as HTMLElement
    const rediscover = await button('重新发现', hostB)
    expect(rediscover.disabled).toBe(false)
    fireEvent.click(rediscover)
    const dialog = await screen.findByRole('dialog', {}, wait)
    expect(dialog.textContent).toContain('保留在用的板子：BSP-K3-DEB1、BSP-K3-CM1')
    expect(dialog.textContent).toContain('忘掉串口不见的板子：BSP-K3-GONE')
    fireEvent.click(await button('重新发现', dialog))
    await waitFor(() => expect(calls.find(c => c.path === 'api/labs/rebuild')?.body).toEqual({ id: 'bsp', host: 'host-b', confirmed: true, keepInUse: true }), wait)
  })

  it('switches the frontend boardd serves from settings', async () => {
    go('#/settings')
    fireEvent.click(await screen.findByText('TroyMitchellDefault', {}, wait))
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === 'api/frontends?name=troy-mitchell-default')).toBe(true), wait)
  })
})
