// @vitest-environment jsdom
/**
 * Stopping long work from both frontends: a module's `job` gets a signal its 取消 button aborts (the contract's
 * signal is alive), and a board boardd is busy with shows one stop button whenever its busy entry is cancellable.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { job, type View } from '../src/ui/contract.ts'
import { calls, state } from './frontend-setup.ts'

vi.mock('../src/ui/console.tsx', () => ({ SerialConsole: () => null, reconnectConsole: () => {}, clearConsole: vi.fn(), searchConsole: vi.fn(), STATUS_TEXT: { connecting: '连接中', live: '实时', closed: '已断开，重连中', retry: '重连中' } }))

const wait = { timeout: 4000 }
afterEach(() => cleanup())

/** A module view with one long job that runs until its signal aborts, and says it can be stopped (or not). */
function waitingJob(cancellable = true) {
  const seen: { signal: AbortSignal | null, fail?: (error: Error) => void } = { signal: null }
  const view: View = {
    id: 'long', slot: 'settings', title: '长任务',
    body: [{ kind: 'actions', actions: [job('run', '开始', (_input, sink, signal) => new Promise((_resolve, reject) => {
      seen.signal = signal
      seen.fail = reject
      sink.line('working')
      signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
    }), { cancellable })] }],
  }
  return { view, seen }
}

describe('a module job can be cancelled', () => {
  it('in Modern: 取消 aborts the signal the job was started with', async () => {
    const { ViewPanel } = await import('../frontends/modern/render.tsx')
    const { UIProvider } = await import('../frontends/modern/kit.tsx')
    const { view, seen } = waitingJob()
    render(createElement(UIProvider, null, createElement(ViewPanel, { view })))
    fireEvent.click(await screen.findByRole('button', { name: /开始/ }, wait))
    await waitFor(() => expect(seen.signal).not.toBeNull(), wait)
    expect(seen.signal!.aborted).toBe(false)
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /取消/ }, wait)) })
    expect(seen.signal!.aborted).toBe(true)
    await waitFor(() => expect(screen.queryByRole('button', { name: /取消/ })).toBeNull(), wait)
  })

  it('in TroyMitchellDefault: 取消 aborts the signal the job was started with', async () => {
    const { ViewPanel } = await import('../frontends/troy-mitchell-default/render.tsx')
    const { view, seen } = waitingJob()
    const said: string[] = []
    const onRun = async (label: string, fn: () => Promise<unknown>) => { said.push(String(await fn().catch((error: Error) => `失败：${error.message}`))) }
    render(createElement(ViewPanel, { view, onRun, onPrompt: () => {} }))
    fireEvent.click(await screen.findByRole('button', { name: '开始' }, wait))
    await waitFor(() => expect(seen.signal).not.toBeNull(), wait)
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: '取消' }, wait)) })
    expect(seen.signal!.aborted).toBe(true)
    await waitFor(() => expect(said).toEqual(['已取消']), wait)
  })
})

