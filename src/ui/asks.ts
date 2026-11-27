/**
 * A person's asks as a page sees them (the `human` module): an agent asks someone at the bench to plug, press or
 * connect something, and whoever is there says they did it or could not. The page state carries the open ones; this
 * layer holds the shapes and the one call a frontend makes, so a frontend does not import a module.
 */
import { call } from './api.ts'

export interface Ask {
  id: number
  at?: string
  actor?: string
  kind?: string
  title: string
  body?: string
  status?: string
  subject?: string | null
  source?: string
  resolution?: string | null
}

export interface AskInbox { open: number, items: Ask[] }

/** The open asks the state carries, or null when the module that files them is not loaded. */
export function openAsks(state: unknown): AskInbox | null {
  const inbox = (state as { human?: AskInbox } | null)?.human
  return inbox && typeof inbox.open === 'number' && Array.isArray(inbox.items) ? inbox : null
}

/** Say an ask is done (or could not be done): the asker sees it, and a board waiting for a person is told too. */
export const resolveAsk = (id: number, status: 'done' | 'canceled', note?: string) =>
  call<{ message: string }>('POST', 'api/human/resolve', { id, status, ...(note ? { note } : {}) })
