/**
 * The module-facing UI layer: what a module offers the people using a boardlab page, as an in-process BFF ("backend
 * for frontend"). A module never draws anything. It hands the page *views*: named regions (a settings section, a way
 * to scan, a result, a history) made of a small set of abstract elements, with *operations* the page can call: quick
 * actions, long-running jobs that report progress and finish with a result, and live streams. A frontend (a whole page
 * with its own look) renders the elements its way and calls the operations; it knows nothing of the module's API
 * paths, and the module nothing of the frontend.
 *
 *   module  --views(state)-->  View[] of Element trees     (what to show, recomputed from the page state)
 *   page    --op.run(input)-->  Promise<Outcome>            (quick action: done, a message, maybe data)
 *   page    --op.start(input, sink)-->                      (job: progress lines and a fraction, then a result)
 *   page    --stream.open(sink)-->  stop()                  (live data: lines or values as they come)
 *
 * Frontends map each element kind to their components. Beyond the common kinds, a module can hand any frontend
 * something of its own (`custom` elements, `extra` on views and operations): a frontend that knows the module may
 * render it specially; every other one renders the common `fallback` the module gives with it.
 */
import type { History, PageState as BasePageState } from './api.ts'

// ---------- where a view goes ----------

/** The page regions a module can fill. A frontend puts each where it fits its layout. */
export type Slot =
  | 'settings'      // a section of the settings page
  | 'scan'          // a way to find boards, on the scan page
  | 'scan-result'   // what the latest finding run found, beside the ways to scan
  | 'history'       // a section of the history page
  | 'board'         // extra lines on every board's card, given the board (`views(state, { board })`)

/** What the page knows when it asks: the state, and for `board` views the board in question. */
export interface ViewContext { board?: string }

/** One region a module fills. */
export interface View {
  /** Stable within the module (`ha`, `scan`): frontends keep UI state (an open panel, a form) by it. */
  id: string
  slot: Slot
  title?: string
  /** A badge beside the title: how this part stands. */
  status?: Badge
  body: Element[]
  /** Anything else this module wants a frontend that knows it to have (see Extra). */
  extra?: Extra
}

/**
 * A module's own data or behaviour for frontends that choose to adapt to it: arbitrary values and callbacks under
 * names the module documents (`{ "local.slots": {...}, "local.onHover": (slot) => ... }`). Frontends that do not know a
 * name ignore it. Namespaced by the module's id, so two modules never collide.
 */
export type Extra = Record<string, unknown>

// ---------- elements ----------

export type Tone = 'neutral' | 'ok' | 'info' | 'warn' | 'error' | 'mine'
export interface Badge { tone: Tone, text: string }

/** Text with a little structure: plain, code, a link, emphasis. Frontends keep it readable at any width. */
export type Inline = string | { code: string } | { strong: string } | { link: string, href: string } | { muted: string } | { time: string }
export type Rich = Inline | Inline[]

export type Element =
  /** A paragraph. `tone` other than neutral reads as a notice (warn: something to fix; error: it failed). */
  | { kind: 'text', text: Rich, tone?: Tone }
  /** Facts as label/value pairs (a summary of the thing). */
  | { kind: 'facts', items: Array<{ label: string, value: Rich, tone?: Tone }> }
  /** A form; `submit` runs with the field values. Fields keep the values the user typed until it succeeds. */
  | { kind: 'form', fields: Field[], submit: Operation, submitLabel: string, secondary?: Operation[], note?: Rich }
  /** Buttons on their own row. */
  | { kind: 'actions', actions: Operation[] }
  /** A list of things, each with its own actions. */
  | { kind: 'list', items: ListItem[], empty?: Rich }
  /** A table: columns and rows of rich cells. */
  | { kind: 'table', columns: Array<{ key: string, title: string, width?: 'narrow' | 'wide' }>, rows: Array<{ key: string, cells: Record<string, Rich>, tone?: Tone, actions?: Operation[] }>, empty?: Rich }
  /** Several choices at once, from a fixed set (which slots to scan). Its value goes with the operations in `using`. */
  | { kind: 'select-many', id: string, label: string, options: Array<{ value: string, label: string, note?: string }>, initial: string[], disabled?: boolean }
  /** Steps of a run so far, newest last. */
  | { kind: 'timeline', items: Array<{ key: string, at?: string, tag?: string, text: Rich, tone?: Tone }> }
  /** A job's progress: what it is doing now and, if known, how far it is. */
  | { kind: 'progress', label: Rich, fraction?: number | null, tone?: Tone }
  /** Live output from a stream, shown as it arrives (lines of text). */
  | { kind: 'live', stream: Stream, height?: 'small' | 'large' }
  /** More detail behind a disclosure (raw evidence): loaded when opened. */
  | { kind: 'details', summary: Rich, load: () => Promise<Element[]> }
  /** A group of elements, side by side when there is room. */
  | { kind: 'group', title?: string, status?: Badge, body: Element[], layout?: 'stack' | 'columns' }
  /**
   * Something only some frontends render: `type` names it (`<module>.<what>`, documented by the module), `data` is
   * whatever it is (a tree, values, callbacks). Every frontend that does not know `type` renders `fallback` instead.
   */
  | { kind: 'custom', type: string, data: unknown, fallback: Element[] }

