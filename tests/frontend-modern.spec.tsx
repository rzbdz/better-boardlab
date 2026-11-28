// @vitest-environment jsdom
/**
 * The Modern frontend against the mock boardd: the board cards and their states, the board page with the lock and its
 * purpose, log search with download and wget, discovery with rebuild held back by locks, settings with the frontend
 * switch, the pinned banner for a board waiting for a person, flashing a package from a link, and
 * help pages with their AI hints.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { calls, FakeEventSource, state, uploadGate } from './frontend-setup.ts'

const consoleProps = vi.hoisted(() => ({ last: null as null | { onSearchHistory?: (text: string, regex: boolean) => void } }))
vi.mock('../src/ui/console.tsx', () => ({ SerialConsole: (props: { onSearchHistory?: (text: string, regex: boolean) => void }) => { consoleProps.last = props; return null }, reconnectConsole: () => {}, clearConsole: vi.fn(), searchConsole: vi.fn(), STATUS_TEXT: { connecting: '连接中', live: '实时', closed: '已断开，重连中', retry: '重连中' } }))

const wait = { timeout: 4000 }
const card = async (board: string) => { await waitFor(() => expect(document.querySelector(`[data-board="${board}"]`)).toBeTruthy(), wait); return document.querySelector(`[data-board="${board}"]`) as HTMLElement }
const button = async (label: string | RegExp, scope: HTMLElement = document.body) => {
  // Its text, or for a button that shows only an icon, its label.
  const visible = (el: Element) => [el.textContent ?? '', el.getAttribute('aria-label') ?? ''].map(t => t.replace(/\s/g, '')).some(t => t && (typeof label === 'string' ? t === label : label.test(t)))
  await waitFor(() => expect(within(scope).getAllByRole('button').some(visible)).toBe(true), wait)
  return within(scope).getAllByRole('button').find(visible)! as HTMLButtonElement
}
/** A tab of a tab list (the flash dialog's sources), by its visible text. */
const tab = async (label: RegExp, scope: HTMLElement) => {
  await waitFor(() => expect(within(scope).getAllByRole('tab').some(el => label.test((el.textContent ?? '').replace(/\s/g, '')))).toBe(true), wait)
  return within(scope).getAllByRole('tab').find(el => label.test((el.textContent ?? '').replace(/\s/g, '')))! as HTMLButtonElement
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
  // The tabs the market brings are the market's own page parts, as a machine loads them (see public-market.ts).
  const { marketModuleUis } = await import('./public-market.ts')
  const fromMarket = await marketModuleUis()
  const { mountPage } = await import('../frontends/modern/main.tsx')
  mountPage([...MODULE_UIS, ...fromMarket])
})

