/** CLI access to the Home Assistant module's HTTP contract, separate from its server-side HA network client. */
import type { BoardsClient } from 'boardlab-core/shared/client.ts'
import type { HaSettings } from './home-assistant.ts'

export function homeAssistantClient(client: BoardsClient) {
  return {
    configure: (url: string, token?: string) => client.call<HaSettings>('POST', '/api/ha', { url, token }),
    enabled: (enabled: boolean) => client.call<HaSettings>('POST', '/api/ha/enabled', { enabled }),
    test: () => client.call<HaSettings>('POST', '/api/ha/test'),
  }
}
