/** The page's small pieces: formatting, labels, and the components every view uses. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Board, Lease, Proposal } from 'boardlab-core/shared/types.ts'
import type { Scan } from '../../src/shared/local.ts'

/** A fixed tab, or `p/<id>` for a module's own page. */
export type Tab = string
export const TABS: Array<[Tab, string]> = [['boards', '板子'], ['scan', '扫描'], ['settings', '设置'], ['history', '历史'], ['api', 'API']]

export const pad = (n: number) => String(n).padStart(2, '0')
/** `10/29 09:40:05`, short enough to stay on one line. */
export function time(iso: string | null, withDate = true) {
  if (!iso) return '—'
  const d = new Date(iso)
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return withDate ? `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${clock}` : clock
}
/** `/dev/serial/by-path/pci-…-usb-0:6.4.2:1.0-port0` → `USB 6.4.2`. */
export function shortLink(link: string) {
  const port = link.match(/-usb-\d+:([\d.]+):/)?.[1]
  return port ? `USB ${port}` : link.split('/').at(-1)!
}
export const shortenLinks = (text: string) => text.replace(/\/dev\/serial\/by-path\/\S+/g, link => shortLink(link))
/** `user:troy` → `troy`; other holder kinds keep their prefix so agents stay recognisable. */
export const who = (holder: string) => holder.startsWith('user:') ? holder.slice(5) : holder

// The shared table: one place names what an action did, so neither frontend shows a raw id and the two never
// disagree about a word.
export { ACTIONS } from '../../src/ui/format.ts'
export const MODE: Record<Board['mode'], string> = { unknown: '状态未知', normal: '已复位', resetting: '复位中', fastboot: 'fastboot 模式' }
export const KIND: Record<Proposal['kind'], string> = { 'new-board': '新板', 'replace-board': '换板', 'serial-moved': '串口', 'download-moved': '下载口', 'product-changed': '型号', 'slot-empty': '空槽位' }
export const STATUS: Record<Scan['status'], string> = { running: '进行中', done: '完成', failed: '失败', cancelled: '已取消' }
export const LEASE: Record<Lease['status'], string> = { held: '使用中', released: '已释放', stolen: '被抢' }

export type Run = (label: string, fn: () => Promise<unknown>) => Promise<void>
export type Prompt =
  | { kind: 'lock', board: Board }
  | { kind: 'queue', board: Board }
  | { kind: 'steal', board: Board }
  | { kind: 'identity' }
  | { kind: 'sdkboot', board: Board }
  | { kind: 'relay', board: Board }
  | { kind: 'refresh', board: Board }
  | { kind: 'confirm', title: string, body: string, action: string, danger?: boolean, run: () => Promise<unknown> }

// ---------- small pieces ----------

export function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'mine' | 'err', children: ReactNode }) {
  return <span className={`pill pill-${tone}`}><i />{children}</span>
}

export function Dialog(props: { title: string, children: ReactNode, onClose: () => void, actions: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') props.onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])
  return (
    <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) props.onClose() }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={props.title}>
        <h2>{props.title}</h2>
        <div className="dialog-body">{props.children}</div>
        <div className="dialog-actions">{props.actions}</div>
      </div>
    </div>
  )
}

export function Section(props: { title: string, extra?: ReactNode, children: ReactNode }) {
  return (
    <section className="panel">
      <header className="panel-head"><h3>{props.title}</h3>{props.extra}</header>
      {props.children}
    </section>
  )
}

/** Segmented tabs whose dark selection slides to the chosen item. */
export function Tabs<T extends string>(props: { items: Array<{ key: T, label: ReactNode }>, value: T, onChange: (key: T) => void, label: string, className?: string }) {
  const root = useRef<HTMLDivElement>(null)
  const [mark, setMark] = useState<{ left: number, width: number } | null>(null)
  useLayoutEffect(() => {
    const measure = () => {
      const active = root.current?.querySelector<HTMLElement>('[aria-selected="true"]')
      if (active) setMark({ left: active.offsetLeft, width: active.offsetWidth })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root.current!)
    return () => observer.disconnect()
  }, [props.value, props.items.length])
  return (
    <div ref={root} className={`tabs ${props.className ?? ''}`} role="tablist" aria-label={props.label}>
      {mark && <span className="tabs-mark" style={{ transform: `translateX(${mark.left}px)`, width: mark.width }} aria-hidden="true" />}
      {props.items.map(item => (
        <button key={item.key} role="tab" aria-selected={props.value === item.key} className={props.value === item.key ? 'active' : ''} onClick={() => props.onChange(item.key)}>{item.label}</button>
      ))}
    </div>
  )
}

