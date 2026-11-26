/** What a boardctrl host answers when a cancel finds nothing running on the board. */
import { BoardError } from 'boardlab-core/core/errors.ts'

/**
 * boardctrl's answer to a cancel when nothing runs on the board (`details.running === false`): nothing to stop, which is not a
 * board that would not stop. It says what the board's last job did and where its log is.
 */
export function nothingToCancel(device: string, error: unknown): BoardError | null {
  const answer = (error as { boardctrl?: { code?: string, details?: Record<string, unknown> } } | null)?.boardctrl
  if (answer?.code !== 'invalid_request' || answer.details?.running !== false) return null
  const last = answer.details.last_job as { id?: string, kind?: string, status?: string, error?: { message?: string } | null } | null | undefined
  if (!last?.id) return new BoardError('conflict', `${device} 在主机上没有在跑的任务，主机也没有它跑过任务的记录，不用取消`)
  const why = last.error?.message ? `：${last.error.message}` : ''
  return new BoardError('conflict', `${device} 在主机上没有在跑的任务，不用取消；上一个任务 ${last.id}（${last.kind ?? '?'}）${last.status ?? '已结束'}${why}。日志：boardlab boardctrl job get ${last.id}`)
}
