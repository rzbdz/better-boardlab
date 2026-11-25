/**
 * The boot rail: a thin strip beside a log's scrollbar with a tick at every boot line, where it falls in the whole log
 * (as the scrollbar maps it), tinted by the kind of stage. A tick goes to its line; the rail's button opens a small
 * list of the boots to pick one from and of the kinds of line to show, which is remembered for the console.
 *
 * It knows lines and counts only: a console gives it the lines its buffer holds, the log view the lines of the whole
 * log, each with how to go to a line. Every frontend can use it, styled by its `className`.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { type Boot, type BootLine, type BootMark, bootNear, groupBoots, hiddenMarks, setHiddenMarks } from './boots.ts'

export interface BootRailProps {
  board: string
  die?: string
  marks: readonly BootMark[]
  /** The boot lines, oldest first, numbered as `first`..`first + count - 1` number the lines. */
  lines: readonly BootLine[]
  first: number
  count: number
  /** The line in the middle of the view, which says which boot is shown and is where both buttons step from. */
  current: number
  go: (line: number) => void
  className?: string
}

/** The most ticks drawn: more boot lines than this share ticks by position, so the rail costs the same however many. */
const MAX_TICKS = 400

export function BootRail({ board, die, marks, lines, first, count, current, go, className = 'bl-boots' }: BootRailProps) {
  const [hidden, setHidden] = useState(() => hiddenMarks(board, die))
  const [open, setOpen] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => setHidden(hiddenMarks(board, die)), [board, die])
  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => { if (!panel.current?.contains(event.target as Node)) setOpen(false) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key) }
  }, [open])
  const byId = useMemo(() => new Map(marks.map(mark => [mark.id, mark])), [marks])
  const shown = useMemo(() => hidden.length ? lines.filter(line => !hidden.includes(line.id)) : lines, [lines, hidden])
  const boots = useMemo(() => groupBoots(lines, marks), [lines, marks])
  // The boots a person can go to: those with a stage they show, each named by its first such stage — as the panel lists
  // them. A boot whose stages are all hidden is not counted and not stepped over.
  const visible = useMemo(() => boots.map(boot => boot.stages.filter(stage => !hidden.includes(stage.id))).filter(stages => stages.length), [boots, hidden])
  if (!lines.length || count <= 0) return null
  const place = (line: number) => Math.min(1, Math.max(0, (line - first + 0.5) / count))
  // One tick per pixel row's worth of the log at most: the rail stays light on a log with thousands of boots.
  const ticks: BootLine[] = []
  let last = -1
  for (const line of shown) { const at = Math.floor(place(line.line) * MAX_TICKS); if (at !== last) { ticks.push(line); last = at } }
  const toggle = (id: string) => setHidden(now => {
    const next = now.includes(id) ? now.filter(other => other !== id) : [...now, id]
    // Hiding every kind would leave nothing to go to: showing all again.
    const kept = marks.every(mark => next.includes(mark.id) || !lines.some(line => line.id === mark.id)) ? [] : next
    setHiddenMarks(board, die, kept)
    return kept
  })
  // ‹ › go to the boot before or after the one being read, not to the stages inside it: a boot is a whole run of
  // stages, and a person pressing "上一次启动" means the boot, not U-Boot's banner after the kernel's. Both step from
  // the boot the counter names, so the counter and the buttons always agree however the view is scrolled.
  const starts = visible.map(stages => stages[0]!)
  const here = bootNear(starts, current + 1, 'previous')
  const at = here ? starts.findIndex(start => start.line === here.line) : -1
  const now = at >= 0 ? boots.find(boot => boot.stages.includes(starts[at]!)) ?? null : null
  const step = (direction: 'next' | 'previous') => {
    if (!starts.length) return
    // From the boot's own first line: the last start before it is the boot before, and the first after it the next.
    const to = bootNear(starts, here ? here.line : current, direction)
    if (to) go(to.line)
  }
  const present = marks.filter(mark => lines.some(line => line.id === mark.id))
  return (
    <div className={className} data-open={open || undefined}>
      <div className="rail" role="navigation" aria-label="启动">
        {ticks.map(line => {
          const mark = byId.get(line.id)
          return <button key={line.line} type="button" className={`tick t-${mark?.tone ?? 'loader'}${now?.stages.some(stage => stage.line === line.line) ? ' now' : ''}`}
            style={{ top: `${place(line.line) * 100}%` }} title={`${mark?.title ?? line.id} · 第 ${line.line + 1} 行\n${line.text}`} aria-label={`${mark?.title ?? line.id}，第 ${line.line + 1} 行`} onClick={() => go(line.line)} />
        })}
      </div>
      <div className="knob" ref={panel}>
        <button type="button" className="kb" aria-label="上一次启动" title="上一次启动" onClick={() => step('previous')}>‹</button>
        <button type="button" className="kn" aria-expanded={open} title="启动：选一次，或只看某些阶段" onClick={() => setOpen(!open)}>
          {at >= 0 ? `${at + 1}/${visible.length}` : `${visible.length}`}<i>次启动</i>{hidden.length > 0 && <b className="dot" />}
        </button>
        <button type="button" className="kb" aria-label="下一次启动" title="下一次启动" onClick={() => step('next')}>›</button>
        {open && <div className="panel" role="dialog" aria-label="启动">
          <div className="kinds">{present.map(mark => (
            <button key={mark.id} type="button" className={`kind t-${mark.tone}${hidden.includes(mark.id) ? '' : ' on'}`} aria-pressed={!hidden.includes(mark.id)} onClick={() => toggle(mark.id)}>{mark.title}</button>
          ))}</div>
          <div className="blist">{[...boots].reverse().slice(0, 200).map(boot => <BootRow key={boot.line} boot={boot} byId={byId} hidden={hidden} now={boot === now} go={line => { go(line); setOpen(false) }} />)}</div>
          {boots.length > 200 && <div className="more">只列了最近 200 次</div>}
        </div>}
      </div>
    </div>
  )
}

function BootRow({ boot, byId, hidden, now, go }: { boot: Boot, byId: Map<string, BootMark>, hidden: string[], now: boolean, go: (line: number) => void }) {
  const stages = boot.stages.filter(stage => !hidden.includes(stage.id))
  if (!stages.length) return null
  const stamp = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\]/.exec(boot.stages[0]!.text)?.[1]
  return (
    <div className={`boot${now ? ' now' : ''}`}>
      <button type="button" className="head" onClick={() => go(stages[0]!.line)}><span className="n">#{boot.number}</span>{stamp ? <span className="ts">{stamp.slice(5)}</span> : <span className="ts">第 {boot.line + 1} 行</span>}</button>
      <span className="stages">{stages.map(stage => <button key={stage.line} type="button" className={`st t-${byId.get(stage.id)?.tone ?? 'loader'}`} title={stage.text} onClick={() => go(stage.line)}>{byId.get(stage.id)?.title ?? stage.id}</button>)}</span>
    </div>
  )
}