export interface ListItem {
  key: string
  title: Rich
  description?: Rich
  tag?: string
  status?: Badge
  actions?: Operation[]
  extra?: Extra
}

export type Field =
  | { kind: 'text', id: string, label: string, initial?: string, placeholder?: string, required?: boolean, help?: Rich, pattern?: string, disabled?: boolean, wide?: boolean }
  /** A secret: never shown back. `stored` says one is kept (left empty, it stays). */
  | { kind: 'secret', id: string, label: string, stored?: boolean, placeholder?: string, help?: Rich }
  | { kind: 'number', id: string, label: string, initial?: number, min?: number, max?: number, required?: boolean, disabled?: boolean }
  /** Several lines (scripts): monospaced. */
  | { kind: 'code', id: string, label: string, initial?: string, placeholder?: string, required?: boolean, rows?: number, help?: Rich }
  | { kind: 'switch', id: string, label: string, initial?: boolean, help?: Rich }
  | { kind: 'choice', id: string, label: string, options: Array<{ value: string, label: string }>, initial?: string }

export type Values = Record<string, string | number | boolean | string[]>

// ---------- operations ----------

/** What happened, for the page to tell the person. `data` is for operations whose result a view shows. */
export interface Outcome { message?: string, data?: unknown }

/** Where a job reports while it runs. */
export interface Sink {
  /** A line of what it is doing now. */
  line(text: string): void
  /** How far it is (0..1), when it can tell. */
  progress(fraction: number): void
}

interface OperationBase {
  id: string
  label: string
  /** How it looks: the main thing to do, an ordinary action, or one that destroys or disrupts. */
  intent?: 'primary' | 'default' | 'danger'
  /** Why it cannot run now (it shows, disabled, with this as the reason); absent when it can. */
  blocked?: string
  /** Ask before running: what will happen. */
  confirm?: { title: string, body: Rich, action: string }
  /** Values of `select-many` elements (by id) this operation takes with its input. */
  using?: string[]
  /** The module's own hints for frontends that know it (an icon, a shortcut key, a keyboard binding). */
  extra?: Extra
}

export type Operation =
  /** Quick: the page waits for it (a second or two), then says the message. */
  | (OperationBase & { kind: 'action', run(input: Values): Promise<Outcome> })
  /**
   * Long: it reports progress through the sink while it runs, and the page stays usable. The page shows the lines and
   * fraction (in a drawer, on the card, wherever it fits) and the outcome at the end.
   */
  | (OperationBase & { kind: 'job', start(input: Values, sink: Sink, signal: AbortSignal): Promise<Outcome> })
  /** Opens more of the page over it (a dialog, a drawer): elements whose operations close it when they succeed. */
  | (OperationBase & { kind: 'open', title: string, body(): Element[] })

/** Live data the page shows as it arrives, until it stops listening. */
export interface Stream {
  id: string
  open(sink: { line(text: string): void, value?(data: unknown): void }): () => void
}

// ---------- what a module hands the page ----------

/** A module's part of the page: views computed from the state, and anything else it offers frontends. */
export interface ModuleUi {
  /** The module whose part this is; its views show only while boardd has the module loaded. */
  module: string
  views(state: PageState, context: ViewContext): View[]
  /** Module-wide extras for frontends that know this module (services, data sources, callbacks). */
  extra?: Extra
}

/** A frontend's renderer for one custom type (or a frontend's adapter for one module's extras). */
export const custom = (type: string, data: unknown, fallback: Element[]): Element => ({ kind: 'custom', type, data, fallback })

/** The state as the page has it (see api.ts), with the history for `history` views once the page has loaded it. */
export type PageState = BasePageState & { history?: History }

// ---------- helpers modules use to build views ----------

export const text = (value: Rich, tone?: Tone): Element => ({ kind: 'text', text: value, tone })
export const notice = (value: Rich, tone: Tone = 'warn'): Element => ({ kind: 'text', text: value, tone })

/** An action whose run is an async function returning the message to show (or nothing). */
export function action(id: string, label: string, run: (input: Values) => Promise<string | Outcome | void>, extra: Omit<OperationBase, 'id' | 'label'> = {}): Operation {
  return { kind: 'action', id, label, ...extra, async run(input) { const out = await run(input); return typeof out === 'string' ? { message: out } : out ?? {} } }
}

/** An operation that opens `body` over the page, titled `title`. */
export function open(id: string, label: string, title: string, body: () => Element[], extra: Omit<OperationBase, 'id' | 'label'> = {}): Operation {
  return { kind: 'open', id, label, title, body, ...extra }
}

/** A job whose start reports through the sink and returns the message to show at the end (or nothing). */
export function job(id: string, label: string, start: (input: Values, sink: Sink, signal: AbortSignal) => Promise<string | Outcome | void>, extra: Omit<OperationBase, 'id' | 'label'> = {}): Operation {
  return { kind: 'job', id, label, ...extra, async start(input, sink, signal) { const out = await start(input, sink, signal); return typeof out === 'string' ? { message: out } : out ?? {} } }
}

/** Plain text of rich text, for frontends' fallbacks (titles, tooltips). */
export function plain(value: Rich): string {
  const one = (part: Inline) => typeof part === 'string' ? part : 'code' in part ? part.code : 'strong' in part ? part.strong : 'link' in part ? part.link : 'muted' in part ? part.muted : part.time
  return Array.isArray(value) ? value.map(one).join('') : one(value)
}
