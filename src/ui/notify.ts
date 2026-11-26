/**
 * Notifications through the browser into the operating system's notification centre, for any frontend: a board you
 * watch became free, the lock you queued for is yours, your lock was taken, a board waits for a person. What to say is
 * worked out from two successive states (`changes`), so it is the same whichever frontend shows the page, and testable
 * without a browser.
 *
 * Browsers only allow notifications on a secure page (https, or localhost through an ssh tunnel): `support()` says
 * whether this page can have them, and why not.
 */
import type { Board, DatabaseRestore } from 'boardlab-core/shared/types.ts'

export type Topic = 'free' | 'granted' | 'stolen' | 'attention' | 'failed'
export const TOPICS: Record<Topic, string> = {
  free: '关注的板子空闲了',
  granted: '排队轮到我、拿到锁',
  stolen: '我的锁被抢',
  attention: '板子等人操作（按 RESET 等）',
  failed: '操作失败（拿锁、复位、刷机…）',
}

export interface Note { topic: Topic, board: string, title: string, body: string }

/**
 * What identifies a note in the OS notification centre: the same topic on the same board replaces the earlier note
 * (a board asking again, or a lock handed over twice, is one thing to look at), but two different failures are two
 * notes — a failure has no board to tell them apart, so its own words do.
 */
const tagOf = (note: Note) => note.topic === 'failed' ? `boardlab-failed-${hash(`${note.title}\0${note.body}`)}` : `boardlab-${note.topic}-${note.board}`
const hash = (text: string) => { let h = 0; for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0; return (h >>> 0).toString(36) }

interface Prefs { enabled: Record<Topic, boolean>, watched: string[] }
const KEY = 'boardlab.notify'
const DEFAULTS: Prefs = { enabled: { free: true, granted: true, stolen: true, attention: true, failed: true }, watched: [] }

export const prefs = {
  get(): Prefs {
    try { const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null'); return saved ? { enabled: { ...DEFAULTS.enabled, ...saved.enabled }, watched: saved.watched ?? [] } : DEFAULTS }
    catch { return DEFAULTS }
  },
  set(next: Prefs) { localStorage.setItem(KEY, JSON.stringify(next)); listeners.forEach(fn => fn(next)) },
  watch(board: string, on: boolean) { const p = prefs.get(); prefs.set({ ...p, watched: on ? [...new Set([...p.watched, board])] : p.watched.filter(name => name !== board) }) },
  topic(topic: Topic, on: boolean) { const p = prefs.get(); prefs.set({ ...p, enabled: { ...p.enabled, [topic]: on } }) },
}
const listeners = new Set<(prefs: Prefs) => void>()
export const onPrefs = (fn: (prefs: Prefs) => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

const who = (holder: string) => holder.startsWith('user:') ? holder.slice(5) : holder
const busy = (board: Board) => !!board.lease || !!board.lab?.heldBy

/**
 * What to tell `you` about, going from `before` to `after` (the boards of two successive states). Pure: no browser.
 * `watched`: boards to tell about when they become free.
 */
export function changes(before: Board[], after: Board[], you: string, watched: string[]): Note[] {
  const old = new Map(before.map(board => [board.name, board]))
  const notes: Note[] = []
  for (const board of after) {
    const was = old.get(board.name)
    if (!was) continue
    if (board.lease?.holder === you && was.lease?.holder !== you && was.waiters.some(waiter => waiter.holder === you)) {
      notes.push({ topic: 'granted', board: board.name, title: `轮到你了：${board.name}`, body: `已拿到锁（${board.lease.purpose}）` })
    } else if (was.lease?.holder === you && board.lease && board.lease.holder !== you) {
      notes.push({ topic: 'stolen', board: board.name, title: `${board.name} 的锁被 ${who(board.lease.holder)} 拿走`, body: board.lease.purpose })
    }
    if (watched.includes(board.name) && busy(was) && !busy(board) && !board.waiters.length) {
      notes.push({ topic: 'free', board: board.name, title: `${board.name} 空闲了`, body: `${was.lease ? `${who(was.lease.holder)} 已放锁` : '实验室那边已释放'}，现在可以拿锁` })
    }
    const ask = board.lab?.attention
    if (ask && ask !== was.lab?.attention) {
      notes.push({ topic: 'attention', board: board.name, title: `${board.name}：需要你操作`, body: ask })
    }
  }
  return notes
}

/**
 * How to let this page notify (and copy) when it is served over plain http on a lab host: a browser refuses both
 * outside a secure page, and the way around it is to treat this origin as secure. Each browser has its own switch:
 * `page` is where to open it (null for a browser whose switch is a setting, not a page, such as Firefox), `origin` is
 * the value to add there, and `firefox` says whether that is the way this browser takes. Null on a secure page.
 */
export const insecureHelp = (): { origin: string, page: string | null, firefox: boolean } | null => {
  if (typeof window === 'undefined' || window.isSecureContext) return null
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const firefox = /firefox|fxios/i.test(agent) && !/seamonkey/i.test(agent)
  return { origin: window.location.origin, firefox, page: firefox ? null : 'chrome://flags/#unsafely-treat-insecure-origin-as-secure' }
}

/** Whether this page can notify, and if not, why. */
export function support(): { ok: true } | { ok: false, why: string } {
  if (!('Notification' in window)) return { ok: false, why: '这个浏览器不支持系统通知' }
  if (!window.isSecureContext) return { ok: false, why: '浏览器只在 https 或 localhost 的页面上允许系统通知；这个页面是 http' }
  if (Notification.permission === 'denied') return { ok: false, why: '浏览器里已经拒绝了这个网站的通知，到网站设置里改回「允许」' }
  return { ok: true }
}

export const permission = () => ('Notification' in window ? Notification.permission : 'denied') as NotificationPermission
export const ask = async () => ('Notification' in window ? Notification.requestPermission() : 'denied')

/**
 * Show a note in the operating system (when allowed and its topic is on); `onClick` brings the page back. Returns
 * whether it went to the system, so the frontend can show it in the page instead when not.
 */
export function show(note: Note, onClick?: () => void): boolean {
  if (!prefs.get().enabled[note.topic] || support().ok === false || Notification.permission !== 'granted') return false
  const shown = new Notification(note.title, { body: note.body, tag: tagOf(note), requireInteraction: note.topic === 'attention' || note.topic === 'granted' })
  shown.onclick = () => { window.focus(); onClick?.(); shown.close() }
  return true
}

/**
 * What a frontend says, as a warning beside boardd's health, when boardd restored its database from a copy at a start:
 * the changes after that copy are gone, until a person acknowledges it.
 */
export function restoreWarning(restored: DatabaseRestore | null | undefined): { title: string, body: string } | null {
  if (!restored) return null
  const at = restored.at.slice(0, 16).replace('T', ' ')
  return restored.backup
    ? { title: 'boardd 的数据库从备份恢复过', body: `${at} 启动时数据库损坏，用备份 ${restored.backup} 恢复了：这份备份之后的锁、历史和反馈丢了。损坏的文件在 ${restored.aside}。` }
    : { title: 'boardd 的数据库损坏，用空数据库启动了', body: `${at} 启动时数据库损坏，没有可用的备份：之前的板子、锁、历史和反馈都不在了。损坏的文件在 ${restored.aside}。` }
}
