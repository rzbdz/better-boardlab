/**
 * The notification bus as a page sees it.
 *
 * The bus belongs to boardd (the `alerts` module): an alert is recorded whether or not anyone has the page open, and a
 * channel is posted from boardd. A page only reads it, so what a page needs of it — the shapes, and the one read — is
 * here, in the layer between modules and frontends, rather than in a module's own part of the page: the bell in the top
 * bar is the frontend's, and a frontend may not import a module.
 */
import { call } from './api.ts'

/** What an alert is about. The list is the bus's (`TOPICS` in the alerts module). */
export const TOPICS = ['failed', 'attention', 'aging', 'free', 'granted', 'stolen'] as const
export type AlertTopic = typeof TOPICS[number]
/** One word per topic, for a list or a badge. */
export const TOPIC_TEXT: Record<AlertTopic, string> = {
  failed: '失败', attention: '等人', aging: '老化', free: '空闲', granted: '拿锁', stolen: '被抢',
}

export interface Alert {
  id: number
  at: string
  topic: AlertTopic | string
  board: string | null
  title: string
  body: string
  tags: string[]
  actor: string
  /** Where it went, and what each channel answered. */
  delivered: Array<{ channel: string, ok: boolean, detail: string | null }>
}

/**
 * A place alerts are pushed to — a chat group, the page (`browser`) — and the rules that pick which alerts go there.
 * `kind` is the bus module's word for where (`Api`: which kinds there are is the module's business, not this layer's), and a
 * webhook address is masked by boardd.
 */
export interface AlertChannel {
  id: string
  kind: string
  title: string
  enabled: boolean
  url: string | null
  rules: Array<{ topics: string[], tags: string[] }>
  last: { at: string, ok: boolean, detail: string | null } | null
  note?: string
}

export interface AlertsAnswer { alerts: Alert[], channels: AlertChannel[] }

/** The bus: the last alerts (newest first) and every channel with its rules and last delivery. */
export const alerts = (limit = 50, signal?: AbortSignal) => call<AlertsAnswer>('GET', `api/alerts?limit=${limit}`, undefined, signal)

/** Whether `topic` is one this page knows how to show. */
export const isTopic = (topic: string): topic is AlertTopic => (TOPICS as readonly string[]).includes(topic)
