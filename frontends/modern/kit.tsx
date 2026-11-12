/**
 * Modern's building blocks: icons, names, a board's state as the page shows it, and the toasts and layers (dialogs,
 * the drawer) every view uses. Plain React with the page's own CSS (styles.css), no component library.
 */
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Board, Busy } from 'boardlab-core/shared/types.ts'

// ---------- icons ----------
const P: Record<string, string> = {
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  term: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.2 2.2 0 0 0-2.9-.1z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.9A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2z"/>',
  dl: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>', back: '<path d="m15 18-6-6 6-6"/>', chev: '<path d="m9 18 6-6-6-6"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.9-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>',
  plug: '<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8z"/>', radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 12 19 5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  server: '<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>', shrink: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', queue: '<path d="M3 6h18M3 12h12M3 18h7"/>',
  rebuild: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>', eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>', link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
}
export function Icon({ name, className = '' }: { name: string, className?: string }) {
  return <svg className={`i ${className}`} viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: P[name] ?? '' }} />
}

// ---------- names ----------
/** Long text cut in the middle, so both ends stay readable. */
export const middle = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, Math.ceil(max / 2) - 1)}…${text.slice(-Math.floor(max / 2))}`
let prefix = ''
/** Boards display in upper case; a backend prefix every board shares (`bsp-`) is dropped. */
export function setBoards(boards: Board[]) { const ps = new Set(boards.map(b => /^([a-z]+)-/.exec(b.name)?.[1])); prefix = ps.size === 1 && [...ps][0] ? `${[...ps][0]}-` : '' }
export const upper = (name: string) => (prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name).toUpperCase()
/** Agents name themselves `<kind>:<task>` (claude, codex, opencode, dsh, …); people are `user:<name>`. */
const AGENT_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', dsh: 'dsh', gemini: 'Gemini', cursor: 'Cursor', boardlab: 'boardlab' }
export function holder(id: string) {
  const at = id.indexOf(':'); const kind = at >= 0 ? id.slice(0, at) : 'user', name = at >= 0 ? id.slice(at + 1) : id
  return { kind, name, agent: kind !== 'user', label: AGENT_NAMES[kind] ?? kind }
}
function hue(s: string) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 35% 45%)` }
export function Who({ id, you, full = false, max = 18, tag = true }: { id: string, you: string, full?: boolean, max?: number, tag?: boolean }) {
  const h = holder(id)
  return (
    <span className="who" title={id}>
      {h.agent ? <span className={`av agent k-${h.kind}`}><Icon name="spark" /></span> : <span className="av" style={{ background: hue(h.name) }}>{h.name[0]}</span>}
      <span className="nm2">{id === you ? '你' : full ? h.name : middle(h.name, max)}</span>
      {h.agent && tag && <span className={`kind k-${h.kind}`}>{h.label}</span>}
    </span>
  )
}

/** Where a board sits: a lab board's `<lab>/<host>/<slot>`, or a local slot. */
export function slotOf(b: Board) { const p = (b.slotRef ?? '').split('/'); return p.length === 3 ? { lab: p[0]!, host: p[1]!, slot: p[2]! } : { lab: 'local', host: '本机', slot: b.slot != null ? `槽位 ${b.slot}` : '—' } }
export const where = (b: Board) => { const { host, slot } = slotOf(b); return `${host} · ${slot}` }

// ---------- time ----------
export function age(iso: string | null | undefined) {
  if (!iso) return '—'
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000))
  if (s < 60) return `${s} 秒`; if (s < 3600) return `${Math.floor(s / 60)} 分钟`
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h < 24 ? `${h} 小时${m ? ` ${m} 分` : ''}` : `${Math.floor(h / 24)} 天`
}
export function clock(iso: string) { const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000)); const p = (n: number) => String(n).padStart(2, '0'); return `${Math.floor(s / 3600)}:${p(Math.floor(s % 3600 / 60))}:${p(s % 60)}` }
export const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
export const fmtAt = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
/** Re-render every second, for clocks and ages. */
export function useTick(ms = 1000) { const [, set] = useState(0); useEffect(() => { const t = window.setInterval(() => set(n => n + 1), ms); return () => window.clearInterval(t) }, [ms]) }
export function Ticking({ fn }: { fn: () => string }) { useTick(); return <>{fn()}</> }

