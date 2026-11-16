import { describe, expect, it } from 'vitest'
import type { BoardsClient } from 'boardlab-core/shared/client.ts'
import { localClient } from '../src/shared/local-client.ts'
import { scriptSlotsClient } from '../src/shared/script-slots-client.ts'
import { homeAssistantClient } from '../src/shared/home-assistant-client.ts'
import { sdkCommand } from '../src/shared/bsp-client.ts'
import { socFromProduct } from '../src/shared/local.ts'

function transport() {
  const calls: Array<{ method: string, path: string, body?: unknown }> = []
  const streams: Array<{ path: string, payload: unknown }> = []
  const client = {
    call: async <T>(method: string, path: string, body?: unknown): Promise<T> => { calls.push({ method, path, body }); return { ok: true } as T },
    streamCommand: async (path: string, payload: unknown) => { streams.push({ path, payload }); return { code: 0, download: null } },
  } as unknown as BoardsClient
  return { client, calls, streams }
}

describe('module client contracts', () => {
  it('keeps the local scan routes and payloads', async () => {
    const { client, calls } = transport()
    const local = localClient(client)
    await local.scan({ slots: [1, 2], confirmed: true })
    await local.scanStatus('a scan/id')
    await local.cancelScan('scan-1')
    expect(calls).toEqual([
      { method: 'POST', path: '/api/scan', body: { slots: [1, 2], confirmed: true } },
      { method: 'GET', path: '/api/scan?id=a%20scan%2Fid', body: undefined },
      { method: 'POST', path: '/api/scan/cancel', body: { id: 'scan-1' } },
    ])
  })

  it('keeps the script-slot and Home Assistant routes and payloads', async () => {
    const { client, calls } = transport()
    const slots = scriptSlotsClient(client), ha = homeAssistantClient(client)
    await slots.save({ slot: 2, resetScript: 'reset', fastbootScript: null })
    await slots.remove(2)
    await ha.configure('http://ha:8123', 'secret')
    await ha.enabled(false)
    await ha.test()
    expect(calls).toEqual([
      { method: 'POST', path: '/api/slots/script', body: { slot: 2, resetScript: 'reset', fastbootScript: null } },
      { method: 'POST', path: '/api/slots/script/remove', body: { slot: 2 } },
      { method: 'POST', path: '/api/ha', body: { url: 'http://ha:8123', token: 'secret' } },
      { method: 'POST', path: '/api/ha/enabled', body: { enabled: false } },
      { method: 'POST', path: '/api/ha/test', body: undefined },
    ])
  })

  it('streams bsp commands through the generic client, with sdk as the default group', async () => {
    const { client, streams } = transport()
    const write = () => {}
    expect(await sdkCommand(client, ['build'], false, write)).toEqual({ code: 0, download: null })
    await sdkCommand(client, ['status'], true, write, 'raw')
    expect(streams).toEqual([
      { path: '/api/sdk', payload: { args: ['build'], json: false, group: 'sdk' } },
      { path: '/api/sdk', payload: { args: ['status'], json: true, group: 'raw' } },
    ])
  })

  it('keeps the scan product to SoC rules', () => {
    expect(socFromProduct('k3_com260')).toBe('k3')
    expect(socFromProduct('K1-pegasus')).toBe('k1')
    expect(socFromProduct('com260')).toBeNull()
  })
})
