/** Run an SDK, catalog or raw boardctrl command through boardd's streaming endpoint. */
import type { BoardsApiError, BoardsClient } from 'boardlab-core/shared/client.ts'

type Output = (stream: 'stdout' | 'stderr', text: string) => void

export function sdkCommand(client: BoardsClient, args: string[], json: boolean, onOutput: Output, group: 'sdk' | 'catalog' | 'raw' = 'sdk') {
  return client.streamCommand('/api/sdk', { args, json, group }, onOutput)
}

/** The waits between tries to follow a build again after its stream dropped; a try that brought output starts them over. */
export const REFOLLOW_MS = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 30_000, 30_000]

/** The stream ended without an answer (boardd restarting, a proxy cut it), or boardd is not reachable for now. */
function lost(error: unknown): boolean {
  // boardd's own answer (a BoardsApiError carries its status); only "not reachable for now" is worth waiting out.
  const answer = error as Partial<BoardsApiError>
  if (typeof answer.status === 'number') return answer.code === 'unavailable' || answer.status === 502 || answer.status === 503
  const code = (error as NodeJS.ErrnoException).code
  return ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ENOENT'].includes(code ?? '') || /socket hang up|在命令结束前断开了/.test((error as Error).message)
}

/** The positional words of a boardctrl sdk command (options and their values left out). */
function words(args: string[]): string[] {
  return args.filter((arg, index) => !arg.startsWith('-') && !(index > 0 && ['--timeout', '--lease', '--cwd', '-o', '--output'].includes(args[index - 1]!)))
}

/**
 * `sdk build` and `sdk job … --follow` through boardd. The build runs on the build server, not in boardd, so when the
 * stream drops (boardd restarting, a proxy cutting a long stream) the build goes on, and this follows it again by the
 * job id boardctrl printed (`build job <id> on …`) until it ends. A drop before that id is known is the caller's.
 */
export async function sdkFollowing(client: BoardsClient, args: string[], json: boolean, onOutput: Output, waits = REFOLLOW_MS) {
  const [verb, sdk, id] = words(args)
  const follows = verb === 'job' && args.includes('--follow')
  let job = follows && sdk && id ? { sdk, id } : null
  if (!job && (verb !== 'build' || !sdk || args.includes('--no-wait'))) return sdkCommand(client, args, json, onOutput)
  let current = args, tries = 0, heard = false
  const seen: Output = (stream, text) => {
    heard = true
    const started = !job && text.match(/^build job (\S+) on /m)
    if (started) job = { sdk: sdk!, id: started[1]! }
    onOutput(stream, text)
  }
  for (;;) {
    heard = false
    try { return await sdkCommand(client, current, json, seen) }
    catch (error) {
      if (heard) tries = 0
      if (!job || !lost(error) || tries >= waits.length) throw error
      onOutput('stderr', `和 boardd 的连接断了（${(error as Error).message}）；构建 ${job.id} 在构建服务器上继续，${Math.round(waits[tries]! / 1000)} 秒后接着跟…\n`)
      await new Promise(resolve => setTimeout(resolve, waits[tries++]))
      current = ['job', job.sdk, job.id, '--follow']
    }
  }
}
