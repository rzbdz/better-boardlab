/** Serial log export and search, as every frontend uses them: the address, the wget command, and quick ranges. */
import { describe, expect, it } from 'vitest'
import { logs, rangeOf, stamp } from '../src/ui/logs.ts'

describe('serial logs', () => {
  const page = 'https://lab.example/boardlab/#boards'

  it('address the file from the page, behind a proxy path too', () => {
    expect(logs.url({ board: 'bsp-k3-a', since: '2026-11-10 08:00:00', until: '2026-11-10 09:00:00', grep: 'mmc0' }, page))
      .toBe('https://lab.example/boardlab/api/logs?board=bsp-k3-a&since=2026-11-10+08%3A00%3A00&until=2026-11-10+09%3A00%3A00&grep=mmc0&download=1')
  })

  it('give a wget command that keeps the server\'s file name and survives quotes in a search', () => {
    expect(logs.wget({ board: 'k1', grep: "it's" }, page)).toBe("wget --content-disposition 'https://lab.example/boardlab/api/logs?board=k1&grep=it%27s&download=1'")
  })

  it('turn quick ranges into stamps ending now', () => {
    const now = new Date(2026, 10, 10, 9, 30, 15)
    expect(stamp(now)).toBe('2026-11-10 09:30:15')
    expect(rangeOf(60, now)).toEqual({ since: '2026-11-10 08:30:15', until: '2026-11-10 09:30:15' })
    expect(rangeOf(-1, now)).toEqual({ since: '2026-11-10 00:00:00', until: '2026-11-10 09:30:15' })
    expect(rangeOf(null, now)).toEqual({})
  })
})
