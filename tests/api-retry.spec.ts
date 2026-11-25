// @vitest-environment jsdom
/** The page's calls while boardd is away: a read waits for it to come back, a write is never sent twice. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { call } from '../src/ui/api.ts'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('the page while boardd restarts', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('tries a read again after a failed connection or a proxy 502, and gives a write one try', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json(502, { error: 'bad gateway' }))
      .mockResolvedValueOnce(json(200, { ok: true }))
    vi.stubGlobal('fetch', fetch)
    const read = call('GET', 'api/state')
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(read).resolves.toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(3)

    fetch.mockReset().mockResolvedValue(json(502, { error: 'bad gateway' }))
    await expect(call('POST', 'api/reset', { board: 'b1' })).rejects.toMatchObject({ status: 502 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('takes boardd\'s own 502 (a board host that failed, with its code) as the answer, without trying again', async () => {
    const fetch = vi.fn().mockResolvedValue(json(502, { error: '主机没有回答', code: 'hardware' }))
    vi.stubGlobal('fetch', fetch)
    await expect(call('GET', 'api/boards/b1/config')).rejects.toMatchObject({ status: 502, code: 'hardware', message: '主机没有回答' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