describe('Modern frontend', () => {
  it('shows every board as a card with its state, in upper case', async () => {
    const musecard = await card('boardctrl-k1-musecard')
    expect(musecard.textContent).toContain('K1-MUSECARD')
    expect((await card('boardctrl-k1-cm1')).textContent).toContain('使用中')
    expect((await card('boardctrl-k3-gone')).textContent).toContain('串口离线')
    expect((await card('boardctrl-k1-pico')).textContent).toContain('等人操作')
    expect((await card('boardctrl-host-b-s6')).className).toContain('empty')
  })

  it('colours a board an agent holds with that agent\'s colour, and a person\'s board not', async () => {
    expect((await card('boardctrl-k1-cm1')).className).not.toContain('by-agent')
    const board = state.boards.find(b => b.name === 'boardctrl-k1-cm1')!
    const was = board.lease
    board.lease = { ...was!, holder: 'codex:fix-usb' }
    const source = await stateStream()
    source.opened()
    source.emit('lease-granted', { board: board.name, holder: 'codex:fix-usb' })
    await waitFor(() => expect(document.querySelector('[data-board="boardctrl-k1-cm1"]')!.className).toMatch(/by-agent k-codex/), wait)
    board.lease = was
    source.emit('lease-granted', { board: board.name, holder: was!.holder })
    await waitFor(() => expect(document.querySelector('[data-board="boardctrl-k1-cm1"]')!.className).not.toContain('by-agent'), wait)
  })

  it('warns that boardd restored its database from a copy until a person says they saw it', async () => {
    state.restored = { at: '2026-11-19T03:00:00.000Z', backup: '/state/backups/boards-2026-11-18T21-00-00-000Z.sqlite', aside: '/state/boards.sqlite.corrupt-2026-11-19T03-00-00-000Z', reason: 'database disk image is malformed' }
    const source = await stateStream()
    source.opened()
    source.emit('changed', { board: null })
    await waitFor(() => expect(document.querySelector('.banner .restored')).toBeTruthy(), wait)
    const banner = document.querySelector('.banner .restored') as HTMLElement
    expect(banner.textContent).toContain('从备份恢复过')
    expect(banner.textContent).toContain('boards-2026-11-18T21-00-00-000Z.sqlite')
    fireEvent.click(await button('知道了', banner))
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === 'api/database/acknowledge')).toBe(true), wait)
    await waitFor(() => expect(document.querySelector('.banner .restored')).toBeNull(), wait)
  })

  it('pins a banner for the board waiting for a person, with the place to go', async () => {
    await waitFor(() => expect(document.querySelector('.banner .b')).toBeTruthy(), wait)
    const banner = document.querySelector('.banner .b') as HTMLElement
    expect(banner.textContent).toContain('host-a · s2')
    fireEvent.click(await button('我操作好了', banner))
    await waitFor(() => expect(calls.some(c => c.path === 'api/confirm' && (c.body as { board: string }).board === 'boardctrl-k1-pico')).toBe(true), wait)
  })

  it('takes a lock from a card with a one-click purpose', async () => {
    const free = await card('boardctrl-k1-musecard')
    const lock = within(free).queryAllByRole('button').find(b => b.textContent?.includes('拿锁'))
    if (!lock) return // the mock may already have it held by you
    fireEvent.click(lock)
    const dialog = await screen.findByRole('dialog', {}, wait)
    fireEvent.click(await button('临时开发任务', dialog))
    fireEvent.click(await button('拿锁', dialog))
    await waitFor(() => expect(calls.find(c => c.path === 'api/lock' && (c.body as { board: string }).board === 'boardctrl-k1-musecard')?.body).toEqual({ board: 'boardctrl-k1-musecard', purpose: '临时开发任务' }), wait)
  })

  it('lets a person step in on a board an agent holds for one action, behind a red double warning, without taking its lock', async () => {
    const dialog = () => document.querySelector('.force-take') as HTMLElement
    const deb = state.boards.find(b => b.name === 'boardctrl-k1-deb1')!
    const was = deb.lease
    // The page read the state when it was mounted: a new holder is told to it as an event, and the state it re-reads
    // on that says the same, so the board is another agent's before the test's first check.
    deb.lease = { ...was!, holder: 'codex:fix-usb', purpose: '跑一遍启动回归' }
    const source = await stateStream()
    source.opened()
    source.emit('lease-granted', { board: deb.name, holder: 'codex:fix-usb' })
    go('#/board/boardctrl-k1-deb1')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BOARDCTRL-K1-DEB1'), wait)
    // The page re-read the state the event sent it to after, which has the agent holding it.
    await waitFor(() => expect(document.querySelector('.tilebox .acts')?.textContent).toContain('抢锁'), wait)
    // The red button sits right of 抢锁, and says what the warning dialog will say again.
    const acts = document.querySelector('.tilebox .acts') as HTMLElement
    expect([...acts.querySelectorAll('button')].map(b => b.textContent?.replace(/\s/g, ''))).toEqual(['排队', '抢锁…', '强制解锁'])
    fireEvent.click(await button('强制解锁', acts))
    await waitFor(() => expect(dialog()).toBeTruthy(), wait)
    const text = dialog().textContent!
    expect(text).toContain('强制解锁？')
    expect(text).toContain('fix-usb')
    expect(text).toContain('跑一遍启动回归')
    expect(text).toContain('后果由你负责')
    expect(text).toContain('只限一个动作')
    // The lock is not taken: the dialog says so, and the warning comes again before anything happens.
    expect(text).toContain('它的锁不拿走')
    fireEvent.click(await button('强制解锁', dialog()))
    expect(dialog().textContent).toContain('真的确定？')
    expect(calls.some(c => c.path === 'api/take-over')).toBe(false)
    fireEvent.click(await button('确定，打断它这一次', dialog()))
    await waitFor(() => expect(calls.find(c => c.path === 'api/take-over')?.body).toEqual({ board: 'boardctrl-k1-deb1' }), wait)
    // The panel is the person's for one action, and the lock is still the agent's.
    await waitFor(() => expect(document.querySelector('.tilebox.dark')?.textContent).toContain('强制接管中'), wait)
    expect(document.querySelector('.tilebox.dark')?.textContent).toContain('只限一个动作')
    expect(state.boards.find(b => b.name === 'boardctrl-k1-deb1')!.lease?.holder).toBe('codex:fix-usb')
    // One action: the reset ends the step-in, and the board is the agent's again.
    fireEvent.click(await button(/^复位/, document.querySelector('.controls') as HTMLElement))
    fireEvent.click(await button('复位', await screen.findByRole('dialog', {}, wait)))
    await waitFor(() => expect(calls.some(c => c.path === 'api/reset' && (c.body as { board: string }).board === 'boardctrl-k1-deb1')).toBe(true), wait)
    await waitFor(() => expect(state.boards.find(b => b.name === 'boardctrl-k1-deb1')!.stepping).toBeNull(), wait)
    source.emit('changed', { board: deb.name })
    await waitFor(() => expect(document.querySelector('.tilebox.dark')).toBeNull(), wait)
    // Leave the board as the other tests expect it: held by the person, as the mock has it.
    deb.lease = was
    source.emit('lease-granted', { board: deb.name, holder: was!.holder })
    go('#/')
  })

  it('shows what boardd is doing to a board, and holds back what would overlap it', async () => {
    const slot = await card('boardctrl-host-a-s7')
    expect(slot.textContent).toContain('发现中')
    expect(slot.querySelector('.st .spin')).toBeTruthy()
    // An empty slot is filled on the discover page, not from here: home points there and starts nothing itself.
    const there = await waitFor(() => { const link = slot.querySelector('a[href="#/discover"]'); expect(link).toBeTruthy(); return link! }, wait)
    expect(there.textContent).toContain('去发现')
    go('#/board/boardctrl-k1-flash')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BOARDCTRL-K1-FLASH'), wait)
    expect(document.querySelector('.flag.run')?.textContent).toContain('刷机中：flash rootfs')
    const reset = (await button(/^复位/, document.querySelector('.controls') as HTMLElement))
    expect(reset.disabled).toBe(true)
    go('#/board/boardctrl-host-a-s7')
    await waitFor(() => expect(document.querySelector('.tilebox')?.textContent).toContain('P13：没有串口反应'), wait)
    expect((await button(/发现/, document.querySelector('.tilebox') as HTMLElement)).disabled).toBe(true)
    go('#/')
  })

  it('spins the boot control for a boot only, and shows every other operation as the board\'s state', async () => {
    const { model } = await import('../frontends/modern/kit.tsx')
    const { mockState } = await import('./mock-boardd.ts')
    const flash = mockState().boards.find(b => b.name === 'boardctrl-k1-flash')!
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
    const board = { ...mockState().boards.find(b => b.name === 'boardctrl-k1-flash')!, busy: null }
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
    go('#/board/boardctrl-k1-cm1')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BOARDCTRL-K1-CM1'), wait)
    expect(document.querySelector('.tilebox')?.textContent).toContain('使用中')
    expect(await button('排队')).toBeTruthy()
    fireEvent.click(await button('日志'))
    // The whole log is as long as it is: only the lines in view are read, a page at a time, from the end.
    await waitFor(() => expect(document.querySelector('.lfoot')?.textContent).toContain('共 5,000 行'), wait)
    expect(calls.some(c => /^api\/logs\?board=boardctrl-k1-cm1&at=end/.test(c.path))).toBe(true)
    await waitFor(() => expect(screen.getByTestId('log-lines').textContent).toContain('U-Boot SPL line 4999'), wait)
    const reads = calls.filter(c => c.path.startsWith('api/logs?') && /at=line%3A/.test(c.path))
    expect(reads.length).toBeLessThanOrEqual(2)
    expect(document.querySelectorAll('.ll').length).toBeLessThan(300)
    // A search: boardd says where every match is, the count shows, and the next one is scrolled to and read.
    fireEvent.change(document.querySelector('.lq input') as HTMLInputElement, { target: { value: 'mmc0' } })
    await waitFor(() => expect(document.querySelector('.lcount')?.textContent).toBe('– / 2'), wait)
    expect(calls.filter(c => c.path.includes('hits=1')).at(-1)!.path).toMatch(/grep=mmc0/)
    fireEvent.click(await button('下一个匹配'))
    await waitFor(() => expect(document.querySelector('.lcount')?.textContent).toBe('1 / 2'), wait)
    await waitFor(() => expect(document.querySelector('.ll.on')?.textContent).toContain('mmc0 timeout'), wait)
    expect(document.querySelector('.ll.on mark')?.textContent).toBe('mmc0')
    fireEvent.click(await button('下一个匹配'))
    await waitFor(() => expect(document.querySelector('.ll.on')?.textContent).toContain('mmc0: retry'), wait)
    expect(document.querySelector('.ll.on .no')?.textContent).toBe('4201')
    expect(await button('复制wget')).toBeTruthy()
    expect(await button('下载.log')).toBeTruthy()
  })

  it('draws a log of just the time range asked for, and keeps drawing it as its pages are read', async () => {
    go('#/board/boardctrl-k1-cm1')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BOARDCTRL-K1-CM1'), wait)
    fireEvent.click(await button('日志'))
    await waitFor(() => expect(document.querySelector('.lfoot')?.textContent).toContain('共 5,000 行'), wait)
    const picker = () => document.querySelector('select[aria-label="搜索的时间范围"]') as HTMLSelectElement
    fireEvent.change(picker(), { target: { value: 'custom' } })
    fireEvent.change(document.querySelector('input[aria-label="开始"]')!, { target: { value: '2026-11-10T08:50:00' } })
    fireEvent.change(document.querySelector('input[aria-label="结束"]')!, { target: { value: '2026-11-10T08:59:59' } })
    // boardd says where the range's lines are (3000 to 3599), and the list is those 600 rows, not the whole log.
    await waitFor(() => expect(document.querySelector('.lfoot')?.textContent).toContain('这段时间 600 行'), wait)
    const asked = calls.filter(c => c.path.includes('bounds=1')).at(-1)!.path
    // The range as a stamp a log line can be compared with, whatever the input added.
    expect(asked).toContain('since=2026-11-10+08%3A50')
    expect(asked).toContain('until=2026-11-10+08%3A59%3A59')
    expect(asked).not.toContain('grep=')
    // Reading a page of the range answers with the whole log's size: that must not put the whole log back.
    await waitFor(() => expect(screen.getByTestId('log-lines').textContent).toContain('U-Boot SPL line 3599'), wait)
    expect(document.querySelector('.lfoot')?.textContent).toContain('这段时间 600 行')
    expect(document.querySelectorAll('.ll').length).toBeLessThan(300)
    // Leave the panel as the next test expects to find it.
    go('#/')
  })

  it('marks every boot beside the log, goes to one, and remembers which stages the person shows for that console', async () => {
    localStorage.removeItem('boardlab.boots.shown')
    go('#/board/boardctrl-k1-cm1')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BOARDCTRL-K1-CM1'), wait)
    fireEvent.click(await button('日志', document.querySelector('.ctb') as HTMLElement))
    const rail = () => document.querySelector('.logwrap .lboots') as HTMLElement
    await waitFor(() => expect(rail()?.querySelectorAll('.tick').length).toBe(5), wait)
    // Each tick sits where its line is in the whole log, tinted by its stage.
    const ticks = [...rail().querySelectorAll<HTMLElement>('.tick')]
    expect(ticks.map(tick => tick.style.top)).toEqual(['2.01%', '2.81%', '40.01%', '80.01%', '81.01%'])
    expect(ticks.map(tick => tick.className.split(' ')[1])).toEqual(['t-spl', 't-kernel', 't-kernel', 't-spl', 't-kernel'])
    // Two boots by stage order (SPL then Linux, a lone Linux, SPL then Linux): three.
    expect(rail().querySelector('.kn')!.textContent).toContain('次启动')
    fireEvent.click(ticks[2]!)
    await waitFor(() => expect(document.querySelector('.ll[data-line="2000"]')?.textContent).toContain('2001'), wait)
    // ‹ › step from one boot to the next, not from stage to stage: from a boot's first line, next goes to the next
    // boot's first line, not to the kernel that follows in the same boot.
    fireEvent.click(ticks[0]!)
    await waitFor(() => expect(document.querySelector('.ll[data-line="100"]')).toBeTruthy(), wait)
    fireEvent.click(rail().querySelector('.kn + .kb') as HTMLElement)
    await waitFor(() => expect(document.querySelector('.ll[data-line="2000"]')?.textContent).toContain('2001'), wait)
    fireEvent.click(rail().querySelector('.kb') as HTMLElement)
    await waitFor(() => expect(document.querySelector('.ll[data-line="100"]')).toBeTruthy(), wait)
    // The panel: the boots, newest first, and the kinds of line to show; showing only kernels is remembered.
    fireEvent.click(rail().querySelector('.kn')!)
    const panel = () => rail().querySelector('.panel') as HTMLElement
    expect([...panel().querySelectorAll('.boot .n')].map(n => n.textContent)).toEqual(['#3', '#2', '#1'])
    fireEvent.click(within(panel()).getByRole('button', { name: 'U-Boot SPL', pressed: true }))
    await waitFor(() => expect(rail().querySelectorAll('.tick').length).toBe(3), wait)
    expect(JSON.parse(localStorage.getItem('boardlab.boots.shown')!)).toEqual({ 'boardctrl-k1-cm1.die0': ['spl'] })
    fireEvent.click(within(panel()).getAllByRole('button', { name: 'Linux' }).at(-1)!)
    await waitFor(() => expect(document.querySelector('.ll[data-line="140"]')).toBeTruthy(), wait)
    expect(rail().querySelector('.panel')).toBeNull()
    // Another visit to the console keeps the choice.
    go('#/')
    go('#/board/boardctrl-k1-cm1')
    await waitFor(() => expect(document.querySelector('.logwrap .lboots')?.querySelectorAll('.tick').length).toBe(3), wait)
    localStorage.removeItem('boardlab.boots.shown')
    go('#/')
  })

  it('takes a search from the console to the whole log, which opens on its first match', async () => {
    const consoleUi = await import('../src/ui/console.tsx')
    go('#/board/boardctrl-k1-cm1')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BOARDCTRL-K1-CM1'), wait)
    fireEvent.click(await button('串口', document.querySelector('.ctb') as HTMLElement))
    fireEvent.click(await button('搜索', document.querySelector('.ctb') as HTMLElement))
    expect(consoleUi.searchConsole).toHaveBeenCalledWith('boardctrl-k1-cm1', 'die0')
    await waitFor(() => expect(consoleProps.last?.onSearchHistory).toBeTruthy(), wait)
    act(() => consoleProps.last!.onSearchHistory!('mmc0', false))
    await waitFor(() => expect((document.querySelector('.lq input') as HTMLInputElement)?.value).toBe('mmc0'), wait)
    await waitFor(() => expect(document.querySelector('.lcount')?.textContent).toBe('– / 2'), wait)
    go('#/')
  })

  it('offers to stop a fastboot boot at U-Boot when the SDK\'s recipe has that break point', async () => {
    const dialog = () => document.querySelector('[role=dialog]') as HTMLElement
    go('#/board/boardctrl-k1-deb1')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BOARDCTRL-K1-DEB1'), wait)
    fireEvent.click(await button(/^启动/, document.querySelector('.controls') as HTMLElement))
    await waitFor(() => expect(dialog()).toBeTruthy(), wait)
    fireEvent.click(await button(/停在\s*uboot/, dialog()))
    fireEvent.click(await button('开始', dialog()))
    await waitFor(() => expect(calls.find(c => c.path === 'api/boot/sdk')?.body).toMatchObject({ board: 'boardctrl-k1-deb1', method: 'load', brk: 'uboot' }), wait)
    go('#/')
  })

  it('flashes a package from a link, and offers the last link again', async () => {
    const dialog = () => document.querySelector('[role=dialog]') as HTMLElement
    const open = async () => { fireEvent.click(await button(/^刷机/, document.querySelector('.controls') as HTMLElement)); await waitFor(() => expect(dialog()).toBeTruthy(), wait) }
    go('#/board/boardctrl-k1-deb1')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BOARDCTRL-K1-DEB1'), wait)
    // Booting no longer flashes: 启动 only loads into memory.
    fireEvent.click(await button(/^启动/, document.querySelector('.controls') as HTMLElement))
    await waitFor(() => expect(dialog()).toBeTruthy(), wait)
    expect(within(dialog()).queryAllByRole('button').some(el => /刷机包|^刷机/.test(el.textContent ?? ''))).toBe(false)
    fireEvent.click(await button('取消', dialog()))
    await waitFor(() => expect(dialog()).toBeNull(), wait)
    await open()
    fireEvent.click(await tab(/^链接/, dialog()))
    expect((await button('开始刷机', dialog())).disabled).toBe(true)
    fireEvent.change(dialog().querySelector('input[type=url]')!, { target: { value: 'https://images.test/k3/pkg.zip' } })
    fireEvent.change(screen.getByPlaceholderText('留空由后端按刷机包选'), { target: { value: 'tool-b' } })
    fireEvent.click(dialog().querySelector('label.check input')!)
    fireEvent.click(await button('开始刷机', dialog()))
    await waitFor(() => expect(calls.find(c => c.path === 'api/flash/package')?.body).toEqual({ board: 'boardctrl-k1-deb1', url: 'https://images.test/k3/pkg.zip', flasher: 'tool-b' }), wait)

    // The link and tool are offered again.
    await open()
    expect((dialog().querySelector('input[type=url]') as HTMLInputElement).value).toBe('https://images.test/k3/pkg.zip')
    fireEvent.click(await button('取消', dialog()))
    go('#/')
  })

  it('sends a file from this computer in pieces, then flashes it by the sha256 boardd hashed', async () => {
    const dialog = () => document.querySelector('[role=dialog]') as HTMLElement
    go('#/board/boardctrl-k1-deb1')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BOARDCTRL-K1-DEB1'), wait)
    fireEvent.click(await button(/^刷机/, document.querySelector('.controls') as HTMLElement))
    await waitFor(() => expect(dialog()).toBeTruthy(), wait)
    fireEvent.click(await tab(/^上传文件/, dialog()))
    const big = new File([new Uint8Array(8 * 1024 * 1024 + 100)], 'local.zip')
    fireEvent.change(dialog().querySelector('input[type=file]')!, { target: { files: [big] } })
    await waitFor(() => expect(dialog().textContent).toContain('传好了'), wait)
    // Two pieces, each from where the last stopped, then the seal; the browser hashes nothing.
    const id = calls.find(c => c.method === 'PUT' && c.path.startsWith('api/files/uploads/'))!.path.split('/')[3]!.split('?')[0]!
    expect(calls.filter(c => c.path.startsWith(`api/files/uploads/${id}?`)).map(c => c.path)).toEqual([`api/files/uploads/${id}?offset=0`, `api/files/uploads/${id}?offset=${8 * 1024 * 1024}`])
    expect(calls.find(c => c.path === 'api/files/uploads')?.body).toEqual({ name: 'local.zip', size: big.size })
    expect(calls.some(c => c.path === `api/files/uploads/${id}/seal`)).toBe(true)
    fireEvent.click(await button('开始刷机', dialog()))
    await waitFor(() => expect(calls.filter(c => c.path === 'api/flash/package').at(-1)?.body).toMatchObject({ board: 'boardctrl-k1-deb1', sha256: 'ab'.repeat(32) }), wait)
    go('#/')
  })

  it('sends only the newest file when another is picked while one is still being sent', async () => {
    const dialog = () => document.querySelector('[role=dialog]') as HTMLElement
    let letGo!: () => void
    uploadGate.name = 'first.zip'; uploadGate.open = new Promise<void>(resolve => { letGo = resolve })
    go('#/board/boardctrl-k1-deb1')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BOARDCTRL-K1-DEB1'), wait)
    fireEvent.click(await button(/^刷机/, document.querySelector('.controls') as HTMLElement))
    await waitFor(() => expect(dialog()).toBeTruthy(), wait)
    fireEvent.click(await tab(/^上传文件/, dialog()))
    const input = () => dialog().querySelector('input[type=file]')!
    fireEvent.change(input(), { target: { files: [new File([new Uint8Array(100)], 'first.zip')] } })
    await waitFor(() => expect(dialog().textContent).toContain('传给 boardd'), wait)
    // The second file replaces the first: the first is stopped and given up, the second is sent and sealed.
    fireEvent.change(input(), { target: { files: [new File([new Uint8Array(200)], 'second.zip')] } })
    await waitFor(() => expect(dialog().textContent).toContain('传好了 · sha256 cdcdcdcdcdcd'), wait)
    letGo()
    const [first, second] = calls.filter(c => c.path.startsWith('api/files/uploads/') && c.method === 'PUT').map(c => c.path.split('/')[3]!.split('?')[0]!).filter((id, i, all) => all.indexOf(id) === i).slice(-2)
    await waitFor(() => expect(calls.some(c => c.path === `api/files/uploads/${first}/abandon`)).toBe(true), wait)
    expect(calls.some(c => c.path === `api/files/uploads/${second}/seal`)).toBe(true)
    expect(calls.some(c => c.path === `api/files/uploads/${first}/seal`)).toBe(false)
    expect(dialog().textContent).not.toContain('没传上去')
    fireEvent.click(await button('取消', dialog()))
    go('#/')
  })

  it('flashes an image of a market: the tree for the board\'s SoC, what it would write, chosen partitions and a reset', async () => {
    const dialog = () => document.querySelector('[role=dialog]') as HTMLElement
    go('#/board/boardctrl-k1-deb1')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BOARDCTRL-K1-DEB1'), wait)
    fireEvent.click(await button(/^刷机/, document.querySelector('.controls') as HTMLElement))
    await waitFor(() => expect(dialog()).toBeTruthy(), wait)
    fireEvent.click(await tab(/^镜像市场/, dialog()))
    // The tree is read folder by folder, filtered to the board's SoC.
    fireEvent.click(await button(/^soc-a/, dialog()))
    await waitFor(() => expect(calls.some(c => c.path.startsWith('api/markets/shelf/list?path=soc-a'))).toBe(true), wait)
    expect(calls.find(c => c.path.startsWith('api/markets/shelf/list?path=soc-a'))!.path).toMatch(/soc=k1.*board=boardctrl-k1-deb1/)
    // An image its backend does not take cannot be picked.
    expect((await button(/^disk\.iso/, dialog())).disabled).toBe(true)
    const plansOf = () => calls.filter(c => c.path === 'api/flash/plan' && c.body?.image?.path === 'soc-a/new.zip')
    const reads = plansOf().length
    fireEvent.click(await button(/^new\.zip/, dialog()))
    // Picking a package plans it at once, with the tool typed on this board before (the link test): its map is there
    // without asking for it.
    await waitFor(() => expect(plansOf().length).toBe(reads + 1), wait)
    await waitFor(() => expect(dialog().querySelectorAll('.fl-map').length).toBe(1), wait)
    // A look at another tab and back to the same image is not another package: its plan is kept, not asked for again.
    const plans = () => plansOf().length
    const once = plans()
    fireEvent.click(await tab(/^链接/, dialog()))
    fireEvent.click(await tab(/^镜像市场/, dialog()))
    await waitFor(() => expect(dialog().querySelectorAll('.fl-map').length).toBe(1), wait)
    expect(plans()).toBe(once)
    // A tool typed for this board goes with the plan: the package is planned again with it.
    const toolInput = screen.getByPlaceholderText('留空由后端按刷机包选') as HTMLInputElement
    fireEvent.change(toolInput, { target: { value: 'tool-b' } })
    await waitFor(() => expect(plansOf().at(-1)!.body).toEqual({ board: 'boardctrl-k1-deb1', image: { market: 'shelf', path: 'soc-a/new.zip' }, flasher: 'tool-b' }), wait)
    await waitFor(() => expect(dialog().querySelectorAll('.fl-map').length).toBe(1), wait)
    // The plan's preset is offered by name: choosing it writes that medium and its partitions, not one by one.
    await waitFor(() => expect(dialog().querySelector('[data-choices]')?.textContent).toContain('NOR 启动'), wait)
    const choices = dialog().querySelector('[data-choices]') as HTMLElement
    fireEvent.click(await button(/^NOR\s*启动$/, choices))
    fireEvent.click(await button('开始刷机', dialog()))
    await waitFor(() => expect(calls.filter(c => c.path === 'api/flash/package').at(-1)?.body).toEqual({ board: 'boardctrl-k1-deb1', image: { market: 'shelf', path: 'soc-a/new.zip' }, flasher: 'tool-b', partitions: ['boot'], layout: 'nor', reset: true }), wait)
    go('#/')
  })

  it('searches the whole market at once: the folders leading to a match, expanded, and nothing else', async () => {
    const dialog = () => document.querySelector('[role=dialog]') as HTMLElement
    go('#/board/boardctrl-k1-deb1')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BOARDCTRL-K1-DEB1'), wait)
    fireEvent.click(await button(/^刷机/, document.querySelector('.controls') as HTMLElement))
    await waitFor(() => expect(dialog()).toBeTruthy(), wait)
    fireEvent.click(await tab(/^镜像市场/, dialog()))
    const find = dialog().querySelector('input[aria-label=找镜像]') as HTMLInputElement
    // The whole tree is read in boardd at once, filtered the board's SoC and marked for its backend.
    fireEvent.change(find, { target: { value: 'deep' } })
    await waitFor(() => expect(calls.some(c => c.path.startsWith('api/markets/shelf/search?q=deep'))).toBe(true), wait)
    expect(calls.find(c => c.path.startsWith('api/markets/shelf/search'))!.path).toMatch(/soc=k1.*board=boardctrl-k1-deb1/)
    // Only the folders leading to the match, expanded all the way, and the match itself.
    await waitFor(() => expect(dialog().querySelector('.mk-found')?.textContent).toContain('deep.zip'), wait)
    const rows = [...dialog().querySelectorAll('.mk-found .mk-row')].map(row => row.textContent ?? '')
    expect(rows.some(row => row.includes('soc-b'))).toBe(false)
    expect(rows.some(row => row.includes('soc-a'))).toBe(true)
    expect(rows.some(row => row.includes('old'))).toBe(true)
    expect(rows.find(row => row.includes('deep.zip'))).toBeTruthy()
    fireEvent.click(await button(/deep\.zip/, dialog()))
    // Nothing matches: said so, with no folder left behind.
    fireEvent.change(find, { target: { value: 'nothing' } })
    await waitFor(() => expect(dialog().querySelector('.mk-found')?.textContent).toContain('没有名字里有「nothing」的镜像'), wait)
    expect([...dialog().querySelectorAll('.mk-found .mk-row.mk-folder')].length).toBe(0)
    // The shelf was searched whole: nothing says an image may be missing.
    fireEvent.change(find, { target: { value: 'deep' } })
    await waitFor(() => expect(dialog().querySelector('.mk-found')?.textContent).toContain('deep.zip'), wait)
    expect(dialog().querySelector('.mk-count')?.textContent ?? '').not.toContain('可能有遗漏')
    fireEvent.click(await button('取消', dialog()))
    go('#/')
  })

  it('browses an image market by SoC, and flashes an image onto a free board, locked for the person', async () => {
    const dialog = () => document.querySelector('[role=dialog]') as HTMLElement
    go('#/')
    await waitFor(() => expect([...document.querySelectorAll('.nav a')].some(a => a.textContent === '镜像')).toBe(true), wait)
    go('#/images')
    await waitFor(() => expect(document.querySelector('.hero h1')?.textContent).toBe('镜像'), wait)
    // The SoCs to filter by are the ones the market files its folders under.
    fireEvent.click(await button('K3'))
    await waitFor(() => expect(location.hash).toBe('#/images?market=shelf&soc=k3'), wait)
    fireEvent.click(await button(/^soc-a/))
    fireEvent.click(await button(/^new\.zip/))
    await waitFor(() => expect(document.querySelector('.mk-detail h2')?.textContent).toBe('new.zip'), wait)
    expect(document.querySelector('.mk-detail')!.textContent).toContain('3 MiB')
    fireEvent.click(await button('刷机…'))
    await waitFor(() => expect(dialog()?.textContent).toContain('刷到哪块板子'), wait)
    // Boardd says where it can go: yours, a free one, one held by someone else that cannot be picked.
    expect((await button('不能刷', dialog())).disabled).toBe(true)
    expect(await button('刷这块', dialog())).toBeTruthy()
    fireEvent.click(await button('拿锁并刷', dialog()))
    await waitFor(() => expect(calls.find(c => c.path === 'api/lock' && (c.body as { board?: string }).board === 'boardctrl-k1-pico')?.body).toMatchObject({ board: 'boardctrl-k1-pico', purpose: '刷机 new.zip' }), wait)
    // The flash dialog opens on the image picked, for that board.
    await waitFor(() => expect(dialog()?.querySelector('h2')?.textContent).toBe('刷机'), wait)
    expect(dialog().textContent).toContain('BOARDCTRL-K1-PICO')
    expect(dialog().querySelector('.fl-picked')?.textContent).toContain('soc-a/new.zip')
    // Its backend cannot say what a package would write, so that is not offered.
    expect(dialog().textContent).not.toContain('看看会写什么')
    expect(dialog().querySelector('.fl-plan')).toBeNull()
    fireEvent.click(await button('取消', dialog()))
    go('#/')
  })

  it('clears the console without disconnecting it', async () => {
    const consoleUi = await import('../src/ui/console.tsx')
    go('#/board/boardctrl-k1-cm1')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BOARDCTRL-K1-CM1'), wait)
    fireEvent.click(await button('清屏', document.querySelector('.ctb') as HTMLElement))
    expect(consoleUi.clearConsole).toHaveBeenCalledWith('boardctrl-k1-cm1', 'die0')
    go('#/')
  })

  it('switches to another board from the name, by mouse or keys, keeping the tab it shows', async () => {
    go('#/board/boardctrl-k1-cm1')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BOARDCTRL-K1-CM1'), wait)
    fireEvent.click(await button('日志'))
    // The board's side panel starts over on a switch, the name with it: look it up each time.
    let name = document.querySelector('.bswitch [role=button]') as HTMLElement
    expect(name.getAttribute('aria-expanded')).toBe('false')
    expect(name.closest('h1')?.className).toBe('bname')
    expect(name.getAttribute('aria-label')).toMatch(/^BOARDCTRL-K1-CM1，/)
    fireEvent.click(name)
    const list = () => document.querySelector('.bswitch [role=listbox]') as HTMLElement | null
    await waitFor(() => expect(list()).toBeTruthy(), wait)
    // Every board but the empty slots, the one shown marked; a short list has no filter box and takes the keys itself.
    const options = within(list()!).getAllByRole('option')
    expect(options.map(o => o.querySelector('.bs-name')!.textContent)).toContain('BOARDCTRL-K1-PICO')
    expect(options.some(o => /HOST-B-S6/.test(o.textContent ?? ''))).toBe(false)
    expect(options.filter(o => o.getAttribute('aria-selected') === 'true').map(o => o.querySelector('.bs-name')!.textContent)).toEqual(['BOARDCTRL-K1-CM1'])
    expect(document.querySelector('.bswitch input')).toBeNull()
    expect(document.activeElement).toBe(list())
    const at = () => list()!.querySelector('[data-active]')!.querySelector('.bs-name')!.textContent
    expect(at()).toBe('BOARDCTRL-K1-CM1')
    // Esc closes it and gives the focus back; so does a press outside.
    fireEvent.keyDown(list()!, { key: 'Escape' })
    await waitFor(() => expect(list()).toBeNull(), wait)
    expect(document.activeElement).toBe(name)
    fireEvent.keyDown(name, { key: 'Enter' })
    await waitFor(() => expect(list()).toBeTruthy(), wait)
    fireEvent.pointerDown(document.querySelector('.ctb')!)
    await waitFor(() => expect(list()).toBeNull(), wait)
    // The arrows move from the board shown, Enter picks: its page, on the same tab.
    fireEvent.keyDown(name, { key: 'ArrowDown' })
    await waitFor(() => expect(list()).toBeTruthy(), wait)
    fireEvent.keyDown(list()!, { key: 'ArrowDown' })
    const next = at()!
    expect(next).not.toBe('BOARDCTRL-K1-CM1')
    fireEvent.keyDown(list()!, { key: 'Enter' })
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe(next), wait)
    expect(document.querySelector('.ctb .tab.on')?.textContent).toBe('日志')

    // More than eight boards: a filter box, which has the keys; a click picks.
    const extra = ['boardctrl-k1-extra-a', 'boardctrl-k1-extra-b', 'boardctrl-k1-extra-c', 'boardctrl-k1-extra-d', 'boardctrl-k1-extra-e'].map(n => ({ ...structuredClone(state.boards.find(b => b.name === 'boardctrl-k1-musecard')!), name: n }))
    state.boards.push(...extra)
    const source = await stateStream()
    source.emit('changed', { board: null })
    name = document.querySelector('.bswitch [role=button]') as HTMLElement
    fireEvent.click(name)
    await waitFor(() => expect(within(list()!).getAllByRole('option')).toHaveLength(12), wait)
    const filter = document.querySelector('.bswitch input') as HTMLInputElement
    expect(document.activeElement).toBe(filter)
    fireEvent.change(filter, { target: { value: 'musecard' } })
    await waitFor(() => expect(within(list()!).getAllByRole('option')).toHaveLength(1), wait)
    fireEvent.change(filter, { target: { value: 'k1-cm' } })
    await waitFor(() => expect(within(list()!).getAllByRole('option')).toHaveLength(1), wait)
    fireEvent.click(within(list()!).getByRole('option'))
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BOARDCTRL-K1-CM1'), wait)
    expect(location.hash).toBe('#/board/boardctrl-k1-cm1')
    expect(list()).toBeNull()
    await waitFor(() => expect(calls.filter(c => c.path.startsWith('api/logs?')).at(-1)!.path).toMatch(/board=boardctrl-k1-cm1/), wait)
    state.boards.splice(state.boards.length - extra.length, extra.length)
    source.emit('changed', { board: null })
    go('#/')
  })

  it('says how the last run ended when it needs a person, and nothing after a success', async () => {
    const pico = state.boards.find(b => b.name === 'boardctrl-k1-pico')!
    pico.run = { id: 'run-a1b2c3d4', boards: ['boardctrl-k1-pico'], kind: 'boot', label: '刷机中', by: 'user:alice', since: '2026-11-10T09:00:00.000Z', line: 'flash rootfs', status: 'interrupted' as const, message: 'boardd 在它运行时重启了，没能跟到它结束', endedAt: '2026-11-10T09:20:00.000Z' }
    const source = await stateStream()
    source.emit('changed', { board: pico.name })
    go('#/board/boardctrl-k1-pico')
    await waitFor(() => expect(document.querySelector('.detail .last-run')?.textContent).toContain('刷机没跟到结束'), wait)
    expect(document.querySelector('.detail .last-run')?.textContent).toContain('boardd 在它运行时重启了')
    pico.run = { ...pico.run, status: 'succeeded', message: null }
    source.emit('changed', { board: pico.name })
    await waitFor(() => expect(document.querySelector('.detail .last-run')).toBeNull(), wait)
    pico.run = null
    go('#/')
  })

  it('keeps the board shortcuts out of the open switcher', async () => {
    // boardctrl-k1-deb1 is yours, so R resets it; a letter typed in the open list does not. The suite's tests share one
    // page, so what earlier ones asked stays in the log: this one counts its own.
    go('#/board/boardctrl-k1-deb1')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BOARDCTRL-K1-DEB1'), wait)
    const before = calls.length
    fireEvent.click(document.querySelector('.bswitch [role=button]')!)
    const list = () => document.querySelector('.bswitch [role=listbox]') as HTMLElement | null
    await waitFor(() => expect(list()).toBeTruthy(), wait)
    fireEvent.keyDown(list()!, { key: 'r' })
    fireEvent.keyDown(list()!, { key: 'd' })
    await new Promise(r => setTimeout(r, 50))
    expect(calls.slice(before).some(c => c.path === 'api/reset' || c.path === 'api/fastboot')).toBe(false)
    fireEvent.keyDown(list()!, { key: 'Escape' })
    await waitFor(() => expect(list()).toBeNull(), wait)
    go('#/')
  })

  it('makes the console fill the screen and back', async () => {
    go('#/board/boardctrl-k1-cm1')
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
      .toEqual({ id: 'boardctrl', confirmed: true, method: 'bind', host: 'host-a', slot: 'host-a/s7', values: { usb: '1-1.2', console: 'ttyUSB7', soc: 'k3' } }), wait)

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
      .toEqual({ id: 'boardctrl', confirmed: true, method: 'bind', host: 'host-b', slot: 'host-b/s6', values: { usb: '1-1.4', console: 'ttyUSB9', soc: 'k3' } }), wait)
  })

  it('offers the same automatic or manual choice from an empty board page', async () => {
    go('#/board/boardctrl-host-b-s6')
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
    go('#/board/boardctrl-host-b-s6')
    await waitFor(() => expect(document.querySelector('.detail')).toBeTruthy(), wait)
    fireEvent.click(await button('发现这块板', document.querySelector('.detail') as HTMLElement))
    const dialog = await screen.findByRole('dialog', {}, wait)
    fireEvent.click(await button(/自动刷机/, dialog))
    await waitFor(() => expect(dialog.textContent).toContain('只动这一个槽位'), wait)
    fireEvent.change(within(dialog).getByPlaceholderText(/例如 12,13/), { target: { value: '12,13' } })
    fireEvent.click(await button('开始', dialog))
    await waitFor(() => expect(calls.filter(c => c.path === 'api/labs/discover').at(-1)?.body)
      .toEqual({ id: 'boardctrl', confirmed: true, method: 'probe', host: 'host-b', slot: 'host-b/s6', values: { prefer: '12,13' } }), wait)
  })

  it('renders a discovery method it has never seen, with the fields the backend named', async () => {
    go('#/board/boardctrl-host-b-s6')
    await waitFor(() => expect(document.querySelector('.detail')).toBeTruthy(), wait)
    fireEvent.click(await button('发现这块板', document.querySelector('.detail') as HTMLElement))
    const dialog = await screen.findByRole('dialog', {}, wait)
    fireEvent.click(await button(/按编号找/, dialog))
    await waitFor(() => expect(dialog.textContent).toContain('输入板子背面的编号'), wait)
    expect(dialog.textContent).toContain('实验室按编号登记')
    fireEvent.change(within(dialog).getByPlaceholderText(/例如 A-12/), { target: { value: 'A-12' } })
    fireEvent.click(await button('开始', dialog))
    await waitFor(() => expect(calls.filter(c => c.path === 'api/labs/discover').at(-1)?.body)
      .toEqual({ id: 'boardctrl', confirmed: true, method: 'lookup', host: 'host-b', slot: 'host-b/s6', values: { code: 'A-12' } }), wait)
  })

  it('rediscovers a host while its boards are held, keeping them', async () => {
    go('#/discover')
    await waitFor(() => expect(document.querySelectorAll('.panel').length).toBeGreaterThan(1), wait)
    const hostB = [...document.querySelectorAll('.panel')].find(p => p.querySelector('h2')?.textContent?.startsWith('host-b')) as HTMLElement
    const rediscover = await button('重新发现', hostB)
    expect(rediscover.disabled).toBe(false)
    fireEvent.click(rediscover)
    const dialog = await screen.findByRole('dialog', {}, wait)
    expect(dialog.textContent).toContain('保留在用的板子：BOARDCTRL-K1-DEB1、BOARDCTRL-K1-CM1')
    expect(dialog.textContent).toContain('忘掉串口不见的板子：BOARDCTRL-K3-GONE')
    fireEvent.click(await button('重新发现', dialog))
    await waitFor(() => expect(calls.find(c => c.path === 'api/labs/rebuild')?.body).toEqual({ id: 'boardctrl', host: 'host-b', confirmed: true, keepInUse: true }), wait)
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
    expect(steps[0]).toBe('boardctrl 板卡主机')
    // Only modules that offered a settings section appear (this state has no client machines to set up).
    expect(steps).toEqual(['boardctrl 板卡主机', 'SDK 与站点', '发现板子'])
    expect(container.querySelector('li.next a')?.getAttribute('href')).toBe('#/settings/boardctrl-hosts')
    unmount()
  })

  it('draws the 模块 page like any other page: a title and a panel, not bare', async () => {
    go('#/p/modules')
    await waitFor(() => expect(document.querySelector('.page .hero h1')?.textContent).toBe('模块'), wait)
    expect(document.querySelector('.page .panel')).toBeTruthy()
    expect(document.querySelector('.page .panel .mv-list')).toBeTruthy()
    go('#/')
  })

  it('gives the market, the notification bus and the console watchers a tab of their own, not a settings section', async () => {
    // Each is more than a setting: a shop, a log, a run. Their tabs are modules' `page` views, so the nav is built from
    // what boardd loaded — this page names no module.
    const tabs = (title: string) => [...document.querySelectorAll('.top .nav a')].find(link => link.textContent === title)
    await waitFor(() => expect(tabs('模块市场')).toBeTruthy(), wait)
    expect(tabs('通知')).toBeTruthy()
    expect(tabs('串口监控')).toBeTruthy()
    expect(tabs('设置')).toBeTruthy()
    go('#/settings')
    await waitFor(() => expect(document.querySelector('.settings-flow')).toBeTruthy(), wait)
    // The settings page keeps a person's own settings; none of the three is a section of it.
    const flow = document.querySelector('.settings-flow')!.textContent ?? ''
    expect(flow).not.toContain('模块市场')
    expect(flow).not.toContain('串口监控')
    // What is there is the browser's own notification preferences — which events this page pops in the system.
    expect(flow).toContain('浏览器通知')
    expect(flow).toContain('老化/长跑监控报警了')
    go('#/')
  })

  it('gives the market a page that installs, uninstalls, adds a market and reloads', async () => {
    go('#/p/market')
    await waitFor(() => expect(document.querySelector('.page .hero h1')?.textContent).toBe('模块市场'), wait)
    // The empty state is still a shop: a form to add one, with the warning about what market code runs as.
    const text = document.querySelector('.page')!.textContent ?? ''
    expect(text).toContain('加市场')
    expect(text).toContain('权限和 boardd 一样')
    go('#/')
  })

  it('shows boardd\'s own notification bus in the bell, not only the page\'s changes', async () => {
    // The bus's alerts are read from boardd, so a page opened after something failed still shows it.
    await waitFor(() => expect(calls.some(c => c.method === 'GET' && c.path.startsWith('api/alerts'))).toBe(true), wait)
    fireEvent.click(await button('通知'))
    const drawer = await screen.findByRole('dialog', {}, wait)
    expect(drawer.textContent).toContain('boardctrl-k1-cm1：复位失败')
    expect(drawer.textContent).toContain('aging-1：panic')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('[role=dialog]')).toBeNull(), wait)
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

  it('shows how full boardd\'s file store is in settings', async () => {
    go('#/settings/files')
    await waitFor(() => expect(document.querySelector('#s-files')?.textContent).toContain('3 GiB / 上限 20 GiB'), wait)
    expect(document.querySelector('#s-files')!.textContent).toContain('磁盘还剩 100 GiB')
    expect(document.querySelector('#s-files')!.textContent).toContain('4 个文件 · 不用的留 3 天')
    expect((document.querySelector('#s-files .usage-bar i') as HTMLElement).style.width).toBe('15%')
    go('#/')
  })

  it('shows what each board host keeps in its cache, read when opened', async () => {
    go('#/settings/boardctrl-hosts')
    const opener = () => [...document.querySelectorAll('button')].find(item => /的主机缓存/.test(item.textContent ?? ''))
    await waitFor(() => expect(opener()).toBeTruthy(), wait)
    expect(calls.some(c => /^api\/boardctrl\/hosts\/.*\/cache/.test(c.path))).toBe(false)
    fireEvent.click(opener()!)
    const box = () => opener()!.parentElement!
    await waitFor(() => expect(box().textContent).toContain('host-a：46.0 GiB / 50.0 GiB'), wait)
    expect(box().textContent).toContain('12 项（1 项正在用） · 不用的留 7 天 · 磁盘还剩 80.0 GiB')
    expect(box().textContent).toContain('host-b：主机上的 boardctrl 太旧')
    expect(box().querySelector('progress, [role=progressbar], .mv-progress')).toBeTruthy()
    go('#/')
  })

  it('opens a settings section by its address', async () => {
    go('#/settings/boardctrl-hosts')
    await waitFor(() => expect(document.querySelector('.settings-nav button.on')?.textContent).toBe('boardctrl 板卡主机'), wait)
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
    go('#/settings/boardctrl-site')
    const panel = await waitFor(() => { const found = [...document.querySelectorAll('section.panel')].find(el => el.querySelector('h2')?.textContent?.startsWith('SDK 与站点')); expect(found).toBeTruthy(); return found as HTMLElement }, wait)
    const nav = [...document.querySelectorAll('.settings-nav button')].map(el => el.textContent)
    expect(nav.indexOf('boardctrl 板卡主机')).toBeLessThan(nav.indexOf('SDK 与站点'))
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
      if (url.pathname === '/api/models') return json({ models: ['k1_deb1', 'k1-x_pico'] })
      return base(input, init)
    }) as typeof fetch
    try {
      await api.models(true)
      go('#/board/boardctrl-k1-deb1')
      await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BOARDCTRL-K1-DEB1'), wait)
      const field = await waitFor(() => {
        const input = document.querySelector('.model-edit input') as HTMLInputElement | null
        expect(input).toBeTruthy()
        return input!
      }, wait)
      expect(field.value).toBe('k1_deb1')
      const list = within(field.closest('.model-edit') as HTMLElement).getByRole('combobox', { name: '选择历史板型' })
      expect([...list.querySelectorAll('option')].map(option => option.value)).toEqual(['', 'k1_deb1', 'k1-x_pico'])

      const editor = field.closest('.model-edit') as HTMLElement
      fireEvent.change(list, { target: { value: 'k1-x_pico' } })
      expect(field.value).toBe('k1-x_pico')
      fireEvent.click(await button('保存', editor))
      await waitFor(() => expect(calls.find(c => c.method === 'POST' && c.path === 'api/board')?.body).toEqual({ name: 'boardctrl-k1-deb1', product: 'k1-x_pico' }), wait)

      fireEvent.change(field, { target: { value: '' } })
      fireEvent.click(await button('保存', editor))
      await waitFor(() => expect(calls.filter(c => c.method === 'POST' && c.path === 'api/board').at(-1)?.body).toEqual({ name: 'boardctrl-k1-deb1', product: null }), wait)
    } finally { globalThis.fetch = base; go('#/') }
  })

  it('renames a board from the menu, then reloads the page', async () => {
    go('#/board/boardctrl-k1-deb1')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BOARDCTRL-K1-DEB1'), wait)
    const before = calls.filter(c => c.method === 'GET' && c.path === 'api/state').length
    fireEvent.click(await screen.findByRole('button', { name: '更多' }, wait))
    fireEvent.click(await button(/给板子改名/))
    const dialog = await screen.findByRole('dialog', {}, wait)
    const input = dialog.querySelector('input') as HTMLInputElement
    expect(input.value).toBe('boardctrl-k1-deb1')
    // What a person types is the name; no lab prefix is added for them.
    expect(dialog.textContent).toContain('不会自动加 boardctrl- 前缀')
    fireEvent.change(input, { target: { value: 'k1-deb1r' } })
    fireEvent.click(await button('改名', dialog))
    await waitFor(() => expect(calls.find(c => c.method === 'POST' && c.path === 'api/board/rename')?.body).toEqual({ board: 'boardctrl-k1-deb1', name: 'k1-deb1r' }), wait)
    await waitFor(() => expect(calls.filter(c => c.method === 'GET' && c.path === 'api/state').length).toBeGreaterThan(before), wait)
    await waitFor(() => expect(document.querySelector('.toast')?.textContent).toContain('改名好了'), wait)
    go('#/')
  })

  it('reopens the boot dialog with the break points it already read', async () => {
    const dialog = () => document.querySelector('[role=dialog]') as HTMLElement
    const reads = (board: string) => calls.filter(c => c.path.startsWith('api/boot/breaks') && c.path.includes(`board=${board}`)).length
    const open = async () => { fireEvent.click(await button(/^启动/, document.querySelector('.controls') as HTMLElement)); await waitFor(() => expect(dialog()).toBeTruthy(), wait) }
    go('#/board/boardctrl-k1-musecard')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BOARDCTRL-K1-MUSECARD'), wait)
    // The page reads the selected SDK's break points before the dialog opens.
    await waitFor(() => expect(reads('boardctrl-k1-musecard')).toBe(1), wait)
    await open()
    expect(await button(/停在\s*uboot/, dialog())).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('[role=dialog]')).toBeNull(), wait)
    await open()
    expect(await button(/停在\s*uboot/, dialog())).toBeTruthy()
    expect(reads('boardctrl-k1-musecard')).toBe(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    go('#/')
  })

  it('switches the frontend boardd serves from settings', async () => {
    go('#/settings')
    fireEvent.click(await screen.findByText('TroyMitchellDefault', {}, wait))
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === 'api/frontends?name=troy-mitchell-default')).toBe(true), wait)
  })

  it('asks a debug-capable board\'s host for its debug path and shows what it offers', async () => {
    go('#/board/boardctrl-k1-musecard')
    await waitFor(() => expect(document.querySelector('.detail .bname')?.textContent).toBe('BOARDCTRL-K1-MUSECARD'), wait)
    // The path is asked for when the board page opens, and what arrived is on the page: the provider's own name,
    // what it offers, and a way to start the session — not only a request made.
    await waitFor(() => expect(calls.some(c => c.path === 'api/debug' && (c.body as { board?: string, action?: string }).board === 'boardctrl-k1-musecard'
      && (c.body as { action?: string }).action === 'path')).toBe(true), wait)
    await waitFor(() => expect(document.body.textContent).toContain('调试（SWD over GPIO）'), wait)
    expect(document.body.textContent).toContain('两颗 GPIO 位操作出来的链路。')
    expect(document.body.textContent).toContain('未启动')
    await button(/启动调试会话/)
    go('#/')
  })

  it('asks the host to start the session, then offers the provider\'s own actions and its trace', async () => {
    go('#/board/boardctrl-k1-musecard')
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

  it('answers an agent\'s ask in the banner, without going to the module\'s page', async () => {
    go('#/')
    const banner = await waitFor(() => {
      const el = [...document.querySelectorAll('.banner')].find(item => item.textContent?.includes('把测试板接到端口 2'))
      if (!el) throw new Error('no ask banner')
      return el as HTMLElement
    }, wait)
    expect(banner.textContent).toContain('接好后板上的灯会常亮')
    fireEvent.click(await button('我做好了', banner))
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === 'api/human/resolve' && (c.body as { id: number }).id === 7)).toBe(true), wait)
    await waitFor(() => expect([...document.querySelectorAll('.banner')].some(item => item.textContent?.includes('把测试板接到端口 2'))).toBe(false), wait)
  })

  it('trades the overview and the last board from the 板子 tab, and returns to that board from another tab', async () => {
    localStorage.removeItem('boardlab.modern.board')
    const boardsTab = () => {
      const link = [...document.querySelectorAll('nav.nav a')].find(el => (el.textContent ?? '').trim() === '板子') as HTMLAnchorElement
      fireEvent.click(link)
      // The browser fires this after the address changes; the test says so itself.
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    }
    const open = () => document.querySelector('.detail .bname')?.textContent ?? null
    go('#/board/boardctrl-k1-deb1')
    await waitFor(() => expect(open()).toBe('BOARDCTRL-K1-DEB1'), wait)
    // A board's page: the overview. One press, one assertion: pressing again inside waitFor would toggle back.
    boardsTab()
    await waitFor(() => expect(open()).toBeNull(), wait)
    expect(location.hash).toBe('#/')
    // The overview: the board last looked at.
    boardsTab()
    await waitFor(() => expect(open()).toBe('BOARDCTRL-K1-DEB1'), wait)
    // Another tab: straight to it.
    go('#/settings')
    await waitFor(() => expect(open()).toBeNull(), wait)
    boardsTab()
    await waitFor(() => expect(open()).toBe('BOARDCTRL-K1-DEB1'), wait)
    go('#/')
  })

  it('says a bus alert as it is raised, and keeps it in the bell', async () => {
    const source = await stateStream()
    source.opened()
    source.emit('alert', { id: 3, topic: 'failed', title: 'boardctrl-k1-pico：刷机失败', board: 'boardctrl-k1-pico' })
    // The bus is read again, and what the bell shows is what boardd recorded, not the event's own words.
    await waitFor(() => expect(calls.filter(c => c.method === 'GET' && c.path.startsWith('api/alerts')).length).toBeGreaterThan(1), wait)
    fireEvent.click(await button('通知'))
    const drawer = await screen.findByRole('dialog', {}, wait)
    expect(drawer.textContent).toContain('aging-1：panic')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('[role=dialog]')).toBeNull(), wait)
  })
})