// ---------- a board's state ----------
export type Lock = 'free' | 'mine' | 'busy' | 'lab' | 'empty'
export interface Model {
  lock: Lock, key: Lock | 'attn' | 'gone', word: string, tone: '' | 'ok' | 'warn' | 'bad' | 'yours', mine: boolean
  holder: string | null, since: string | null, purpose: string | null, queued: number, canConfirm: boolean
  flags: { attn: string | null, gone: boolean, busy: Busy | null, progress: string | null, booting: string | null, pct: number | null, offline: boolean, error: string | null }
}
/**
 * The lock is the main state (free / yours / someone else's / the lab's / an empty slot). Waiting for a person, a lost
 * console and a running job are flags on top of it, so whoever holds the board keeps their lock actions.
 */
export function model(b: Board, you: string): Model {
  const lab = b.lab, l = b.lease, mine = !!l && l.holder === you, q = b.waiters.findIndex(w => w.holder === you)
  const lock: Lock = lab?.empty ? 'empty' : mine ? 'mine' : l ? 'busy' : lab?.heldBy ? 'lab' : 'free'
  // What boardd is doing to the board (its own operation, or a lab's job) is one in-between state with its latest line.
  const busy = b.busy ?? null
  const progress = lab?.progress ?? (busy ? `${busy.label}${busy.line ? `：${busy.line}` : '…'}` : null)
  // Of those, a boot running (boardd's, or one the lab reports): what the boot control spins for.
  const booting = lab?.progress ?? (busy && (busy.kind === 'boot' || busy.kind === 'stage') ? progress : null)
  const pct = /(\d+)%/.exec(progress ?? '')?.[1]
  const flags = {
    attn: lab?.attention ?? null, gone: !!lab?.slotGone, busy, progress, booting, pct: pct != null ? Number(pct) : null,
    offline: !lab?.empty && !lab?.slotGone && b.chips.length > 0 && !b.chips.some(c => c.online), error: lab?.leaseError ?? null,
  }
  const key = lock === 'empty' ? 'empty' : flags.attn ? 'attn' : flags.gone ? 'gone' : lock
  const word = flags.attn ? '等人操作' : busy ? busy.label : lock === 'empty' ? '空槽位' : flags.gone ? '串口离线' : flags.progress ? (mine ? '运行中' : '忙碌中')
    : b.mode === 'resetting' ? '复位中' : { mine: '你在用', busy: '使用中', lab: '实验室占用', free: '空闲' }[lock]
  const tone = flags.attn ? 'warn' : flags.gone ? 'bad' : ({ free: 'ok', mine: 'yours', busy: '', lab: '', empty: '' } as const)[lock]
  return { lock, key, word, tone, mine, holder: l?.holder ?? lab?.heldBy ?? null, since: l?.startedAt ?? null, purpose: l?.purpose ?? null, queued: q >= 0 ? q + 1 : 0, canConfirm: !!lab?.canConfirm, flags }
}

