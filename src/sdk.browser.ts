/**
 * What a module's part of the page imports as `boardlab/ui`: the same values a module's server side gets, the helpers
 * views are built with, and the page's own `call` to reach boardd. Built to `dist/sdk.browser.js` and served to the
 * page, with an import map that names it, so a module from a market can bring views without being built into a frontend.
 */
export * from 'boardlab-core/core/sdk.ts'
export { api, call, isCancelled, stream, ApiError } from './ui/api.ts'
export { action, custom, job, notice, open, plain, text } from './ui/contract.ts'
export type {
  Badge, Element, Field, Inline, ListItem, ModuleUi, Operation, Outcome, PageState, Rich, Sink, Slot, Stream, Tone, Values, View, ViewContext,
} from './ui/contract.ts'
export type { Extra } from './ui/contract.ts'
// What every frontend shares with a module's part of the page: the notification bus's shapes and its one read (a
// frontend's bell and the bus module's own page read the same thing), so a market module imports them from here.
export * from './ui/alerts.ts'
// boardd's event stream, kept open by the page: a module whose view follows what its own module changed listens here.
export { events, CORE_EVENTS } from './ui/events.ts'
export type { Events, EventHandler } from './ui/events.ts'
export { help, type HelpPage } from './ui/help.ts'
