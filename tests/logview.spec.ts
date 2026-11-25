/** A long log as a page shows it: pages read once by line number, the lines in view, and going from match to match. */
import { describe, expect, it } from 'vitest'
import type { LogResult } from 'boardlab-core/shared/types.ts'
import { inView, isHit, KEEP_PAGES, LINE_MAX, LogPages, MAX_INFLIGHT, nextHit, PAGE, PAGE_BYTES } from '../src/ui/logview.ts'

/** A log of `total` lines numbered from `base`, read as boardd reads a window; every read is counted. */
function log(total: number, base = 0) {
  const asked: string[] = []
  const state = { base, total }
  const read = async (at: string, before: number, after: number): Promise<LogResult> => {
    asked.push(at)
    const n = Number(at.slice('line:'.length))
    const from = Math.max(state.base, n - before), to = Math.min(state.base + state.total, n + after + 1)
    const numbers = Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i)
    return { lines: numbers.map(i => `line ${i}`), numbers, positions: numbers.map(i => `p${i}`), matched: numbers.length, truncated: false, base: state.base, total: state.total, source: 'backend' }
  }
  return { asked, state, read }
}

describe('the pages of a log', () => {
  it('reads only the pages a range covers, each once however often it is asked', async () => {
    const fake = log(PAGE * 20)
    const pages = new LogPages(fake.read)
    pages.show(0, PAGE * 20)
    await Promise.all([pages.need(10, PAGE + 10), pages.need(PAGE / 2, PAGE / 2 + 10)])
    expect(fake.asked).toEqual(['line:0', `line:${PAGE}`])
    expect(pages.line(PAGE + 9)).toEqual({ number: PAGE + 9, text: `line ${PAGE + 9}`, position: `p${PAGE + 9}` })
    expect(pages.line(PAGE * 2)).toBeNull()
    await pages.need(PAGE + 10, PAGE + 20)
    expect(fake.asked).toHaveLength(2)
    // The end of the log is read in its own page, however long the log is.
    await pages.need(PAGE * 20 - 10, PAGE * 20)
    expect(fake.asked.at(-1)).toBe(`line:${PAGE * 19}`)
  })

  it('keeps showing a time range when a page it reads answers with the whole log\'s size', async () => {
    const state = { base: 0, total: 50_000 }
    const read = async (at: string): Promise<LogResult> => {
      const start = Number(at.slice('line:'.length))
      const numbers = Array.from({ length: PAGE }, (_, i) => start + i)
      // A window of the log says how big the log is — not what the list shows (the range boardd gave).
      return { lines: numbers.map(i => `line ${i}`), numbers, positions: [], matched: PAGE, truncated: false, base: state.base, total: state.total, source: 'backend' }
    }
    const pages = new LogPages(read)
    pages.show(47_300, 1_200)
    await pages.need(47_300, 47_400)
    expect([pages.base, pages.total]).toEqual([47_300, 1_200])
    expect(pages.line(47_301)?.text).toBe('line 47301')
    // A page of the log never read is not a line of the range, however near it.
    expect(pages.line(46_999)).toBeNull()
  })

  it('keeps a bounded number of pages, the ones used longest ago forgotten first', async () => {
    const fake = log(PAGE * (KEEP_PAGES + 10))
    const pages = new LogPages(fake.read)
    pages.show(0, PAGE * (KEEP_PAGES + 10))
    await pages.need(0, PAGE)
    for (let page = 1; page <= KEEP_PAGES + 5; page++) { pages.line(0); await pages.need(page * PAGE, page * PAGE + 1) }
    // The first page was used all along, so it stays; the ones read and left behind went.
    expect(pages.line(0)).not.toBeNull()
    expect(pages.line(PAGE)).toBeNull()
  })

  it('bounds what it keeps by bytes too, so very long lines cannot grow the page without limit', async () => {
    const asked: string[] = []
    const long = 'x'.repeat(LINE_MAX)
    const read = async (at: string): Promise<LogResult> => {
      asked.push(at)
      const start = Number(at.slice('line:'.length))
      const numbers = Array.from({ length: PAGE }, (_, i) => start + i)
      return { lines: numbers.map(() => long), numbers, positions: [], matched: PAGE, truncated: false, base: 0, total: PAGE * 10, source: 'backend' }
    }
    const pages = new LogPages(read)
    pages.show(0, PAGE * 10)
    await pages.need(0, PAGE)
    await pages.need(PAGE, PAGE * 2)
    // A page of the longest lines is cut to its share, so the pages a view spans always fit: nothing in view is pushed
    // out by a neighbour arriving, and a line keeps a readable piece rather than a stub.
    expect(pages.line(0)).not.toBeNull()
    expect(pages.line(PAGE)).not.toBeNull()
    const cut = pages.line(0)!.text.length
    expect(cut).toBeLessThan(LINE_MAX)
    // Its share on the budget, plus the two characters each cut line is marked with.
    expect(cut * 2 * PAGE).toBeLessThanOrEqual(PAGE_BYTES + 4 * PAGE)
  })

  it('cuts a line longer than it keeps, and says so', async () => {
    const read = async (): Promise<LogResult> => ({ lines: ['y'.repeat(LINE_MAX + 100)], numbers: [0], positions: [], matched: 1, truncated: false, base: 0, total: 1, source: 'backend' })
    const pages = new LogPages(read)
    pages.show(0, 1)
    await pages.need(0, 1)
    const line = pages.line(0)!
    expect(line.text).toHaveLength(LINE_MAX + 2)
    expect(line.text.endsWith(' …')).toBe(true)
  })

  it('reads ahead without waiting, and never more at once than boardd is asked for', async () => {
    const asked: string[] = []
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const read = async (at: string): Promise<LogResult> => {
      asked.push(at)
      await held
      return { lines: [], numbers: [], positions: [], matched: 0, truncated: false, base: 0, total: PAGE * 100, source: 'backend' }
    }
    const pages = new LogPages(read)
    pages.show(0, PAGE * 100)
    pages.prefetch(0, PAGE * 20)
    expect(asked).toHaveLength(MAX_INFLIGHT)
    // Asked again before it answers, the same page is not read twice.
    pages.prefetch(0, PAGE * 2)
    expect(asked).toHaveLength(MAX_INFLIGHT)
    release()
    await Promise.resolve()
  })

  it('reads the last page again when the log grows, and everything again when its oldest lines go', async () => {
    const fake = log(PAGE * 3)
    const pages = new LogPages(fake.read)
    pages.show(0, PAGE * 3)
    await pages.need(0, PAGE * 3)
    fake.state.total = PAGE * 3 + 10
    pages.show(0, PAGE * 3 + 10)
    await pages.need(0, PAGE * 3 + 10)
    expect(fake.asked).toEqual(['line:0', `line:${PAGE}`, `line:${PAGE * 2}`, `line:${PAGE * 2}`, `line:${PAGE * 3}`])
    expect(pages.line(PAGE * 3 + 9)?.text).toBe(`line ${PAGE * 3 + 9}`)
    fake.state.base = PAGE; fake.state.total = PAGE * 2
    pages.show(PAGE, PAGE * 2)
    expect(pages.line(PAGE + 50)).toBeNull()
  })
})

