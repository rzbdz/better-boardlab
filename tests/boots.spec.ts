// @vitest-environment jsdom
/** Boots: lines grouped into boots by stage order, the nearest boot line, the remembered choice, and the xterm addon. */
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { BootMarksAddon, bootNear, groupBoots, hiddenMarks, setHiddenMarks, type BootMark } from '../src/ui/boots.ts'

const MARKS: BootMark[] = [
  { id: 'rom', title: 'Boot ROM', pattern: 'ROM v\\d', stage: 0, tone: 'rom' },
  { id: 'spl', title: 'U-Boot SPL', pattern: 'U-Boot SPL \\d{4}\\.\\d{2}', stage: 1, tone: 'spl' },
  { id: 'opensbi', title: 'OpenSBI', pattern: 'OpenSBI v\\d', stage: 2, tone: 'firmware' },
  { id: 'linux', title: 'Linux', pattern: 'Linux version \\d', stage: 4, tone: 'kernel' },
]

describe('boots', () => {
  it('groups boot lines into boots: a stage no later than the one before starts a new boot', () => {
    const lines = [
      { line: 1, id: 'rom', text: '' }, { line: 5, id: 'spl', text: '' }, { line: 9, id: 'linux', text: '' },
      // Reset in Linux: the SPL again.
      { line: 30, id: 'spl', text: '' }, { line: 33, id: 'opensbi', text: '' },
      // A kernel restarting on its own (kexec, a watchdog without a full reset).
      { line: 50, id: 'linux', text: '' }, { line: 70, id: 'linux', text: '' },
    ]
    expect(groupBoots(lines, MARKS).map(boot => [boot.number, boot.line, boot.stages.map(stage => stage.id)])).toEqual([
      [1, 1, ['rom', 'spl', 'linux']], [2, 30, ['spl', 'opensbi', 'linux']], [3, 70, ['linux']],
    ])
    expect(bootNear(lines, 30, 'next')!.line).toBe(33)
    expect(bootNear(lines, 30, 'previous')!.line).toBe(9)
    expect(bootNear(lines, 70, 'next')).toBeNull()
    expect(bootNear(lines, 1, 'previous')).toBeNull()
  })

  it('remembers which stages a console shows, each console its own', () => {
    localStorage.clear()
    expect(hiddenMarks('b1', 'die0')).toEqual([])
    setHiddenMarks('b1', 'die0', ['spl', 'opensbi'])
    expect(hiddenMarks('b1', 'die0')).toEqual(['spl', 'opensbi'])
    expect(hiddenMarks('b1', 'die1')).toEqual([])
    setHiddenMarks('b1', 'die0', [])
    expect(localStorage.getItem('boardlab.boots.shown')).toBe('{}')
    localStorage.setItem('boardlab.boots.shown', 'not json')
    expect(hiddenMarks('b1', 'die0')).toEqual([])
  })
})

