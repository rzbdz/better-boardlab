// @vitest-environment jsdom
/**
 * The console's floating "to the newest output" button: hidden at the bottom, shown when scrolled up with the lines that
 * arrived since, a click goes to the bottom, a press that moves drags it (and is not a click) and its place is kept.
 */
import { act, fireEvent, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const term = vi.hoisted(() => ({
  scroll: [] as Array<() => void>, parsed: [] as Array<() => void>,
  buffer: { active: { viewportY: 0, baseY: 0, length: 0 } as { viewportY: number, baseY: number, length: number } },
  // What the scrollbar can say: a bar pinned to its box (one xterm never measured) reports no position at all.
  viewport: { scrollHeight: 1000, clientHeight: 500 },
  viewportEl: null as null | HTMLElement,
  scrollToBottom: vi.fn(), focus: vi.fn(), resized: [] as Array<[number, number]>,
  keys: null as null | ((event: KeyboardEvent) => boolean), clearSelection: vi.fn(),
}))
/** The search addon: what was asked of it, and its results event, fired as the real one does. */
const finder = vi.hoisted(() => ({
  asked: [] as Array<[string, string, Record<string, unknown>]>, results: [] as Array<(r: { resultIndex: number, resultCount: number }) => void>,
  cleared: 0, count: 3,
}))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80; rows = 24
    get buffer() { return term.buffer }
    loadAddon() {} write() {} clear() {} dispose() {} onData() {}
    open(parent: HTMLElement) {
      // An element that stands in for the bar's box, with the two heights the code asks it for.
      const box = document.createElement('div')
      box.className = 'xterm-viewport'
      Object.defineProperty(box, 'scrollHeight', { get: () => term.viewport.scrollHeight, configurable: true })
      Object.defineProperty(box, 'clientHeight', { get: () => term.viewport.clientHeight, configurable: true })
      term.viewportEl = box
      parent.appendChild(box)
    }
    attachCustomKeyEventHandler(fn: (event: KeyboardEvent) => boolean) { term.keys = fn }
    clearSelection() { term.clearSelection() }
    onScroll(fn: () => void) { term.scroll.push(fn) }
    onWriteParsed(fn: () => void) { term.parsed.push(fn) }
    scrollToBottom() { term.scrollToBottom(); term.buffer.active.viewportY = term.buffer.active.baseY; term.scroll.forEach(fn => fn()) }
    scrollToLine(line: number) { term.buffer.active.viewportY = line }
    resize(cols: number, rows: number) { term.resized.push([cols, rows]); this.cols = cols; this.rows = rows }
    focus() { term.focus() }
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  // A resize that really changes the grid: null leaves `fit()` doing nothing beyond its `settle()`, which cannot tell
  // a fit that resized from one that did not.
  FitAddon: class { proposeDimensions() { return { cols: 100, rows: 30 } } },
}))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    private index = -1
    private found(text: string, way: string, options: Record<string, unknown>) {
      finder.asked.push([way, text, options])
      const count = text === 'nothing' ? 0 : finder.count
      this.index = count ? (way === 'next' ? (this.index + 1) % count : (this.index - 1 + count) % count) : -1
      finder.results.forEach(fn => fn({ resultIndex: this.index, resultCount: count }))
      return count > 0
    }
    findNext(text: string, options: Record<string, unknown>) { return this.found(text, 'next', options) }
    findPrevious(text: string, options: Record<string, unknown>) { return this.found(text, 'previous', options) }
    clearDecorations() { finder.cleared++ }
    onDidChangeResults(fn: (r: { resultIndex: number, resultCount: number }) => void) { finder.results.push(fn) }
  },
}))
vi.mock('../src/ui/console-session.ts', () => ({
  createConsoleSession: () => ({ input: () => {}, reconnect: () => {}, dispose: () => {} }),
  consoleErrorText: (e: unknown) => String(e),
  CONSOLE_WORDS: { connecting: '连接中', live: '实时', closed: '串口断开，重连中', retry: '重连中' },
}))

// jsdom has no PointerEvent: one built on MouseEvent carries the coordinates and the pointer id, as a browser's does.
globalThis.PointerEvent ??= class extends MouseEvent { pointerId: number; constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 0 } } as unknown as typeof PointerEvent
globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver

/** The browsers' ResizeObserver callback, so a test can say "the box changed size" (a window resize, full screen). */
const boxes = new Set<() => void>()
globalThis.ResizeObserver = class {
  private readonly fn: () => void
  constructor(fn: () => void) { this.fn = fn; boxes.add(fn) }
  observe() {} unobserve() {}
  disconnect() { boxes.delete(this.fn) }
} as unknown as typeof ResizeObserver
/** Tell the console its box was resized, then let the fit scheduled for the next frame run. */
const boxResized = () => act(async () => { boxes.forEach(fn => fn()); await new Promise(done => setTimeout(done, 40)) })
// jsdom lays nothing out: the fit skips a box with no size, so the tests give every element the size a page would.
for (const [property, value] of [['clientWidth', 816], ['clientHeight', 616]] as const) {
  Object.defineProperty(HTMLElement.prototype, property, { get: () => value, configurable: true })
}

