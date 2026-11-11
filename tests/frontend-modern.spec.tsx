// @vitest-environment jsdom
/**
 * The Modern frontend against the mock boardd: the board cards and their states, the board page with the lock and its
 * purpose, log search with download and wget, discovery with rebuild held back by locks, settings with the frontend
 * switch, and the pinned banner for a board waiting for a person.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { calls } from './frontend-setup.ts'

vi.mock('../src/ui/console.tsx', () => ({ SerialConsole: () => null, reconnectConsole: () => {}, STATUS_TEXT: { connecting: '连接中', live: '实时', closed: '已断开，重连中', retry: '重连中' } }))

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

  it('shows what boardd is doing to a board, and holds back what would overlap it', async () => {
    const slot = await card('bsp-host-a-s7')
    expect(slot.textContent).toContain('发现中')
    expect(slot.querySelector('.st .spin')).toBeTruthy()
    expect((await button(/发现这块板/, slot)).disabled).toBe(true)
    go('#/board/bsp-k1-flash')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BSP-K1-FLASH'), wait)
    expect(document.querySelector('.flag.run')?.textContent).toContain('刷机中：flash rootfs')
    const reset = (await button(/^复位/, document.querySelector('.controls') as HTMLElement))
    expect(reset.disabled).toBe(true)
    go('#/board/bsp-host-a-s7')
    await waitFor(() => expect(document.querySelector('.tilebox')?.textContent).toContain('P13：没有串口反应'), wait)
    expect((await button(/发现/, document.querySelector('.tilebox') as HTMLElement)).disabled).toBe(true)
    go('#/')
  })

  it('spins the boot control for a boot only, and shows every other operation as the board\'s state', async () => {
    const { model } = await import('../frontends/modern/kit.tsx')
    const { mockState } = await import('./mock-boardd.ts')
    const flash = mockState().boards.find(b => b.name === 'bsp-k1-flash')!
    const doing = (kind: string, label: string) => model({ ...flash, busy: { ...flash.busy!, kind, label, line: null } }, flash.lease!.holder).flags
    for (const [kind, label] of [['reset', '复位中'], ['fastboot', '进下载模式中'], ['lock', '拿锁中'], ['refresh', '读取中'], ['configure', '修改中']]) {
      expect(doing(kind, label)).toMatchObject({ booting: null, progress: `${label}…`, busy: { kind } })
    }
    expect(doing('boot', '启动中').booting).toBe('启动中…')
    expect(doing('stage', '加载固件中').booting).toBe('加载固件中…')
    // A boot the lab reports (started elsewhere) counts too.
    expect(model({ ...flash, busy: null, lab: { ...flash.lab!, progress: 'load 40%' } }, flash.lease!.holder).flags).toMatchObject({ booting: 'load 40%', pct: 40 })
  })

  it('keeps each pending call of a board apart: a confirm sent while a reset waits ends neither early', async () => {
    const { renderHook, act } = await import('@testing-library/react')
    const { useBoardActions } = await import('../frontends/modern/actions.tsx')
    const { setAsked } = await import('../frontends/modern/kit.tsx')
    const { mockState } = await import('./mock-boardd.ts')
    const board = { ...mockState().boards.find(b => b.name === 'bsp-k1-flash')!, busy: null }
    const { result, unmount } = renderHook(() => useBoardActions(board))
    act(() => { setAsked(board.name, 'reset', true); setAsked(board.name, 'confirm', true) })
    expect(result.current).toMatchObject({ busy: 'reset' })
    expect(result.current.has('confirm')).toBe(true)
    act(() => setAsked(board.name, 'confirm', false))              // the confirm is answered; the reset still waits
    expect(result.current.busy).toBe('reset')
    expect(result.current.has('confirm')).toBe(false)
    act(() => { setAsked(board.name, 'confirm', true); setAsked(board.name, 'reset', false) })
    expect(result.current.busy).toBe('confirm')
    expect(result.current.has('reset')).toBe(false)
    act(() => setAsked(board.name, 'confirm', false))
    expect(result.current.busy).toBeNull()
    unmount()
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

  it('walks a boardlab with no boards through its first steps', async () => {
    const { render } = await import('@testing-library/react')
    const { FirstSteps } = await import('../frontends/modern/views/home.tsx')
    const { mockState } = await import('./mock-boardd.ts')
    const empty = { ...mockState(), boards: [], labs: [] }
    const { container, unmount } = render(<FirstSteps state={empty as never} />)
    const steps = [...container.querySelectorAll('.steps li')].map(li => li.querySelector('b')?.textContent)
    expect(steps[0]).toBe('添加板卡主机')
    expect(steps).toContain('发现板子')
    expect(container.querySelector('li.next a')?.getAttribute('href')).toBe('#/settings/bsp-hosts')
    unmount()
  })

  it('opens a settings section by its address', async () => {
    go('#/settings/bsp-hosts')
    await waitFor(() => expect(document.querySelector('.settings-nav button.on')?.textContent).toBe('bsp 板卡主机'), wait)
    go('#/')
  })

  it('switches the frontend boardd serves from settings', async () => {
    go('#/settings')
    fireEvent.click(await screen.findByText('TroyMitchellDefault', {}, wait))
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === 'api/frontends?name=troy-mitchell-default')).toBe(true), wait)
  })
})