describe('the boot marks addon', () => {
  const write = (term: Terminal, text: string) => new Promise<void>(resolve => term.write(text, resolve))

  it('finds boot lines as the console writes them, on the lines where they are, and follows them as the scrollback drops its oldest', async () => {
    const term = new Terminal({ cols: 80, rows: 5, scrollback: 20, allowProposedApi: true })
    term.open(document.createElement('div'))
    const addon = new BootMarksAddon()
    term.loadAddon(addon)
    let changes = 0
    addon.onChange(() => changes++)
    // Lines written before the marks are known are found when they come.
    await write(term, 'ROM v2.1\r\nnoise\r\n')
    addon.setMarks(MARKS)
    expect(addon.lines.map(line => [line.id, line.marker.line])).toEqual([['rom', 0]])
    await write(term, 'U-Boot SPL 2022.10 (Nov 10 2026)\r\nmore\r\nLinux version 6.6.36 (b@h)\r\n')
    expect(addon.lines.map(line => [line.id, line.marker.line])).toEqual([['rom', 0], ['spl', 2], ['linux', 4]])
    expect(changes).toBeGreaterThanOrEqual(2)
    // An unfinished line is matched once it is finished, and only once.
    await write(term, 'OpenSBI v1')
    expect(addon.lines).toHaveLength(3)
    await write(term, '.3\r\n')
    await write(term, 'x\r\n')
    expect(addon.lines.map(line => line.id)).toEqual(['rom', 'spl', 'linux', 'opensbi'])
    // Twenty-five lines later the scrollback (20 + 5 rows) has dropped the first ones: their marks go, the rest move up.
    for (let i = 0; i < 25; i++) await write(term, `line ${i}\r\n`)
    const kept = addon.lines.map(line => [line.id, line.marker.line])
    expect(kept.every(([, line]) => (line as number) >= 0)).toBe(true)
    expect(kept.length).toBeLessThan(4)
    // Cleared: nothing.
    term.clear(); addon.reset()
    expect(addon.lines).toHaveLength(0)
    term.dispose()
  })

  it('counts a boot once when its screen is erased and redrawn, as a boot menu does', async () => {
    const term = new Terminal({ cols: 80, rows: 5, scrollback: 500, allowProposedApi: true })
    term.open(document.createElement('div'))
    const addon = new BootMarksAddon()
    term.loadAddon(addon)
    addon.setMarks(MARKS)
    // A boot whose banner scrolls up out of the screen, then a menu that clears the screen and redraws itself on the
    // same rows (GRUB's countdown, EDK II's boot menu): the banner is still in the scrollback, the menu is on screen.
    for (let i = 0; i < 8; i++) await write(term, `noise ${i}\r\n`)
    await write(term, 'ROM v2.1\r\nU-Boot SPL 2022.10 (Nov 10 2026)\r\n')
    for (let i = 0; i < 12; i++) await write(term, `kernel ${i}\r\n`)
    for (let second = 5; second > 0; second--) await write(term, `\x1b[2J\x1b[01;01H\rGNU GRUB  version 2.14\r\n\r\n\r\n  Boot in ${second}s\r\n`)
    await write(term, '\r\nLinux version 6.6.36 (b@h)\r\n')
    // Each redraw erased the screen under the scan's own place, and the banner — still in the buffer — is one line
    // each, not one more for every redraw.
    expect(addon.lines.map(line => line.id)).toEqual(['rom', 'spl', 'linux'])
    // What it says is what the buffer holds, each line once, however often the menu redrew and however often the scan
    // had to start over: no line of the buffer is reported twice.
    const reported = addon.lines.map(line => line.marker.line).filter(line => line >= 0)
    expect(new Set(reported).size).toBe(reported.length)
    // And it keeps finding lines after the menu: a boot line written at the very end is found there, once.
    await write(term, '\r\nROM v2.1\r\n')
    const last = term.buffer.active.baseY + term.buffer.active.cursorY - 1
    expect(addon.lines.at(-1)).toMatchObject({ id: 'rom' })
    expect(addon.lines.at(-1)!.marker.line).toBe(last)
    expect(addon.lines.filter(line => line.id === 'rom')).toHaveLength(2)
    term.dispose()
  })

  it('reads only what is new: a clear after a long log costs a screen, not the log', async () => {
    const term = new Terminal({ cols: 80, rows: 10, scrollback: 20_000, allowProposedApi: true })
    term.open(document.createElement('div'))
    const addon = new BootMarksAddon()
    term.loadAddon(addon)
    addon.setMarks(MARKS)
    // A GRUB-style countdown after 5,000 lines: each redraw clears the screen, and none may make the scan read the
    // scrollback again (that rescan was what made the detail page cost so much on a console with a long log). Written
    // in batches: what is timed is the scan, not a promise resolved per line.
    for (let at = 0; at < 5000; at += 500) await write(term, Array.from({ length: 500 }, (_, i) => `kernel ${at + i}\r\n`).join(''))
    expect(term.buffer.active.length).toBeGreaterThan(4000)
    let reads = 0
    const line = term.buffer.active.getLine.bind(term.buffer.active)
    ;(term.buffer.active as unknown as { getLine: (y: number) => unknown }).getLine = (y: number) => { reads++; return line(y) }
    for (let second = 10; second > 0; second--) await write(term, `\x1b[2J\x1b[01;01H\rGNU GRUB  version 2.14\r\n\r\n  Boot in ${second}s\r\n`)
    // Each redraw reads the screen it rewrote (a few rows a scan), not the thousands of lines behind it.
    expect(reads).toBeLessThan(1000)
    term.dispose()
  })

  it('counts each boot line once when the scrollback drops its oldest, and matches what the buffer holds', async () => {
    const term = new Terminal({ cols: 80, rows: 5, scrollback: 30, allowProposedApi: true })
    term.open(document.createElement('div'))
    const addon = new BootMarksAddon()
    term.loadAddon(addon)
    addon.setMarks(MARKS)
    for (let i = 0; i < 60; i++) {
      await write(term, `ROM v2\r\nnoise ${i}\r\nmore\r\n`)
      if (i % 7 === 0) await write(term, 'U-Boot SPL 2022.10 (x)\r\n')
    }
    // Every line still in the buffer is listed, each once: no line twice for having been read again, none left out for
    // having moved up as the oldest went.
    const buffer = term.buffer.active, now: number[] = []
    for (let y = 0; y < buffer.length; y++) if (/ROM v\d|U-Boot SPL \d{4}\.\d{2}|Linux version \d|OpenSBI v\d/.test(buffer.getLine(y)?.translateToString(true) ?? '')) now.push(y)
    const listed = addon.lines.map(line => line.marker.line)
    expect(new Set(listed).size).toBe(listed.length)
    expect([...listed].sort((a, b) => a - b)).toEqual(now)
    term.dispose()
  })
})
