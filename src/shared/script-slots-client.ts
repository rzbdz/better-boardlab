/** CLI access to the script-slots module's HTTP contract. */
import type { BoardsClient } from 'boardlab-core/shared/client.ts'
import type { Slot } from './local.ts'

export function scriptSlotsClient(client: BoardsClient) {
  return {
    save: (input: { slot: number, label?: string | null, resetScript: string, fastbootScript?: string | null }) => client.call<Slot>('POST', '/api/slots/script', input),
    remove: (slot: number) => client.call<{ ok: true }>('POST', '/api/slots/script/remove', { slot }),
  }
}
