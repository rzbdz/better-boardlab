/**
 * What a module's part of the page imports as `boardlab/ui`: the same values a module's server side gets, the helpers
 * views are built with, and the page's own `call` to reach boardd. Built to `dist/sdk.browser.js` and served to the
 * page, with an import map that names it, so a module from a market can bring views without being built into a frontend.
 */
export * from 'boardlab-core/core/sdk.ts'
export { call, isCancelled, ApiError } from './ui/api.ts'
export { action, custom, job, notice, open, plain, text } from './ui/contract.ts'
export type {
  Badge, Element, Field, Inline, ListItem, ModuleUi, Operation, Outcome, Rich, Sink, Slot, Stream, Tone, Values, View, ViewContext,
} from './ui/contract.ts'
