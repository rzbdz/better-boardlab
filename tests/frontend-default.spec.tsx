// @vitest-environment jsdom
/** TroyMitchellDefault against the mock boardd: its board cards and tabs, with the modules' views in its style. */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import { calls } from './frontend-setup.ts'

const wait = { timeout: 4000 }

beforeAll(async () => {
  document.body.innerHTML = '<div id="root"></div>'
  const { MODULE_UIS } = await import('../src/uis.ts')
  const { mountPage } = await import('../frontends/troy-mitchell-default/main.tsx')
  mountPage(MODULE_UIS)
})

const tab = async (label: string) => fireEvent.click(await screen.findByRole('tab', { name: new RegExp(label) }, wait))

describe('TroyMitchellDefault frontend', () => {
  it('shows a card per board: this machine\'s first, a lab\'s under its tab', async () => {
    expect(await screen.findByText('desk-k1', {}, wait)).toBeTruthy()
    await tab('实验室 bsp')
    expect(await screen.findByText('bsp-k1-musecard', {}, wait)).toBeTruthy()
    expect(screen.getByText('bsp-k3-cm1')).toBeTruthy()
  })

  it('draws the modules\' settings from their views, and offers the other frontend', async () => {
    await tab('设置')
    expect(await screen.findByText('Home Assistant', {}, wait)).toBeTruthy()
    expect(await screen.findByText('自定义槽位', {}, wait)).toBeTruthy()
    expect(await screen.findByText('Modern', {}, wait)).toBeTruthy()
  })

  it('draws the local module\'s scan and its result', async () => {
    await tab('扫描')
    expect(await screen.findByText('扫描本机槽位', {}, wait)).toBeTruthy()
    expect(await screen.findByText('最近一次扫描', {}, wait)).toBeTruthy()
  })

  const emptyCard = async () => {
    await tab('板子')
    await tab('实验室 bsp')
    await waitFor(() => expect(document.querySelector('[data-board=\"bsp-host-b-s6\"]')).toBeTruthy(), wait)
    return document.querySelector('[data-board=\"bsp-host-b-s6\"]') as HTMLElement
  }

  it('offers automatic or manual discovery on an empty board card', async () => {
    const card = await emptyCard()
    fireEvent.click(within(card).getByRole('button', { name: '发现这块板' }))
    const dialog = await screen.findByRole('dialog', {}, wait)
    expect(dialog.textContent).toContain('自动刷机')
    expect(dialog.textContent).toContain('人工刷机')
    fireEvent.click(within(dialog).getByRole('button', { name: /人工刷机/ }))
    // The method's own form replaces the list: a fresh dialog.
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('请保证此时只有一块还没登记的板子处于下载模式'), wait)
    const form = screen.getByRole('dialog')
    const [usb, port] = [...form.querySelectorAll('select')] as HTMLSelectElement[]
    // The board card's host: none of its two ports is guessed; the person picks the port and console.
    expect(usb!.value).toBe('')
    fireEvent.change(usb!, { target: { value: '1-1.3' } })
    await waitFor(() => expect(port!.value).toBe(''), wait)
    fireEvent.change(port!, { target: { value: 'ttyUSB8' } })
    fireEvent.click(within(form).getByRole('button', { name: '开始' }))
    await waitFor(() => expect(calls.filter(c => c.path === 'api/labs/discover').at(-1)?.body).toEqual({
      id: 'bsp', confirmed: true, method: 'bind', host: 'host-b', slot: 'host-b/s6', values: { usb: '1-1.3', console: 'ttyUSB8', soc: 'k3' } }), wait)
  })

  it('names every action in the history with the shared table, never a raw id', async () => {
    const { ACTIONS } = await import('../src/ui/format.ts')
    await tab('历史')
    expect(await screen.findByText(ACTIONS.reset!, {}, wait)).toBeTruthy()
    // Every id the shared table names is this frontend's too: it re-exports the table rather than keeping a copy
    // that drifts (its own copy had lost thirteen, the manual board registration among them).
    const kit = await import('../frontends/troy-mitchell-default/kit.tsx')
    expect(kit.ACTIONS).toBe(ACTIONS)
  })

  it('starts automatic discovery for the card\'s slot', async () => {
    const card = await emptyCard()
    fireEvent.click(within(card).getByRole('button', { name: '发现这块板' }))
    const dialog = await screen.findByRole('dialog', {}, wait)
    fireEvent.click(within(dialog).getByRole('button', { name: /自动刷机/ }))
    await waitFor(() => expect(screen.getByRole('dialog').querySelector('input[placeholder*="12,13"]')).toBeTruthy(), wait)
    const form = screen.getByRole('dialog')
    fireEvent.change(within(form).getByPlaceholderText(/例如 12,13/), { target: { value: '12,13' } })
    fireEvent.click(within(form).getByRole('button', { name: '开始' }))
    await waitFor(() => expect(calls.filter(c => c.path === 'api/labs/discover').at(-1)?.body).toEqual({
      id: 'bsp', confirmed: true, method: 'probe', host: 'host-b', slot: 'host-b/s6', values: { prefer: '12,13' } }), wait)
  })
})

describe('TroyMitchellDefault health', () => {
  it('warns that boardd restored its database from a copy until a person says they saw it', async () => {
    const { FakeEventSource, state } = await import('./frontend-setup.ts')
    state.restored = { at: '2026-11-19T03:00:00.000Z', backup: '/state/backups/boards-2026-11-18T21-00-00-000Z.sqlite', aside: '/state/boards.sqlite.corrupt-2026-11-19T03-00-00-000Z', reason: 'database disk image is malformed' }
    const source = await waitFor(() => { const found = FakeEventSource.instances.filter(item => /(^|\/)api\/events(\?|$)/.test(item.url)).at(-1); if (!found) throw new Error('no stream'); return found }, wait)
    source.opened()
    source.emit('changed', { board: null })
    const alert = await screen.findByTestId('db-restored', {}, wait)
    expect(alert.textContent).toContain('从备份恢复过')
    fireEvent.click(within(alert).getByRole('button', { name: '知道了' }))
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === 'api/database/acknowledge')).toBe(true), wait)
    await waitFor(() => expect(screen.queryByTestId('db-restored')).toBeNull(), wait)
  })
})

describe('TroyMitchellDefault console', () => {
  it('says why the console dropped in its status, and that boardd restarted', async () => {
    const { FakeEventSource } = await import('./frontend-setup.ts')
    const streamsOf = () => FakeEventSource.instances.filter(item => item.url.startsWith('api/console?raw=1&board=bsp-k1-musecard'))
    await tab('板子')
    await tab('实验室 bsp')
    const card = await waitFor(() => { const el = document.querySelector('[data-board="bsp-k1-musecard"]'); if (!el) throw new Error('no card'); return el as HTMLElement }, wait)
    fireEvent.click(card)
    const status = await screen.findByTestId('console-status', {}, wait)
    const stream = streamsOf().at(-1)!
    stream.emit('hello', { boot: 'b1' })
    stream.emit('history', ['root@k1:~# '])
    await waitFor(() => expect(status.textContent).toContain('实时'), wait)
    stream.emit('closed', 'adapter unplugged')
    await waitFor(() => expect(status.textContent).toContain('串口断开：adapter unplugged，重连中'), wait)
    await waitFor(() => expect(streamsOf().at(-1)).not.toBe(stream), wait)
    streamsOf().at(-1)!.emit('restart', { reason: '服务重启' })
    await waitFor(() => expect(status.textContent).toContain('服务重启，重连中'), wait)
  })
})
