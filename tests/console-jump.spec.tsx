// @vitest-environment jsdom
/**
 * The console's floating "to the newest output" button: hidden at the bottom, shown when scrolled up with the lines that
 * arrived since, a click goes to the bottom, a press that moves drags it (and is not a click) and its place is kept.
 */
import { act, fireEvent, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const term = vi.hoisted(() => ({
  scroll: [] as Array<() => void>, parsed: [] as Array<() => void>,
  buffer: { active: { viewportY: 0, baseY: 0 } },
  scrollToBottom: vi.fn(), focus: vi.fn(),
}))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80; rows = 24
    get buffer() { return term.buffer }
    loadAddon() {} open() {} write() {} clear() {} dispose() {} resize() {} onData() {}
    onScroll(fn: () => void) { term.scroll.push(fn) }
    onWriteParsed(fn: () => void) { term.parsed.push(fn) }
    scrollToBottom() { term.scrollToBottom(); term.buffer.active.viewportY = term.buffer.active.baseY; term.scroll.forEach(fn => fn()) }
    focus() { term.focus() }
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions() { return null } } }))
vi.mock('../src/ui/console-session.ts', () => ({
  createConsoleSession: () => ({ input: () => {}, reconnect: () => {}, dispose: () => {} }),
  consoleErrorText: (e: unknown) => String(e),
  CONSOLE_WORDS: { connecting: '连接中', live: '实时', closed: '串口断开，重连中', retry: '重连中' },
}))

// jsdom has no PointerEvent: one built on MouseEvent carries the coordinates and the pointer id, as a browser's does.
globalThis.PointerEvent ??= class extends MouseEvent { pointerId: number; constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 0 } } as unknown as typeof PointerEvent
globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver

const { SerialConsole } = await import('../src/ui/console.tsx')
const emit = (list: Array<() => void>) => act(() => { list.forEach(fn => fn()) })

describe('the console\'s jump-to-bottom button', () => {
  beforeEach(() => { term.buffer.active.viewportY = 0; term.buffer.active.baseY = 0; term.scrollToBottom.mockClear(); localStorage.clear() })

  it('shows only while scrolled up, counts what arrived, and goes to the bottom on a click', async () => {
    const { container } = render(<SerialConsole board="jump-a" dark={false} jumpClassName="jump" />)
    await act(async () => {})
    expect(container.querySelector('.jump')).toBeNull()
    // Output pushes the bottom down; the view follows: still at the bottom, no button.
    term.buffer.active.baseY = 100; term.buffer.active.viewportY = 100; emit(term.parsed)
    expect(container.querySelector('.jump')).toBeNull()
    // Scrolled up: the button, with nothing new yet.
    term.buffer.active.viewportY = 40; emit(term.scroll)
    const button = container.querySelector('.jump') as HTMLButtonElement
    expect(button).toBeTruthy()
    expect(button.className).not.toContain('has-new')
    // Twelve more lines while away.
    term.buffer.active.baseY = 112; emit(term.parsed)
    expect(container.querySelector('.jump')!.className).toContain('has-new')
    expect(container.querySelector('.jump')!.textContent).toContain('12 行新输出')
    // A click (a press that does not move) goes to the bottom, and the button leaves.
    const b = container.querySelector('.jump') as HTMLButtonElement
    fireEvent.pointerDown(b, { button: 0, pointerId: 1, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(b, { button: 0, pointerId: 1, clientX: 51, clientY: 50 })
    expect(term.scrollToBottom).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.jump')).toBeNull()
  })

  it('is dragged by a press that moves, which is not a click, and keeps its place', async () => {
    const { container } = render(<SerialConsole board="jump-b" dark={false} jumpClassName="jump" />)
    await act(async () => {})
    term.buffer.active.baseY = 50; term.buffer.active.viewportY = 10; emit(term.scroll)
    const box = container.firstElementChild as HTMLElement
    box.getBoundingClientRect = () => ({ left: 0, top: 0, width: 816, height: 616, right: 816, bottom: 616, x: 0, y: 0, toJSON() {} })
    const button = container.querySelector('.jump') as HTMLButtonElement
    button.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} })
    fireEvent.pointerDown(button, { button: 0, pointerId: 2, clientX: 700, clientY: 500 })
    fireEvent.pointerMove(button, { pointerId: 2, clientX: 408, clientY: 308 })
    fireEvent.pointerUp(button, { button: 0, pointerId: 2, clientX: 408, clientY: 308 })
    expect(term.scrollToBottom).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('boardlab.console.jump')!)).toEqual({ x: 0.5, y: 0.5 })
    expect((container.querySelector('.jump') as HTMLElement).style.left).toContain('0.5')
  })
})