const { SerialConsole, searchConsole } = await import('../src/ui/console.tsx')
const emit = (list: Array<() => void>) => act(() => { list.forEach(fn => fn()) })

describe('the console\'s place in its output', () => {
  it('starts on the newest output, and a flick before the scrollbar can say where it is does not send it to the top', async () => {
    // The scrollbar xterm never measured reads every scroll as line 0: this is the "随便滚一下就到顶" complaint.
    term.buffer.active.length = 400
    term.viewport = { scrollHeight: 500, clientHeight: 500 }
    const { container } = render(<SerialConsole board="place-a" dark={false} jumpClassName="jump" />)
    await act(async () => {})
    // Entering: the view is on the newest output.
    expect(term.scrollToBottom).toHaveBeenCalled()
    const at = term.scrollToBottom.mock.calls.length
    // xterm reads the flick as line 0 off a bar that cannot show the buffer.
    term.buffer.active.viewportY = 0; term.buffer.active.baseY = 370; emit(term.scroll)
    // The view is put back, and the button does not offer to take the person "back" from where they never were.
    expect(term.scrollToBottom.mock.calls.length).toBe(at + 1)
    expect(term.buffer.active.viewportY).toBe(370)
    expect(container.querySelector('.jump')).toBeNull()
  })

  it('comes back to the newest output after the console is taken off the page and put back', async () => {
    term.buffer.active.length = 400
    term.buffer.active.baseY = 370; term.buffer.active.viewportY = 370
    const { container, unmount } = render(<SerialConsole board="place-b" dark={false} jumpClassName="jump" />)
    await act(async () => {})
    // A person reads some scrollback, then leaves the page (another board, the log tab): unmounting keeps the console.
    term.buffer.active.viewportY = 200; emit(term.scroll)
    unmount()
    term.scrollToBottom.mockClear()
    // Back on a board: a following console is on the newest output again.
    const { container: again } = render(<SerialConsole board="place-b" dark={false} jumpClassName="jump" />)
    await act(async () => {})
    expect(term.scrollToBottom).toHaveBeenCalled()
    expect(again.querySelector('.jump')).toBeNull()
  })

  it('keeps a person reading scrollback where they are, and counts what arrives below', async () => {
    term.buffer.active.length = 400
    term.buffer.active.baseY = 100; term.buffer.active.viewportY = 100
    term.viewport = { scrollHeight: 1000, clientHeight: 500 }
    const { container } = render(<SerialConsole board="place-c" dark={false} jumpClassName="jump" />)
    await act(async () => {})
    // A real scroll up on a bar that can say where it is: the person stays, and the button appears.
    term.buffer.active.viewportY = 40; emit(term.scroll)
    expect(term.buffer.active.viewportY).toBe(40)
    expect(container.querySelector('.jump')).toBeTruthy()
    const at = term.scrollToBottom.mock.calls.length
    // Output while reading does not pull the view down.
    term.buffer.active.baseY = 130; emit(term.parsed)
    expect(term.buffer.active.viewportY).toBe(40)
    expect(term.scrollToBottom.mock.calls.length).toBe(at)
    expect(container.querySelector('.jump')!.textContent).toContain('30 行新输出')
  })

  it('does not pull a person reading scrollback to the newest output when the box is resized', async () => {
    // A window resize or full screen re-fits the console; that must not move a view the person put somewhere.
    term.buffer.active.length = 400
    term.buffer.active.baseY = 300; term.buffer.active.viewportY = 300
    term.viewport = { scrollHeight: 1000, clientHeight: 500 }
    const { container } = render(<SerialConsole board="place-d" dark={false} jumpClassName="jump" />)
    await act(async () => {})
    term.buffer.active.viewportY = 120; emit(term.scroll)
    expect(container.querySelector('.jump')).toBeTruthy()
    term.scrollToBottom.mockClear()
    await boxResized()
    expect(term.buffer.active.viewportY).toBe(120)
    expect(term.scrollToBottom).not.toHaveBeenCalled()
    expect(container.querySelector('.jump')).toBeTruthy()
  })
})

