// @vitest-environment jsdom
/** The 板子 tab's memory: the board last looked at, which a press from another page returns to (src/ui/nav.ts). */
import { beforeEach, describe, expect, it } from 'vitest'
import { forgetBoard, lastBoard, visitBoard } from '../src/ui/nav.ts'

describe('the board tab', () => {
  beforeEach(() => localStorage.clear())

  it('remembers the board opened, and forgets one that is gone', () => {
    expect(lastBoard('k')).toBeNull()
    visitBoard('k', 'board-1')
    expect(lastBoard('k')).toBe('board-1')
    visitBoard('k', 'board-2')
    expect(lastBoard('k')).toBe('board-2')
    // Only the board it names goes: another board's page keeps the memory.
    forgetBoard('k', 'board-1')
    expect(lastBoard('k')).toBe('board-2')
    forgetBoard('k', 'board-2')
    expect(lastBoard('k')).toBeNull()
  })

  it('keeps each frontend\'s memory apart', () => {
    visitBoard('modern', 'a')
    visitBoard('troy', 'b')
    expect([lastBoard('modern'), lastBoard('troy')]).toEqual(['a', 'b'])
  })
})
