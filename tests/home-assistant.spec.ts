import { describe, expect, it } from 'vitest'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { groupEntities, homeAssistant } from '../src/modules/home-assistant/client.ts'
import { Bench, ha, scanner, service, shipFirmware, slotsOf, useTempDir } from './fakes.ts'

useTempDir()

describe('Home Assistant setup', () => {
  it('can be switched off: its slots go away and it is never pressed, until it is on again', async () => {
    const bench = new Bench([{ slot: 1, serial: [], usb: [] }])
    const svc = service(bench)
    expect(ha(svc).settings().enabled).toBe(true)
    const { token } = await svc.locks.lock('com260', 'claude:s1', '复位')
    expect(() => ha(svc).setEnabled('user:dana', false)).toThrow(/com260 正被 claude:s1 使用/)
    svc.locks.unlock('com260', { holder: 'claude:s1', token })
    expect(ha(svc).setEnabled('user:dana', false)).toMatchObject({ enabled: false })
    expect(slotsOf(svc)).toEqual([])
    expect(svc.boards.get('com260').slot).toBe(1)
    const again = await svc.locks.lock('com260', 'claude:s1', '复位')
    await expect(svc.relay.reset('com260', { holder: 'claude:s1', token: again.token })).rejects.toThrow(/Home Assistant 已关闭/)
    expect(bench.calls).toEqual([])
    svc.locks.unlock('com260', { holder: 'claude:s1', token: again.token })
    expect(ha(svc).setEnabled('user:dana', true).enabled).toBe(true)
    expect(slotsOf(svc).map(slot => slot.slot)).toEqual([0, 1])
  })

  it('groups controller entities into slots', () => {
    const found = groupEntities([
      { entity_id: 'switch.ctrl_board_1_reset', device_id: 'd' },
      { entity_id: 'button.ctrl_board_1_fastboot_mode', device_id: 'd' },
      { entity_id: 'switch.ctrl_board_0_reset', device_id: 'd' },
      { entity_id: 'switch.ctrl_status_led', device_id: 'd' },
      { entity_id: 'sensor.ctrl_uptime', device_id: 'd' },
    ], new Map([['d', 'wanlong-board-ctrl-001']]))
    expect(found.slots).toEqual([
      { slot: 0, resetEntity: 'switch.ctrl_board_0_reset', fastbootEntity: null, device: 'wanlong-board-ctrl-001' },
      { slot: 1, resetEntity: 'switch.ctrl_board_1_reset', fastbootEntity: 'button.ctrl_board_1_fastboot_mode', device: 'wanlong-board-ctrl-001' },
    ])
    expect(found.unassigned).toEqual(['switch.ctrl_status_led'])
  })

  it('calls HA services on a fresh connection and reports rejected tokens without echoing them', async () => {
    const seen: Array<{ method: string, url: string, auth: string, connection: string, body: string }> = []
    const server = createHttpServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization!, connection: String(req.headers.connection), body })
        if (req.headers.authorization !== 'Bearer good') { res.writeHead(401); return res.end('{}') }
        res.setHeader('Content-Type', 'application/json')
        res.end(req.url === '/api/config' ? '{"location_name":"Lab","version":"2026.5.2"}' : req.url === '/api/' ? '{"message":"API running."}' : '[]')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    try {
      expect(await homeAssistant.verify({ url, token: 'good' })).toBe('API running.；Lab 2026.5.2')
      await homeAssistant.call({ url, token: 'good' }, 'switch.ctrl_board_1_reset')
      expect(seen.at(-1)).toMatchObject({ method: 'POST', url: '/api/services/switch/turn_on', connection: 'close', body: '{"entity_id":"switch.ctrl_board_1_reset"}' })
      const error = await homeAssistant.call({ url, token: 'bad-secret' }, 'button.ctrl_board_1_fastboot_mode').then(() => null, (e: Error) => e)
      expect(error?.message).toBe('Home Assistant 拒绝了令牌（401）')
    } finally { server.close() }
  })

  it('retries a request whose connection never opened, but never resends one that reached HA', async () => {
    // Nothing listens yet: the first attempt is refused and a later one connects.
    const probe = createServer()
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as { port: number }).port
    await new Promise<void>(resolve => probe.close(() => resolve()))
    const requests: string[] = []
    const server = createHttpServer((req, res) => {
      requests.push(req.url!)
      if (req.url!.includes('button')) return req.socket.destroy()
      res.setHeader('Content-Type', 'application/json'); res.end('[]')
    })
    setTimeout(() => server.listen(port, '127.0.0.1'), 150)
    const url = `http://127.0.0.1:${port}`
    try {
      await homeAssistant.call({ url, token: 't' }, 'switch.ctrl_board_1_reset')
      await expect(homeAssistant.call({ url, token: 't' }, 'button.ctrl_board_1_fastboot_mode')).rejects.toThrow(/无法连接/)
      expect(requests).toEqual(['/api/services/switch/turn_on', '/api/services/button/press'])
    } finally { server.close() }
  })

  it('keeps slots in step with Home Assistant on its own, without asking anyone', async () => {
    const bench = new Bench([])
    let reported = [0, 1, 2].map(slot => ({ slot, resetEntity: `switch.ctrl_board_${slot}_reset`, fastbootEntity: `button.ctrl_board_${slot}_fastboot_mode`, device: 'ctrl' }))
    bench.ha.discover = async () => ({ devices: [], slots: reported, unassigned: [] })
    const svc = service(bench)
    await ha(svc).test('user:dana')
    expect(slotsOf(svc).map(slot => [slot.slot, slot.resetEntity])).toEqual([[0, 'switch.ctrl_board_0_reset'], [1, 'switch.ctrl_board_1_reset'], [2, 'switch.ctrl_board_2_reset']])
    // Slot 0 disappears from HA and is dropped; slot 1 vanishes too but com260 sits there, so it stays.
    reported = reported.filter(slot => slot.slot === 2)
    await scanner(svc).start('user:dana', { slots: [2], confirmed: true }).catch(() => null)
    expect(slotsOf(svc).map(slot => slot.slot)).toEqual([1, 2])
    // An empty answer changes nothing.
    reported = []
    await ha(svc).test('user:dana')
    expect(slotsOf(svc).map(slot => slot.slot)).toEqual([1, 2])
  })

  it('keeps the stored token when only the address changes and never reports it', async () => {
    const svc = service()
    const settings = await ha(svc).configure('user:dana', { url: 'http://ha.test:8123/' })
    expect(settings).toMatchObject({ url: 'http://ha.test:8123', hasToken: true, verifyOk: true })
    const bad = await ha(svc).configure('user:dana', { url: 'http://ha.test:8123', token: 'wrong' })
    expect(bad).toMatchObject({ verifyOk: false, verifyMessage: 'Home Assistant 拒绝了令牌（401）' })
    expect(JSON.stringify(svc.history())).not.toMatch(/secret-token-value|wrong/)
  })

})