describe('the lines in view and the matches', () => {
  it('says which lines a scroll position shows, with some to spare on either side', () => {
    expect(inView(0, 400, 20, 0, 1000, 10)).toEqual({ from: 0, to: 30 })
    expect(inView(2000, 400, 20, 0, 1000, 10)).toEqual({ from: 90, to: 130 })
    expect(inView(19_900, 400, 20, 0, 1000, 10)).toEqual({ from: 985, to: 1000 })
    expect(inView(0, 400, 20, 500, 1000, 0)).toEqual({ from: 500, to: 520 })
  })

  it('goes to the next or previous match from where the page is, round at the ends', () => {
    const hits = [5, 40, 41, 900]
    expect([nextHit(hits, 0, 'next'), nextHit(hits, 5, 'next'), nextHit(hits, 41, 'next'), nextHit(hits, 900, 'next')]).toEqual([0, 1, 3, 0])
    expect([nextHit(hits, 41, 'previous'), nextHit(hits, 6, 'previous'), nextHit(hits, 5, 'previous')]).toEqual([1, 0, 3])
    expect(nextHit([], 3, 'next')).toBe(-1)
    expect([isHit(hits, 40), isHit(hits, 42), isHit([], 1)]).toEqual([true, false, false])
  })

  it('finds a match among a million in microseconds', () => {
    const hits = Array.from({ length: 1_000_000 }, (_, i) => i * 3)
    const start = performance.now()
    for (let i = 0; i < 10_000; i++) nextHit(hits, i * 97, 'next')
    expect(performance.now() - start).toBeLessThan(50)
  })
})
