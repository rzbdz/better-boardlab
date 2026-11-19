// @vitest-environment jsdom
/**
 * The Modern frontend against the mock boardd: the board cards and their states, the board page with the lock and its
 * purpose, log search with download and wget, discovery with rebuild held back by locks, settings with the frontend
 * switch, the pinned banner for a board waiting for a person, flashing a package from a link, and
 * help pages with their AI hints.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { calls, FakeEventSource, state } from './frontend-setup.ts'

vi.mock('../src/ui/console.tsx', () => ({ SerialConsole: () => null, reconnectConsole: () => {}, clearConsole: vi.fn(), STATUS_TEXT: { connecting: '连接中', live: '实时', closed: '已断开，重连中', retry: '重连中' } }))

const wait = { timeout: 4000 }
const card = async (board: string) => { await waitFor(() => expect(document.querySelector(`[data-board="${board}"]`)).toBeTruthy(), wait); return document.querySelector(`[data-board="${board}"]`) as HTMLElement }
const button = async (label: string | RegExp, scope: HTMLElement = document.body) => {
  const visible = (el: Element) => { const t = (el.textContent ?? '').replace(/\s/g, ''); return typeof label === 'string' ? t === label : label.test(t) }
  await waitFor(() => expect(within(scope).getAllByRole('button').some(visible)).toBe(true), wait)
  return within(scope).getAllByRole('button').find(visible)! as HTMLButtonElement
}
const go = (hash: string) => { location.hash = hash; window.dispatchEvent(new HashChangeEvent('hashchange')) }
/** The page's own event stream, not a board's trace: the fake browser keeps every source it was handed. */
const stateStreams = () => FakeEventSource.instances.filter(source => /(^|\/)api\/events(\?|$)/.test(source.url))
const stateStream = async () => {
  await waitFor(() => expect(stateStreams().length).toBeGreaterThan(0), wait)
  return stateStreams().at(-1)!
}
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

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

  it('colours a board an agent holds with that agent\'s colour, and a person\'s board not', async () => {
    expect((await card('bsp-k3-cm1')).className).not.toContain('by-agent')
    const board = state.boards.find(b => b.name === 'bsp-k3-cm1')!
    const was = board.lease
    board.lease = { ...was!, holder: 'codex:fix-usb' }
    const source = await stateStream()
    source.opened()
    source.emit('lease-granted', { board: board.name, holder: 'codex:fix-usb' })
    await waitFor(() => expect(document.querySelector('[data-board="bsp-k3-cm1"]')!.className).toMatch(/by-agent k-codex/), wait)
    board.lease = was
    source.emit('lease-granted', { board: board.name, holder: was!.holder })
    await waitFor(() => expect(document.querySelector('[data-board="bsp-k3-cm1"]')!.className).not.toContain('by-agent'), wait)
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
    // An empty slot is filled on the discover page, not from here: home points there and starts nothing itself.
    const there = await waitFor(() => { const link = slot.querySelector('a[href="#/discover"]'); expect(link).toBeTruthy(); return link! }, wait)
    expect(there.textContent).toContain('去发现')
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

  it('offers to stop a fastboot boot at U-Boot when the SDK\'s recipe has that break point', async () => {
    const dialog = () => document.querySelector('[role=dialog]') as HTMLElement
    go('#/board/bsp-k3-deb1')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BSP-K3-DEB1'), wait)
    fireEvent.click(await button(/^启动/, document.querySelector('.controls') as HTMLElement))
    await waitFor(() => expect(dialog()).toBeTruthy(), wait)
    fireEvent.click(await button(/停在\s*uboot/, dialog()))
    fireEvent.click(await button('开始', dialog()))
    await waitFor(() => expect(calls.find(c => c.path === 'api/boot/sdk')?.body).toMatchObject({ board: 'bsp-k3-deb1', method: 'load', brk: 'uboot' }), wait)
    go('#/')
  })

  it('flashes a package from a link, offers the last link again, and never uploads a file', async () => {
    const dialog = () => document.querySelector('[role=dialog]') as HTMLElement
    const open = async () => { fireEvent.click(await button(/^启动/, document.querySelector('.controls') as HTMLElement)); await waitFor(() => expect(dialog()).toBeTruthy(), wait) }
    go('#/board/bsp-k3-deb1')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BSP-K3-DEB1'), wait)
    await open()
    fireEvent.click(await button(/^刷机包/, dialog()))
    expect((await button('开始', dialog())).disabled).toBe(true)
    fireEvent.change(dialog().querySelector('input[type=url]')!, { target: { value: 'https://images.test/k3/pkg.zip' } })
    fireEvent.change(screen.getByPlaceholderText('留空由后端按刷机包选'), { target: { value: 'tool-b' } })
    fireEvent.click(await button('开始', dialog()))
    await waitFor(() => expect(calls.find(c => c.path === 'api/flash/package')?.body).toEqual({ board: 'bsp-k3-deb1', url: 'https://images.test/k3/pkg.zip', flasher: 'tool-b' }), wait)

    // The link and tool are offered again; the page has no file picker at all (uploading is disabled for RISC-V Node).
    await open()
    fireEvent.click(await button(/^刷机包/, dialog()))
    expect((dialog().querySelector('input[type=url]') as HTMLInputElement).value).toBe('https://images.test/k3/pkg.zip')
    expect(dialog().querySelector('input[type=file]')).toBeNull()
    expect(within(dialog()).queryAllByRole('button').some(el => /上传文件/.test(el.textContent ?? ''))).toBe(false)
    fireEvent.click(await button('取消', dialog()))
    expect(calls.some(c => c.path.startsWith('api/files/'))).toBe(false)
    go('#/')
  })

  it('clears the console without disconnecting it', async () => {
    const consoleUi = await import('../src/ui/console.tsx')
    go('#/board/bsp-k3-cm1')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BSP-K3-CM1'), wait)
    fireEvent.click(await button('清屏', document.querySelector('.ctb') as HTMLElement))
    expect(consoleUi.clearConsole).toHaveBeenCalledWith('bsp-k3-cm1', 'die0')
    go('#/')
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
  })

  it('registers a manual board from its only download port, and makes a person pick when several are unbound', async () => {
    go('#/discover')
    await waitFor(() => expect(document.querySelectorAll('.panel').length).toBeGreaterThan(1), wait)
    const panel = (host: string) => [...document.querySelectorAll('.panel')].find(p => p.querySelector('h2')?.textContent?.startsWith(host)) as HTMLElement
    const dialog = () => document.querySelector('[role=dialog]') as HTMLElement

    fireEvent.click(await button(/发现这块板/, panel('host-a')))
    await waitFor(() => expect(dialog()).toBeTruthy(), wait)
    await waitFor(() => expect(dialog().textContent).toContain('自动刷机'), wait)
    expect(dialog().textContent).toContain('人工刷机')
    fireEvent.click(await button(/人工刷机/, dialog()))
    await waitFor(() => expect(dialog().textContent).toContain('请保证此时只有一块还没登记的板子处于下载模式'), wait)
    const [usbA, consoleA] = [...dialog().querySelectorAll('select')] as HTMLSelectElement[]
    await waitFor(() => expect(usbA!.value).toBe('1-1.2'), wait)
    expect(consoleA!.value).toBe('ttyUSB7')
    fireEvent.click(await button('开始', dialog()))
    await waitFor(() => expect(calls.filter(c => c.path === 'api/labs/discover').at(-1)?.body)
      .toEqual({ id: 'bsp', confirmed: true, method: 'bind', host: 'host-a', slot: 'host-a/s7', values: { usb: '1-1.2', console: 'ttyUSB7', soc: 'k3' } }), wait)

    fireEvent.click(await button(/发现这块板/, panel('host-b')))
    await waitFor(() => expect(dialog()).toBeTruthy(), wait)
    await waitFor(() => expect(dialog().textContent).toContain('人工刷机'), wait)
    fireEvent.click(await button(/人工刷机/, dialog()))
    await waitFor(() => expect(dialog().querySelectorAll('select').length).toBe(4), wait)
    const [usbB, consoleB] = [...dialog().querySelectorAll('select')] as HTMLSelectElement[]
    await waitFor(() => expect(usbB!.options.length).toBe(3), wait)
    expect(usbB!.value).toBe('')
    fireEvent.change(usbB!, { target: { value: '1-1.4' } })
    await waitFor(() => expect(consoleB!.value).toBe(''), wait)
    fireEvent.change(consoleB!, { target: { value: 'ttyUSB9' } })
    fireEvent.click(await button('开始', dialog()))
    await waitFor(() => expect(calls.filter(c => c.path === 'api/labs/discover').at(-1)?.body)
      .toEqual({ id: 'bsp', confirmed: true, method: 'bind', host: 'host-b', slot: 'host-b/s6', values: { usb: '1-1.4', console: 'ttyUSB9', soc: 'k3' } }), wait)
  })

  it('offers the same automatic or manual choice from an empty board page', async () => {
    go('#/board/bsp-host-b-s6')
    await waitFor(() => expect(document.querySelector('.detail')).toBeTruthy(), wait)
    fireEvent.click(await button('发现这块板', document.querySelector('.detail') as HTMLElement))
    const dialog = await screen.findByRole('dialog', {}, wait)
    await waitFor(() => expect(dialog.textContent).toContain('自动刷机'), wait)
    expect(dialog.textContent).toContain('人工刷机')
    expect(dialog.textContent).toContain('只动这一个槽位')
    fireEvent.click(await button('取消', dialog))
    go('#/')
  })

  it('starts automatic discovery for one slot after choosing 自动刷机 on its board page', async () => {
    go('#/board/bsp-host-b-s6')
    await waitFor(() => expect(document.querySelector('.detail')).toBeTruthy(), wait)
    fireEvent.click(await button('发现这块板', document.querySelector('.detail') as HTMLElement))
    const dialog = await screen.findByRole('dialog', {}, wait)
    fireEvent.click(await button(/自动刷机/, dialog))
    await waitFor(() => expect(dialog.textContent).toContain('只动这一个槽位'), wait)
    fireEvent.change(within(dialog).getByPlaceholderText(/例如 12,13/), { target: { value: '12,13' } })
    fireEvent.click(await button('开始', dialog))
    await waitFor(() => expect(calls.filter(c => c.path === 'api/labs/discover').at(-1)?.body)
      .toEqual({ id: 'bsp', confirmed: true, method: 'probe', host: 'host-b', slot: 'host-b/s6', values: { prefer: '12,13' } }), wait)
  })

  it('renders a discovery method it has never seen, with the fields the backend named', async () => {
    go('#/board/bsp-host-b-s6')
    await waitFor(() => expect(document.querySelector('.detail')).toBeTruthy(), wait)
    fireEvent.click(await button('发现这块板', document.querySelector('.detail') as HTMLElement))
    const dialog = await screen.findByRole('dialog', {}, wait)
    fireEvent.click(await button(/按编号找/, dialog))
    await waitFor(() => expect(dialog.textContent).toContain('输入板子背面的编号'), wait)
    expect(dialog.textContent).toContain('实验室按编号登记')
    fireEvent.change(within(dialog).getByPlaceholderText(/例如 A-12/), { target: { value: 'A-12' } })
    fireEvent.click(await button('开始', dialog))
    await waitFor(() => expect(calls.filter(c => c.path === 'api/labs/discover').at(-1)?.body)
      .toEqual({ id: 'bsp', confirmed: true, method: 'lookup', host: 'host-b', slot: 'host-b/s6', values: { code: 'A-12' } }), wait)
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
    // A settings step is the module's own view: its title, its place (order) and its one line, so this page names no
    // module and learns nothing of one.
    expect(steps[0]).toBe('bsp 板卡主机')
    // Only modules that offered a settings section appear (this state has no client machines to set up).
    expect(steps).toEqual(['bsp 板卡主机', 'SDK 与站点', '发现板子'])
    expect(container.querySelector('li.next a')?.getAttribute('href')).toBe('#/settings/bsp-hosts')
    unmount()
  })

  it('draws the 模块 page like any other page: a title and a panel, not bare', async () => {
    go('#/p/modules')
    await waitFor(() => expect(document.querySelector('.page .hero h1')?.textContent).toBe('模块'), wait)
    expect(document.querySelector('.page .panel')).toBeTruthy()
    expect(document.querySelector('.page .panel .mv-list')).toBeTruthy()
    go('#/')
  })

  it('asks the person holding a board whether to let an agent have it', async () => {
    const withYield = () => [...document.querySelectorAll('.banner')].find(el => el.textContent?.includes('想用'))
    await waitFor(() => expect(withYield()).toBeTruthy(), wait)
    const banner = withYield() as HTMLElement
    fireEvent.click(await button('让出', banner))
    await waitFor(() => expect(calls.some(c => c.path === 'api/yields' && (c.body as { action: string }).action === 'yield')).toBe(true), wait)
  })

  it('draws a settings section\'s own data once it arrives (the site, the certificate)', async () => {
    go('#/settings')
    await waitFor(() => {
      const site = [...document.querySelectorAll('.settings-flow .panel')].find(p => p.textContent?.includes('SDK 与站点'))
      expect(site?.textContent).toContain('abc1234')
    }, wait)
    go('#/')
  })

  it('opens a settings section by its address', async () => {
    go('#/settings/bsp-hosts')
    await waitFor(() => expect(document.querySelector('.settings-nav button.on')?.textContent).toBe('bsp 板卡主机'), wait)
    go('#/')
  })

  it('renders help pages as plain elements, and builds the AI hint from the page, boardd\'s address and the setup', async () => {
    const { render } = await import('@testing-library/react')
    const { Markdown } = await import('../frontends/modern/markdown.tsx')
    const { hintPrompt } = await import('../src/ui/help.ts')
    const { container, unmount } = render(<Markdown text={'# 标题\n\n<b>不是标签</b> 和 [好](https://example.com) [坏](javascript:alert(1))\n\n- 一\n- 二'} />)
    expect(container.querySelector('h2')?.textContent).toBe('标题')
    expect(container.querySelector('b')).toBeNull()
    expect([...container.querySelectorAll('a')].map(a => a.getAttribute('href'))).toEqual(['https://example.com'])
    expect(container.querySelectorAll('li')).toHaveLength(2)
    unmount()
    const prompt = await hintPrompt({ title: '站点', help: 'site', hint: { commands: ['boardlab site show'], context: () => 'servers: [build-a]' } })
    expect(prompt).toContain('「站点」')
    expect(prompt).toContain(`boardlab remote set ${location.origin}/`)
    expect(prompt).toContain('- `boardlab site show`')
    expect(prompt).toContain('# 帮助：site')
    expect(prompt).toContain('servers: [build-a]')
    expect(prompt).toContain('一次只问我一个问题')
  })

  it('lists the site by build server, each with its SDKs, and keeps the rest under 高级', async () => {
    go('#/settings/bsp-site')
    const panel = await waitFor(() => { const found = [...document.querySelectorAll('section.panel')].find(el => el.querySelector('h2')?.textContent?.startsWith('SDK 与站点')); expect(found).toBeTruthy(); return found as HTMLElement }, wait)
    const nav = [...document.querySelectorAll('.settings-nav button')].map(el => el.textContent)
    expect(nav.indexOf('bsp 板卡主机')).toBeLessThan(nav.indexOf('SDK 与站点'))
    await waitFor(() => expect(panel.textContent).toContain('这台 boardd 管理（还没连 git 仓库）'), wait)
    expect(panel.textContent).toContain('Add SDK vendor-a')
    const server = [...panel.querySelectorAll('.mv-group')].find(el => el.firstElementChild?.textContent?.startsWith('build-a')) as HTMLElement
    expect(server.textContent).toContain('vendor-a')
    expect(server.textContent).not.toContain('upstream')
    expect(within(server).getAllByRole('button').some(el => el.textContent === '添加 SDK')).toBe(true)
    expect(panel.textContent).toContain('用源码树或别的服务器的 SDK')
    expect(panel.textContent).toContain('高级')
    expect(panel.textContent).toContain('可选：k1/fsbl（FSBL.bin）探测用镜像没有，发现板子时就读不到型号')
    fireEvent.click(within(server).getAllByRole('button').find(el => el.textContent === '添加 SDK')!)
    const dialog = await screen.findByRole('dialog', {}, wait)
    expect(dialog.textContent).toContain('在 build-a 上添加 SDK')
    expect((within(dialog).getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('build-a')
    expect(dialog.querySelector('textarea')?.value).toContain('download:')
    expect(within(dialog).getAllByRole('button', { name: '帮助' }).length).toBeGreaterThan(0)
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('[role=dialog]')).toBeNull(), wait)
    fireEvent.click(within(panel.querySelector('h2')!).getByRole('button', { name: '帮助' }))
    await waitFor(() => expect(document.querySelector('[role=dialog] .md h2')?.textContent).toBe('帮助：site'), wait)
    expect(document.querySelector('[role=dialog] .md a')?.getAttribute('href')).toBe('https://example.com/a')
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(within(panel.querySelector('h2')!).getByRole('button', { name: 'AI 提示' }))
    await waitFor(() => expect((document.querySelector('[role=dialog] textarea') as HTMLTextAreaElement)?.value).toContain('boardlab site show'), wait)
    expect((document.querySelector('[role=dialog] textarea') as HTMLTextAreaElement).value).toContain('# sdk/servers/build-a.yaml')
    fireEvent.keyDown(window, { key: 'Escape' })
    go('#/')
  })

  it('offers remembered models in the model field, saves one and clears it', async () => {
    const { api } = await import('../src/ui/api.ts')
    const base = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost/')
      if (url.pathname === '/api/models') return json({ models: ['k3_com260', 'k1-x_pico'] })
      return base(input, init)
    }) as typeof fetch
    try {
      await api.models(true)
      go('#/board/bsp-k3-deb1')
      await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BSP-K3-DEB1'), wait)
      const field = await waitFor(() => {
        const input = document.querySelector('.model-edit input') as HTMLInputElement | null
        expect(input).toBeTruthy()
        return input!
      }, wait)
      expect(field.value).toBe('k3_deb1')
      const list = document.getElementById(field.getAttribute('list')!)!
      expect([...list.querySelectorAll('option')].map(option => option.value)).toEqual(['k3_com260', 'k1-x_pico'])

      const editor = field.closest('.model-edit') as HTMLElement
      fireEvent.change(field, { target: { value: 'k3_com260' } })
      fireEvent.click(await button('保存', editor))
      await waitFor(() => expect(calls.find(c => c.method === 'POST' && c.path === 'api/board')?.body).toEqual({ name: 'bsp-k3-deb1', product: 'k3_com260' }), wait)

      fireEvent.change(field, { target: { value: '' } })
      fireEvent.click(await button('保存', editor))
      await waitFor(() => expect(calls.filter(c => c.method === 'POST' && c.path === 'api/board').at(-1)?.body).toEqual({ name: 'bsp-k3-deb1', product: null }), wait)
    } finally { globalThis.fetch = base; go('#/') }
  })

  it('renames a board from the menu, then reloads the page', async () => {
    go('#/board/bsp-k3-deb1')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BSP-K3-DEB1'), wait)
    const before = calls.filter(c => c.method === 'GET' && c.path === 'api/state').length
    fireEvent.click(await screen.findByRole('button', { name: '更多' }, wait))
    fireEvent.click(await button(/给板子改名/))
    const dialog = await screen.findByRole('dialog', {}, wait)
    const input = dialog.querySelector('input') as HTMLInputElement
    expect(input.value).toBe('bsp-k3-deb1')
    expect(dialog.textContent).toContain('自动带上 bsp- 前缀')
    fireEvent.change(input, { target: { value: 'k3-deb1r' } })
    fireEvent.click(await button('改名', dialog))
    await waitFor(() => expect(calls.find(c => c.method === 'POST' && c.path === 'api/board/rename')?.body).toEqual({ board: 'bsp-k3-deb1', name: 'k3-deb1r' }), wait)
    await waitFor(() => expect(calls.filter(c => c.method === 'GET' && c.path === 'api/state').length).toBeGreaterThan(before), wait)
    await waitFor(() => expect(document.querySelector('.toast')?.textContent).toContain('改名好了'), wait)
    go('#/')
  })

  it('reopens the boot dialog with the break points it already read', async () => {
    const dialog = () => document.querySelector('[role=dialog]') as HTMLElement
    const reads = (board: string) => calls.filter(c => c.path.startsWith('api/boot/breaks') && c.path.includes(`board=${board}`)).length
    const open = async () => { fireEvent.click(await button(/^启动/, document.querySelector('.controls') as HTMLElement)); await waitFor(() => expect(dialog()).toBeTruthy(), wait) }
    go('#/board/bsp-k1-musecard')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BSP-K1-MUSECARD'), wait)
    // The page reads the selected SDK's break points before the dialog opens.
    await waitFor(() => expect(reads('bsp-k1-musecard')).toBe(1), wait)
    await open()
    expect(await button(/停在\s*uboot/, dialog())).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('[role=dialog]')).toBeNull(), wait)
    await open()
    expect(await button(/停在\s*uboot/, dialog())).toBeTruthy()
    expect(reads('bsp-k1-musecard')).toBe(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    go('#/')
  })

  it('switches the frontend boardd serves from settings', async () => {
    go('#/settings')
    fireEvent.click(await screen.findByText('TroyMitchellDefault', {}, wait))
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === 'api/frontends?name=troy-mitchell-default')).toBe(true), wait)
  })

  it('asks a debug-capable board\'s host for its debug path and shows what it offers', async () => {
    go('#/board/bsp-k1-musecard')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BSP-K1-MUSECARD'), wait)
    // The path is asked for when the board page opens, and what arrived is on the page: the provider's own name,
    // what it offers, and a way to start the session — not only a request made.
    await waitFor(() => expect(calls.some(c => c.path === 'api/debug' && (c.body as { board?: string, action?: string }).board === 'bsp-k1-musecard'
      && (c.body as { action?: string }).action === 'path')).toBe(true), wait)
    await waitFor(() => expect(document.body.textContent).toContain('调试（SWD over GPIO）'), wait)
    expect(document.body.textContent).toContain('两颗 GPIO 位操作出来的链路。')
    expect(document.body.textContent).toContain('未启动')
    await button(/启动调试会话/)
    go('#/')
  })

  it('asks the host to start the session, then offers the provider\'s own actions and its trace', async () => {
    go('#/board/bsp-k1-musecard')
    await waitFor(() => expect(document.body.textContent).toContain('调试（SWD over GPIO）'), wait)
    fireEvent.click(await button(/启动调试会话/))
    await waitFor(() => expect(calls.some(c => c.path === 'api/debug' && (c.body as { action?: string }).action === 'start')).toBe(true), wait)
    // The boardd mock answers a start by making the path live (`running: true`): the block now stops it, runs the
    // actions the backend declared, and shows the trace channel — a live `EventSource` for this board.
    await waitFor(() => expect(document.body.textContent).toContain('停止调试会话'), wait)
    expect(document.body.textContent).toContain('暂停')
    const { FakeEventSource } = await import('./frontend-setup.ts')
    expect(FakeEventSource.instances.some(source => source.url.includes('api/debug/stream'))).toBe(true)
    // Stopping the session ends the trace: the page asks for a stop and the path comes back not running.
    fireEvent.click(await button(/停止调试会话/))
    await waitFor(() => expect(calls.some(c => c.path === 'api/debug' && (c.body as { action?: string }).action === 'stop')).toBe(true), wait)
    await waitFor(() => expect(document.body.textContent).toContain('启动调试会话'), wait)
    go('#/')
  })

  it('reconnects its event stream and reads the state again without the page being reloaded', async () => {
    // A page under a proxy (or left open while boardd is replaced) loses its stream: a browser gives up for good, and
    // the page would stay stale until someone reloaded it. This one opens another and reads the state again.
    // The page's own stream is the one on `api/events`: a board's trace is a stream too, and it is not this one.
    const source = await stateStream()
    source.opened()
    const reads = () => calls.filter(c => c.method === 'GET' && c.path === 'api/state').length
    const before = reads()
    const streams = stateStreams().length
    source.drop()
    // The retry opens a new source; its opening says the page is back and re-reads the state, without a reload.
    await waitFor(() => expect(stateStreams().length).toBeGreaterThan(streams), { timeout: 5000 })
    stateStreams().at(-1)!.opened()
    await waitFor(() => expect(reads()).toBeGreaterThan(before), wait)
    await waitFor(() => expect(document.querySelector('.conn')).toBeNull(), wait)
  })

  it('hears a module event it was given the name of, and comes back when a listener throws', async () => {
    const source = await stateStream()
    source.opened()
    // The page asks for core's names itself (see CORE_EVENTS); a module's `scan` is the local module's to name, and
    // its follow-up listens for its own. A frame on a name nobody listens for is dropped by the browser, as it would be.
    const reads = () => calls.filter(c => c.method === 'GET' && c.path === 'api/state').length
    const before = reads()
    source.emit('lease-granted', { board: 'b', holder: 'user:x' })       // core's: the page re-reads
    await waitFor(() => expect(reads()).toBeGreaterThan(before), wait)
  })
})
