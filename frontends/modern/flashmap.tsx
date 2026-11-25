/**
 * What a package would write, drawn as maps: one per medium, a lane for the partition table and one for what the
 * package writes into it, at true scale, with a tick at every boundary and a legend whose rows light up their block.
 * It draws a `FlashPlan` as the backend gave it and knows no medium, partition name or backend.
 */
import { useState } from 'react'
import type { FlashMedium, FlashPartition, FlashPlan } from 'boardlab-core/shared/types.ts'

export function sizeText(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(bytes % 2 ** 30 ? 1 : 0)} GiB`
  if (bytes >= 2 ** 20) return `${(bytes / 2 ** 20).toFixed(bytes % 2 ** 20 ? 1 : 0)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(bytes % 1024 ? 1 : 0)} KiB`
  return `${bytes} B`
}

interface Block { name: string, offset: number, size: number, rest: boolean }
interface Lane { label: string, kind: 'partition' | 'write', blocks: Block[] }

/** The lanes of a medium and the length they are drawn against: the medium's size when it is known and holds them all. */
function lanesOf(medium: FlashMedium, chosen: Set<string> | null): { lanes: Lane[], total: number } {
  const placed = medium.partitions.filter(part => part.offset !== null)
  const reach = (part: FlashPartition) => part.size ?? part.payload ?? 1
  const end = Math.max(0, ...placed.map(part => part.offset! + reach(part)))
  const total = medium.size !== null && medium.size >= end ? medium.size : end
  // A partition with no size runs to the end of the medium, when the medium's size is known.
  const span = (part: FlashPartition) => part.size ?? (medium.size !== null ? medium.size - part.offset! : part.payload ?? 1)
  const block = (part: FlashPartition, size: number): Block => ({ name: part.name, offset: part.offset!, size: Math.max(1, size), rest: part.size === null })
  const lanes: Lane[] = []
  if (placed.length) lanes.push({ label: '分区表', kind: 'partition', blocks: placed.map(part => block(part, span(part))) })
  const written = placed.filter(part => part.image && part.payload && (!chosen || chosen.has(part.name)))
  if (written.length) lanes.push({ label: chosen ? '将写入' : '包里的内容', kind: 'write', blocks: written.map(part => block(part, part.payload!)) })
  return { lanes, total }
}

function LaneRow({ lane, total }: { lane: Lane, total: number }) {
  const [hot, setHot] = useState<string | null>(null)
  const edges = new Set<number>()
  for (const item of lane.blocks) { edges.add(item.offset); edges.add(item.offset + item.size) }
  const range = (item: Block) => `${sizeText(item.offset)}–${item.rest ? '末尾' : sizeText(item.offset + item.size)}`
  // A lane holds each partition once, so its name is its key; two media that name one alike are two maps.
  // Narrow segments share the track: a segment too narrow for its name is written in its lane's second line instead,
  // so every partition is named in a row that reads (the legend below gives its size and range).
  const narrow = (item: Block) => 100 * item.size / total < 9
  let narrowSeen = 0
  const lines = lane.blocks.map(item => narrow(item) ? 1 + narrowSeen++ % 2 : 0)
  return (
    <div className='fl-map-lane'>
      <span className='fl-lane-label'>{lane.label}</span>
      <div>
        <div className='fl-map-track' aria-hidden='true'>
          {lane.blocks.map((item, index) => (
            <span key={item.name} data-kind={lane.kind} data-highlight={hot === item.name ? 'true' : 'false'}
              style={{ left: `${100 * item.offset / total}%`, width: `${100 * item.size / total}%` }}
              title={`${item.name} · ${item.rest ? '剩余空间' : sizeText(item.size)} · ${range(item)}`}>
              {lines[index] === 0 && <b>{item.name}</b>}
            </span>
          ))}
          {[...edges].filter(at => at > 0 && at < total).map(at => <i key={at} className='fl-map-boundary' style={{ left: `${100 * at / total}%` }} />)}
        </div>
        {lines.some(line => line > 0) && <div className='fl-map-names' aria-hidden='true'>
          {lane.blocks.map((item, index) => lines[index] === 0 ? null : (
            <span key={item.name} className='tight' style={{ left: `${100 * item.offset / total}%`, top: `${(lines[index]! - 1) * 15}px` }}
              onMouseEnter={() => setHot(item.name)} onMouseLeave={() => setHot(null)} title={`${item.name} · ${range(item)}`}>{item.name}</span>
          ))}
        </div>}
        <ul className='fl-map-legend'>
          {lane.blocks.map(item => (
            <li key={item.name} data-kind={lane.kind} tabIndex={0} title={`${item.name} · ${range(item)}`}
              onMouseEnter={() => setHot(item.name)} onMouseLeave={() => setHot(null)} onFocus={() => setHot(item.name)} onBlur={() => setHot(null)}>
              <strong>{item.name}</strong><span>{item.rest ? '剩余空间' : sizeText(item.size)} · {range(item)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** One medium: its label and size, then its lanes. `chosen`, when given, limits the written lane to those partitions. */
export function MediumMap({ medium, chosen = null }: { medium: FlashMedium, chosen?: Set<string> | null }) {
  const { lanes, total } = lanesOf(medium, chosen)
  return (
    <div className='fl-map'>
      <div className='fl-map-heading'><strong>{medium.label}</strong><span>{total ? sizeText(total) : ''}</span></div>
      {lanes.length && total ? lanes.map(lane => <LaneRow key={lane.label} lane={lane} total={total} />) : <div className='sub small'>这个介质上没有可以画出来的分区。</div>}
    </div>
  )
}

export function PlanMap({ plan, chosen = null }: { plan: FlashPlan, chosen?: Set<string> | null }) {
  return <>{plan.media.map(medium => <MediumMap key={medium.id} medium={medium} chosen={chosen} />)}</>
}
