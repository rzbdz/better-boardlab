// @vitest-environment jsdom
/** The partition map: blocks at true scale, ticks at the boundaries, the written lane narrowed to the chosen partitions, a legend row lighting its block. */
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { FlashPlan } from 'boardlab-core/shared/types.ts'
import { PlanMap, sizeText } from '../frontends/modern/flashmap.tsx'

const MiB = 2 ** 20
const plan: FlashPlan = {
  package: 'pkg.zip', partial: true, notes: [],
  media: [
    { id: 'disk', label: 'disk · 8 MiB', size: 8 * MiB, partitions: [
      { name: 'boot', offset: 0, size: 2 * MiB, image: 'boot.img', payload: MiB, selectable: true },
      { name: 'root', offset: 2 * MiB, size: null, image: 'root.img', payload: 3 * MiB, selectable: true },
    ] },
    { id: 'empty', label: 'nothing placed', size: null, partitions: [{ name: 'env', offset: null, size: null, image: null, payload: null, selectable: false }] },
  ],
}

describe('partition map', () => {
  it('writes sizes as people read them', () => {
    expect([sizeText(null), sizeText(512), sizeText(1536), sizeText(2 * MiB), sizeText(2.5 * 2 ** 30)]).toEqual(['—', '512 B', '1.5 KiB', '2 MiB', '2.5 GiB'])
  })

  it('draws each medium at true scale, a partition without a size running to the end, with a tick at every inner boundary', () => {
    const { container } = render(<PlanMap plan={plan} />)
    const maps = container.querySelectorAll('.fl-map')
    expect(maps).toHaveLength(2)
    const [table, written] = [...maps[0]!.querySelectorAll('.fl-map-track')]
    const widths = (track: Element) => [...track.querySelectorAll('span')].map(block => [block.textContent, (block as HTMLElement).style.left, (block as HTMLElement).style.width])
    expect(widths(table!)).toEqual([['boot', '0%', '25%'], ['root', '25%', '75%']])
    expect(widths(written!)).toEqual([['boot', '0%', '12.5%'], ['root', '25%', '37.5%']])
    expect([...table!.querySelectorAll('.fl-map-boundary')].map(tick => (tick as HTMLElement).style.left)).toEqual(['25%'])
    expect(maps[0]!.textContent).toContain('剩余空间 · 2 MiB–末尾')
    expect(maps[1]!.textContent).toContain('没有可以画出来的分区')
  })

  it('narrows what is written to the chosen partitions, and lights a block from its legend row', () => {
    const { container } = render(<PlanMap plan={plan} chosen={new Set(['root'])} />)
    const lanes = container.querySelectorAll('.fl-map')[0]!.querySelectorAll('.fl-map-lane')
    expect(lanes[1]!.querySelector('.fl-lane-label')!.textContent).toBe('将写入')
    expect([...lanes[1]!.querySelectorAll('.fl-map-track span')].map(block => block.textContent)).toEqual(['root'])
    const row = [...lanes[0]!.querySelectorAll('.fl-map-legend li')].find(item => item.textContent?.startsWith('boot'))!
    const block = [...lanes[0]!.querySelectorAll('.fl-map-track span')].find(item => item.textContent === 'boot')!
    fireEvent.mouseEnter(row)
    expect(block.getAttribute('data-highlight')).toBe('true')
    fireEvent.mouseLeave(row)
    expect(block.getAttribute('data-highlight')).toBe('false')
  })
})
