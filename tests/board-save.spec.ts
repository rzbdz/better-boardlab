/**
 * Saving a board's registration: only what changed is validated and sent.
 *
 * A board's download port is only enumerated while the board is in download mode, so a dialog that submits every
 * field would fail a save of, say, its SoC because the port is not visible right now. boardd validates the fields
 * that changed, keeps the registered port allowed while it is away, and sends only the delta to the host.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { openDatabase } from 'boardlab-core/core/db.ts'
import { BoardLab } from 'boardlab-core/core/lab.ts'
import type { Backend } from 'boardlab-core/core/backend.ts'
import { boardctrl } from '../src/modules/boardctrl/index.ts'
import { dir, useTempDir } from './fakes.ts'

useTempDir()

/** A bsp host's driver whose dialog choices are fixed and whose `change` is recorded. */
function recordingBsp(choices: Record<string, unknown>) {
  const saved: Array<Record<string, unknown>> = []
  const backend = {
    title: 'bsp', serial: { open: async () => { throw new Error('no console') } },
    relay: { reset: async () => {}, enterDownload: async () => {}, confirm: async () => '' },
    inventory: {
      verify: async () => 'ok',
      devices: async () => [{ name: 'k1-a', host: 'h1', model: null, soc: null, online: false, serialPort: 'h1:a',
                              serialConnected: true, downloadUsbPath: null, ip: null }],
    },
    boardConfig: async () => choices,
    change: async (_config: unknown, _device: string, _token: string | null, change: Record<string, unknown>) => {
      saved.push(change)
      return Object.keys(change).filter(key => change[key] !== undefined)
    },
  }
  return { backend: backend as unknown as Backend, saved }
}

async function setup(choices: Record<string, unknown>) {
  const lab = new BoardLab({ db: openDatabase(join(dir, 'b.sqlite')), modules: [boardctrl({ sdk: { run: async () => 0 } as never })] })
  const { backend, saved } = recordingBsp(choices)
  lab.backends.register('live', backend)
  await lab.backends.configure('user:alice', 'live', { enabled: true, url: 'http://h1:8765', username: '', password: '', devices: '' })
  await lab.backends.sync('live')
  // The dialog saves under the board's lock: the test's person holds it.
  await lab.locks.lock('live-k1-a', 'user:alice', '改登记')
  const call = async (body: Record<string, unknown>): Promise<{ message: string, error?: string }> => {
    const found = lab.api.match('POST', '/api/boardctrl/board')!
    try {
      const reply = await found.endpoint.handle({ query: new URLSearchParams(), params: found.params, body,
        headers: {}, caller: { holder: 'user:alice', local: true }, signal: new AbortController().signal, upload: null } as never)
      return reply as { message: string }
    } catch (error) { return { message: '', error: (error as Error).message } }
  }
  return { lab, saved, call }
}

const CHOICES = {
  control: { backend: 'gpio-relay', reset: { pin: 'P11' }, fdl: { strategy: 'strapped' } },
  usb: 'usb:2-1.2',            // registered ...
  gpios: [{ value: 'P11', label: 'P11' }, { value: 'P13', label: 'P13' }],
  ports: [] as Array<{ value: string, label: string }>,   // ... but not enumerated now (the board is not in download mode)
  soc: 'k1', sdks: ['vendor-a'],
  socs: [{ value: 'k1', label: 'K1' }, { value: 'k3', label: 'K3' }],
  sdkOptions: [{ value: 'vendor-a', label: 'vendor-a' }],
}

describe('saving a board registration', () => {
  it('saves a field the form submitted unchanged, even though the download port is not enumerated now', async () => {
    const { saved, call } = await setup(CHOICES)
    const result = await call({ board: 'live-k1-a', usb: 'usb:2-1.2', soc: 'k3', sdks: ['vendor-a'] })
    expect(result.error).toBeUndefined()
    expect(saved).toHaveLength(1)
    // Only the SoC is sent: the unchanged port and SDK list are neither validated nor submitted.
    expect(saved[0]).toMatchObject({ soc: 'k3' })
    expect(saved[0].usb).toBeUndefined()
    expect(saved[0].sdks).toBeUndefined()
  })

  it('refuses a download port that is new and not on the bus', async () => {
    const { saved, call } = await setup(CHOICES)
    const result = await call({ board: 'live-k1-a', usb: 'usb:9-9.9' })
    expect(result.error).toContain('不在主机当前检测到的列表里')
    expect(saved).toEqual([])
  })

  it('keeps the SoC check strict: a changed SoC the catalog does not know is refused', async () => {
    const { call } = await setup(CHOICES)
    const result = await call({ board: 'live-k1-a', soc: 'nope' })
    expect(result.error).toContain('没有这个 SoC')
  })

  it('accepts an explicit SDK list that changed and refuses an unknown one', async () => {
    const { saved, call } = await setup({ ...CHOICES, sdkOptions: [{ value: 'vendor-a', label: 'a' }, { value: 'upstream', label: 'u' }] })
    const good = await call({ board: 'live-k1-a', sdks: ['upstream'] })
    expect(good.error).toBeUndefined()
    expect(saved[0]).toMatchObject({ sdks: ['upstream'] })
    expect(saved[0].usb).toBeUndefined()
    const bad = await call({ board: 'live-k1-a', sdks: ['ghost'] })
    expect(bad.error).toContain('没有这些 SDK')
  })
})