describe('the console\'s jump-to-bottom button', () => {
  beforeEach(() => {
    term.buffer.active.viewportY = 0; term.buffer.active.baseY = 0; term.buffer.active.length = 0
    term.viewport = { scrollHeight: 1000, clientHeight: 500 }
    // Every console a test opened is kept alive (the page keeps them per board); only this test's is told anything.
    term.scroll.length = 0; term.parsed.length = 0
    term.scrollToBottom.mockClear(); term.resized.length = 0; localStorage.clear()
  })

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
    const before = term.scrollToBottom.mock.calls.length
    fireEvent.pointerDown(b, { button: 0, pointerId: 1, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(b, { button: 0, pointerId: 1, clientX: 51, clientY: 50 })
    expect(term.scrollToBottom.mock.calls.length).toBeGreaterThan(before)
    expect(term.buffer.active.viewportY).toBe(112)
    expect(container.querySelector('.jump')).toBeNull()
  })

  it('is dragged by a press that moves, which is not a click, and keeps its place', async () => {
    const { container } = render(<SerialConsole board="jump-b" dark={false} jumpClassName="jump" />)
    await act(async () => {})
    term.buffer.active.baseY = 50; term.buffer.active.viewportY = 10; emit(term.scroll)
    const before = term.scrollToBottom.mock.calls.length
    const box = container.firstElementChild as HTMLElement
    box.getBoundingClientRect = () => ({ left: 0, top: 0, width: 816, height: 616, right: 816, bottom: 616, x: 0, y: 0, toJSON() {} })
    const button = container.querySelector('.jump') as HTMLButtonElement
    button.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} })
    fireEvent.pointerDown(button, { button: 0, pointerId: 2, clientX: 700, clientY: 500 })
    fireEvent.pointerMove(button, { pointerId: 2, clientX: 408, clientY: 308 })
    fireEvent.pointerUp(button, { button: 0, pointerId: 2, clientX: 408, clientY: 308 })
    expect(term.scrollToBottom.mock.calls.length).toBe(before)
    expect(JSON.parse(localStorage.getItem('boardlab.console.jump')!)).toEqual({ x: 0.5, y: 0.5 })
    expect((container.querySelector('.jump') as HTMLElement).style.left).toContain('0.5')
  })
})

describe('the console\'s search', () => {
  it('opens on Ctrl+F, highlights as the person types, steps through the matches and says which of how many', async () => {
    finder.asked.length = 0
    const { container } = render(<SerialConsole board="find-a" dark={false} searchClassName="tsearch" />)
    await act(async () => {})
    expect(container.querySelector('.tsearch')).toBeNull()
    // Ctrl+F in the console is not typed to the board: the search opens.
    let typed = true
    act(() => { typed = term.keys!(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true })) })
    expect(typed).toBe(false)
    const input = container.querySelector('.tsearch input') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(term.keys!(new KeyboardEvent('keydown', { key: 'f' }))).toBe(true)
    fireEvent.change(input, { target: { value: 'mmc0' } })
    expect(finder.asked.at(-1)).toEqual(['next', 'mmc0', expect.objectContaining({ regex: false, caseSensitive: false, incremental: true, decorations: expect.objectContaining({ activeMatchBackground: expect.any(String) }) })])
    expect(container.querySelector('.tsearch .count')!.textContent).toBe('1 / 3')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(container.querySelector('.tsearch .count')!.textContent).toBe('2 / 3')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(finder.asked.at(-1)![0]).toBe('previous')
    expect(container.querySelector('.tsearch .count')!.textContent).toBe('1 / 3')
    // Regex and case go to the search; a bad regex is not searched.
    fireEvent.click(container.querySelector('.tsearch button[title="正则"]')!)
    expect(finder.asked.at(-1)![2]).toMatchObject({ regex: true })
    const before = finder.asked.length
    fireEvent.change(input, { target: { value: 'mmc(' } })
    expect(finder.asked.length).toBe(before)
    expect(input.className).toBe('bad')
    fireEvent.change(input, { target: { value: 'nothing' } })
    expect(container.querySelector('.tsearch .count')!.textContent).toBe('没有匹配')
    // Esc closes it and takes the highlights away.
    const cleared = finder.cleared
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(container.querySelector('.tsearch')).toBeNull()
    expect(finder.cleared).toBeGreaterThan(cleared)
  })

  it('opens from a frontend\'s button, and hands the search to the whole log', async () => {
    const history = vi.fn()
    const { container } = render(<SerialConsole board="find-b" dark={false} searchClassName="tsearch" onSearchHistory={history} />)
    await act(async () => {})
    act(() => searchConsole('find-b'))
    fireEvent.change(container.querySelector('.tsearch input')!, { target: { value: 'panic' } })
    fireEvent.click(container.querySelector('.tsearch button[title="正则"]')!)
    fireEvent.click(container.querySelector('.tsearch .wide')!)
    expect(history).toHaveBeenCalledWith('panic', true)
    expect(container.querySelector('.tsearch')).toBeNull()
  })
})