describe('a job that cannot be stopped is not offered as one', () => {
  it('in Modern: no 取消, and a failure is told as a failure, not as cancelled', async () => {
    const { ViewPanel } = await import('../frontends/modern/render.tsx')
    const { UIProvider } = await import('../frontends/modern/kit.tsx')
    const { view, seen } = waitingJob(false)
    render(createElement(UIProvider, null, createElement(ViewPanel, { view })))
    fireEvent.click(await screen.findByRole('button', { name: /开始/ }, wait))
    await waitFor(() => expect(seen.signal).not.toBeNull(), wait)
    expect(screen.queryByRole('button', { name: /取消/ })).toBeNull()
    await act(async () => { seen.fail!(new Error('主机连不上')) })
    await waitFor(() => expect(document.querySelector('.toast.error')?.textContent).toContain('主机连不上'), wait)
    expect(document.body.textContent).not.toContain('已取消')
  })

  it('in TroyMitchellDefault: no 取消, and a failure is told as a failure', async () => {
    const { ViewPanel } = await import('../frontends/troy-mitchell-default/render.tsx')
    const { view, seen } = waitingJob(false)
    const said: string[] = []
    const onRun = async (_label: string, fn: () => Promise<unknown>) => { said.push(String(await fn().catch((error: Error) => `失败：${error.message}`))) }
    render(createElement(ViewPanel, { view, onRun, onPrompt: () => {} }))
    fireEvent.click(await screen.findByRole('button', { name: '开始' }, wait))
    await waitFor(() => expect(seen.signal).not.toBeNull(), wait)
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
    await act(async () => { seen.fail!(new Error('主机连不上')) })
    await waitFor(() => expect(said).toEqual(['失败：主机连不上']), wait)
  })

  it('the scan says it can be stopped, and settles once it is', async () => {
    const { ui } = await import('../src/modules/local/ui.ts')
    const page = { ...state, slots: [{ slot: 1, canFastboot: true }], scan: null, boards: state.boards.map(board => ({ ...board, lease: null })) } as never
    const scan = ui.views(page, {}).find(view => view.id === 'scan')!
    const start = (scan.body.find(element => element.kind === 'actions') as { actions: Array<{ id: string, kind: string, cancellable?: boolean, start?: Function }> }).actions.find(op => op.id === 'scan')!
    expect(start).toMatchObject({ kind: 'job', cancellable: true })
    const stop = new AbortController()
    const running = (start.start as (input: unknown, sink: unknown, signal: AbortSignal) => Promise<unknown>)({ slots: ['1'] }, { line: () => {}, progress: () => {} }, stop.signal)
    await waitFor(() => expect(calls.some(call => call.path === 'api/scan')).toBe(true), wait)
    stop.abort()
    await expect(running).rejects.toThrow(/已取消/)
    expect(calls.some(call => call.path === 'api/scan/cancel')).toBe(true)
  })

  it('a first bsp install the page left does not remove the lab boardd is still installing', async () => {
    const { ui } = await import('../src/modules/bsp/ui.ts')
    const views = ui.views(state as never, {})
    const find = (elements: unknown[]): { submit: { id: string, start: Function, cancellable?: boolean } } | null => {
      for (const element of elements as Array<Record<string, unknown>>) {
        if (element.kind === 'form' && (element.submit as { id?: string })?.id === 'install' && (element.submitLabel === '添加并安装')) return element as never
        for (const key of ['body', 'fallback']) if (Array.isArray(element[key])) { const found = find(element[key] as unknown[]); if (found) return found }
      }
      return null
    }
    const opener = views.flatMap(view => view.body).flatMap(element => (element as { actions?: Array<{ kind: string, body?: () => unknown[] }> }).actions ?? []).find(op => op.kind === 'open' && find(op.body!()))
    const form = find(views.flatMap(view => view.body)) ?? (opener ? find(opener.body!()) : null)
    expect(form).toBeTruthy()
    // It cannot be stopped on boardd, so the page does not offer it as cancellable.
    expect(form!.submit.cancellable).toBeFalsy()
    const original = globalThis.fetch
    const stop = new AbortController()
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('api/bsp/install')) {
        calls.push({ method: 'POST', path: 'api/bsp/install', body: null })
        return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
      }
      return original(input, init)
    }) as typeof fetch
    try {
      calls.length = 0
      const running = form!.submit.start({ id: 'newlab', address: 'host.test', user: 'root' }, { line: () => {}, progress: () => {} }, stop.signal) as Promise<unknown>
      await waitFor(() => expect(calls.some(call => call.path === 'api/bsp/install')).toBe(true), wait)
      stop.abort()
      await running.catch(() => {})
      expect(calls.some(call => call.path === 'api/labs/remove')).toBe(false)
    } finally { globalThis.fetch = original }
  })
})

