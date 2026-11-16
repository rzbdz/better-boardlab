/** Run an SDK, catalog or raw bsp command through boardd's streaming endpoint. */
import type { BoardsClient } from 'boardlab-core/shared/client.ts'

export function sdkCommand(client: BoardsClient, args: string[], json: boolean, onOutput: (stream: 'stdout' | 'stderr', text: string) => void, group: 'sdk' | 'catalog' | 'raw' = 'sdk') {
  return client.streamCommand('/api/sdk', { args, json, group }, onOutput)
}