// ---------- toasts and layers ----------
interface Toast { id: number, title: string, body?: string, error?: boolean, action?: { label: string, run: () => void } }
interface UI {
  toast(title: string, body?: string, action?: Toast['action']): void
  fail(title: string, error: unknown): void
  /** A dialog (or the drawer); `render` gets a close function. */
  layer(render: (close: () => void) => ReactNode, kind?: 'dialog' | 'wide' | 'drawer'): void
  close(): void
}
const Ctx = createContext<UI>(null!)
export const useUI = () => useContext(Ctx)
let seq = 0
export function UIProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const [layer, setLayer] = useState<{ render: (close: () => void) => ReactNode, kind: string } | null>(null)
  const drop = (id: number) => setToasts(list => list.filter(t => t.id !== id))
  const ui: UI = {
    toast(title, body, action) { const id = ++seq; setToasts(list => [...list.slice(-3), { id, title, body, action }]); window.setTimeout(() => drop(id), action ? 8000 : 4000) },
    fail(title, error) { const id = ++seq; setToasts(list => [...list.slice(-3), { id, title, body: error instanceof Error ? error.message : String(error), error: true }]) },
    layer(render, kind = 'dialog') { setLayer({ render, kind }) },
    close() { setLayer(null) },
  }
  useEffect(() => { const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && layer) { e.stopPropagation(); setLayer(null) } }; window.addEventListener('keydown', onKey, true); return () => window.removeEventListener('keydown', onKey, true) }, [layer])
  return (
    <Ctx.Provider value={ui}>
      {children}
      {layer && <><div className="scrim" onClick={() => setLayer(null)} /><div className={layer.kind === 'drawer' ? 'drawer' : `dialog${layer.kind === 'wide' ? ' wide' : ''}`} role="dialog" aria-modal="true">{layer.render(() => setLayer(null))}</div></>}
      <div className="toasts" aria-live="polite">{toasts.map(t => (
        <div key={t.id} className={`toast${t.error ? ' error' : ''}`}>
          {t.error && <Icon name="warn" />}
          <div className="tx"><b>{t.title}</b>{t.body && <span>{t.body}</span>}</div>
          {t.action && <button className="pill" onClick={() => { t.action!.run(); drop(t.id) }}>{t.action.label}</button>}
          {t.error && <button className="pill icon" aria-label="关闭" onClick={() => drop(t.id)}><Icon name="x" /></button>}
        </div>
      ))}</div>
    </Ctx.Provider>
  )
}

/** A confirmation: title, what will happen, the button; `reason` asks for a line the other side will see. */
export function Confirm({ title, children, ok, danger, reason, onOk, close }: { title: string, children: ReactNode, ok: string, danger?: boolean, reason?: string, onOk: (reason: string) => void, close: () => void }) {
  const [text, setText] = useState('')
  return (
    <>
      <h2>{title}</h2><div className="lead">{children}</div>
      {reason && <label className="field">{reason}<input className="input" autoFocus value={text} onChange={e => setText(e.target.value)} /></label>}
      <div className="foot"><button className="pill" onClick={close}>取消</button>
        <button className={`pill ${danger ? 'danger' : 'dark'}`} disabled={!!reason && !text.trim()} onClick={() => { close(); onOk(text.trim()) }}>{ok}</button></div>
    </>
  )
}

// ---------- one state for the page ----------
// boardd's state is the model: every view derives from the latest copy. An action re-reads it as soon as it ends
// (not only when boardd's events arrive), and what this page has asked for and not yet heard back is shared by every
// view of the board, so a card, its row and the board page agree.
let refresher: () => Promise<void> = async () => {}
export const setRefresher = (fn: () => Promise<void>) => { refresher = fn }
export const refreshNow = () => refresher()
const NONE: readonly string[] = []
const asked = new Map<string, readonly string[]>(), watchers = new Set<() => void>()
/** This page asked boardd for `key` on `board` (`on`), or heard back from it; several can be waited on at once. */
export function setAsked(board: string, key: string, on: boolean) {
  const now = asked.get(board) ?? NONE, at = now.indexOf(key)
  const next = on ? [...now, key] : at < 0 ? now : [...now.slice(0, at), ...now.slice(at + 1)]
  if (next.length) asked.set(board, next); else asked.delete(board)
  watchers.forEach(watch => watch())
}
const watchAsked = (watch: () => void) => { watchers.add(watch); return () => { watchers.delete(watch) } }
/** What this page asked boardd to do to `board` and is still waiting on, oldest first. */
export const useAsked = (board: string) => useSyncExternalStore(watchAsked, () => asked.get(board) ?? NONE)

/** Run a boardd call with the button spinning; failures show boardd's message. */
export function useRun() {
  const ui = useUI()
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (key: string, label: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key)
    try { await fn(); ui.toast(done ?? `${label}：好了`) } catch (error) { ui.fail(`${label}失败`, error) } finally { await refreshNow().catch(() => {}); setBusy(null) }
  }
  return { busy, run }
}

export const copyText = async (ui: UI, text: string, ok: string) => {
  try { await navigator.clipboard.writeText(text); ui.toast(ok, text) } catch { ui.fail('复制不了', `浏览器不让写剪贴板（页面不是 https 时常见），手动复制：${text}`) }
}