describe('a board operation boardd cancelled', () => {
  it('in TroyMitchellDefault: is told in boardd\'s words, not as an error', async () => {
    const { outcome } = await import('../frontends/troy-mitchell-default/main.tsx')
    const { ApiError } = await import('../src/ui/api.ts')
    expect(await outcome('完成', async () => { throw new ApiError(409, '已取消：bsp-k3-deb1 的启动被 user:alice 取消了', 'cancelled') }))
      .toEqual({ text: '已取消：bsp-k3-deb1 的启动被 user:alice 取消了', error: false })
    expect(await outcome('完成', async () => { throw new ApiError(502, '没有加载成功', 'hardware') })).toEqual({ text: '没有加载成功', error: true })
  })

  it('carries boardd\'s code on the error the page gets', async () => {
    const { call, isCancelled } = await import('../src/ui/api.ts')
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: '已取消：启动', code: 'cancelled' }), { status: 409, headers: { 'content-type': 'application/json' } })) as typeof fetch
    try {
      const error = await call('POST', 'api/boot/sdk', {}).catch(failure => failure)
      expect(error).toMatchObject({ status: 409, code: 'cancelled', message: '已取消：启动' })
      expect(isCancelled(error)).toBe(true)
    } finally { globalThis.fetch = original }
  })

  it('in Modern: a neutral 已取消 toast, and the stop button says it is stopping, in boardd\'s words', async () => {
    const { useBoardActions } = await import('../frontends/modern/actions.tsx')
    const { UIProvider } = await import('../frontends/modern/kit.tsx')
    const board = state.boards.find(item => item.name === 'bsp-k1-flash')!
    const original = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = String(input)
      if (path.includes('api/boot/sdk')) return new Response(JSON.stringify({ error: '已取消：bsp-k1-flash 的启动被 user:alice 取消了', code: 'cancelled' }), { status: 409, headers: { 'content-type': 'application/json' } })
      if (path.includes('api/cancel')) return new Response(JSON.stringify({ message: '让 bsp-k1-flash 的刷机停下：正在做的那一步结束后就停', cancelled: true }), { headers: { 'content-type': 'application/json' } })
      return original(input)
    }) as typeof fetch
    function Buttons() {
      const act = useBoardActions(board)
      return createElement('div', null, createElement('button', { onClick: () => void act.boot('sdk-a', 'load') }, '启动它'), createElement('button', { onClick: () => void act.cancel() }, '停它'))
    }
    try {
      render(createElement(UIProvider, null, createElement(Buttons)))
      fireEvent.click(screen.getByRole('button', { name: '启动它' }))
      await waitFor(() => expect(document.querySelector('.toast')?.textContent).toContain('内存启动已取消'), wait)
      expect(document.querySelector('.toast.error')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: '停它' }))
      await waitFor(() => expect(document.body.textContent).toContain('BSP-K1-FLASH 正在停下'), wait)
      expect(document.body.textContent).toContain('正在做的那一步结束后就停')
      expect(document.body.textContent).not.toContain('停下了')
    } finally { globalThis.fetch = original }
  })
})

describe('a busy board has a stop button when what runs can be stopped', () => {
  it('in TroyMitchellDefault: shows 停止 on the card and asks boardd to cancel', async () => {
    const { BoardsTab } = await import('../frontends/troy-mitchell-default/views/boards.tsx')
    const flash = state.boards.find(board => board.name === 'bsp-k1-flash')!
    const run = async (_label: string, fn: () => Promise<unknown>) => { await fn() }
    // A boardd with only a lab opens on that lab's boards.
    const page = { ...state, boards: state.boards.filter(board => board.lab), slots: [], scan: null, ha: null } as never
    const drawn = render(createElement(BoardsTab, { state: page, busy: false, onPrompt: () => {}, onRun: run, onConsole: () => {}, onTab: () => {} }))
    const card = await waitFor(() => { const el = document.querySelector('[data-board="bsp-k1-flash"]'); expect(el).toBeTruthy(); return el as HTMLElement }, wait)
    expect(card.textContent).toContain('刷机中：flash rootfs')
    calls.length = 0
    fireEvent.click(within(card).getByRole('button', { name: '停止' }))
    await waitFor(() => expect(calls.some(call => call.path === 'api/cancel' && (call.body as { target?: string }).target === 'bsp-k1-flash')).toBe(true), wait)
    // What cannot be stopped halfway has no button.
    drawn.unmount()
    flash.busy = { ...flash.busy!, cancellable: false }
    try {
      render(createElement(BoardsTab, { state: page, busy: false, onPrompt: () => {}, onRun: run, onConsole: () => {}, onTab: () => {} }))
      const again = await waitFor(() => { const el = document.querySelector('[data-board="bsp-k1-flash"]'); expect(el).toBeTruthy(); return el as HTMLElement }, wait)
      expect(within(again).queryByRole('button', { name: '停止' })).toBeNull()
    } finally { flash.busy = { ...flash.busy!, cancellable: true } }
  })

  it('in Modern: a cancellable busy entry of any kind offers 取消 to its holder, and none otherwise', async () => {
    const { canStop } = await import('../frontends/modern/views/board.tsx')
    const { model } = await import('../frontends/modern/kit.tsx')
    const flash = state.boards.find(board => board.name === 'bsp-k1-flash')!
    const as = (busy: typeof flash.busy, lease = flash.lease, you = flash.lease!.holder) => { const board = { ...flash, busy, lease }; return canStop(board, model(board, you)) }
    for (const kind of ['boot', 'reset', 'fastboot', 'refresh', 'discover', 'install']) expect(as({ ...flash.busy!, kind, cancellable: true })).toBe(true)
    expect(as({ ...flash.busy!, cancellable: false })).toBe(false)
    expect(as({ ...flash.busy!, cancellable: true }, flash.lease, 'user:someone-else')).toBe(false)
    expect(as({ ...flash.busy!, cancellable: true }, null, 'user:someone-else')).toBe(true)
    expect(as(null)).toBe(false)
  })
})
