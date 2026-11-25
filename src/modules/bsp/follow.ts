/**
 * Following a board host's job again after boardd lost the command that started it (boardd restarted mid-flash): a
 * run reports the job its progress names as its handle, and `followJob` reads that job on its host until it ends.
 */
import { CancelledError } from 'boardlab-core/core/errors.ts'
import type { RunReport } from 'boardlab-core/core/backend.ts'
import { jobIn } from './process.ts'

/** A job on a host, as a run's handle: opaque to boardd, read back only here. */
interface JobHandle { job: string, host: string | null }

/** How long one `job get` waits for news on the host. */
const WAIT_S = 30
/** The waits before a `job get` that could not reach the host is tried again; the last one repeats. */
const RETRY_MS = [2_000, 5_000, 15_000, 30_000]
/** How long the host may stay out of reach before following its job gives up (the job goes on there). */
const AWAY_MS = 30 * 60_000

/** An answer about the job itself, not about reaching its host: the host does not know the job, or refused to say. */
function verdict(error: unknown): boolean {
  if (error instanceof CancelledError) return true
  const code = (error as { bsp?: { code?: string } } | null)?.bsp?.code
  return code === 'not_found' || code === 'invalid_request' || code === 'forbidden'
}

/** Progress lines that also report the first host job they name as the run's handle. */
export function reportingJob(progress: (line: string) => void, report?: RunReport): (line: string) => void {
  let reported = false
  return line => {
    const job = reported ? null : jobIn(line)
    if (job) { reported = true; report?.handle(JSON.stringify({ job: job.id, host: job.host } satisfies JobHandle)) }
    progress(line)
  }
}

/** A host job's state as `job get` reports it. */
interface JobView { status: 'running' | 'succeeded' | 'failed' | 'cancelled', lines?: string[], next?: number, error?: { message?: string } | null }

/**
 * Follow the job `handle` names to its end: its lines go to `progress`, and it ends as the job did (its lines when
 * it succeeded, an error when it failed, a CancelledError when it was cancelled). `get` runs `job get` on the job's host.
 */
export async function followJob(handle: string, progress: (line: string) => void,
  get: (args: string[], timeoutMs: number, host: string | undefined) => Promise<JobView>,
  options: { retryMs?: readonly number[], awayMs?: number, signal?: AbortSignal } = {}): Promise<string> {
  let parsed: JobHandle
  try { parsed = JSON.parse(handle) } catch { throw new Error(`认不出这个主机任务：${handle}`) }
  if (!parsed?.job) throw new Error(`认不出这个主机任务：${handle}`)
  const lines: string[] = []
  const retryMs = options.retryMs ?? RETRY_MS, awayMs = options.awayMs ?? AWAY_MS
  for (let since = 0, misses = 0, away = 0; ;) {
    let view: JobView
    try { view = await get(['job', 'get', parsed.job, '--since', String(since), '--wait', String(WAIT_S)], (WAIT_S + 60) * 1000, parsed.host ?? undefined) }
    catch (error) {
      // A host out of reach for a while (a network blip, its daemon restarting) is asked again; the job runs on there.
      if (verdict(error) || options.signal?.aborted) throw error
      away ||= Date.now()
      if (Date.now() - away > awayMs) throw new Error(`主机上的任务 ${parsed.job} 跟不上了：${Math.round(awayMs / 60_000)} 分钟连不上它的主机（${(error as Error).message}）；任务可能还在主机上跑，boardlab bsp job get ${parsed.job} 看它`)
      await new Promise(resolve => setTimeout(resolve, retryMs[Math.min(misses++, retryMs.length - 1)]))
      continue
    }
    misses = 0; away = 0
    for (const line of view.lines ?? []) { lines.push(line); progress(line) }
    since = view.next ?? since + (view.lines?.length ?? 0)
    if (view.status === 'running') continue
    if (view.status === 'succeeded') return lines.join('\n')
    if (view.status === 'cancelled') throw new CancelledError(`已取消：主机上的任务 ${parsed.job} 被取消了`)
    throw new Error(`主机上的任务 ${parsed.job} 失败了：${view.error?.message ?? view.status}`)
  }
}
