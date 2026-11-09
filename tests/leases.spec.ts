import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { openDatabase } from 'boardlab-core/core/db.ts'
import { Bench, dir, makeLab, scanner, service, useTempDir } from './fakes.ts'

useTempDir()

describe('leases', () => {
  it('lets only the holder operate and never expires a lock', async () => {
    let now = Date.parse('2026-10-28T10:00:00Z')
    const bench = new Bench([])
    const svc = service(bench, () => now)
    const agent = await svc.locks.lock('com260', 'claude:s1', '看启动日志')
    await expect(svc.locks.lock('com260', 'user:dana', 'x')).rejects.toThrow(/正被 claude:s1 使用/)
    await expect(svc.relay.reset('com260', { holder: 'claude:s1' })).rejects.toThrow(/正被 claude:s1 使用/)
    await expect(svc.relay.reset('com260', { holder: 'user:dana' })).rejects.toThrow(/正被/)
    await svc.relay.reset('com260', { holder: 'claude:s1', token: agent.token })
    expect(bench.calls).toEqual(['switch.ctrl_001_board_1_reset'])
    now += 30 * 24 * 3_600_000
    expect(svc.boards.get('com260').lease!.holder).toBe('claude:s1')
    // Asking again while holding re-issues the token; the old one stops working.
    const again = await svc.locks.lock('com260', 'claude:s1', '看启动日志')
    expect(again.lease!.id).toBe(agent.lease!.id)
    expect(() => svc.locks.authorize('com260', { holder: 'claude:s1', token: agent.token })).toThrow(/正被/)
    svc.locks.authorize('com260', { holder: 'claude:s1', token: again.token })
  })

  it('queues people first come, first served and hands the lock over on release', async () => {
    const svc = service()
    const events: unknown[] = []
    svc.events.on('event', event => events.push(event))
    await svc.locks.lock('com260', 'user:dana', '调试')
    expect(await svc.locks.lock('com260', 'user:alice', '回归测试', { queue: 'join' })).toMatchObject({ lease: null, queued: { position: 1 } })
    expect(await svc.locks.lock('com260', 'user:bob', '看日志', { queue: 'join' })).toMatchObject({ queued: { position: 2 } })
    // Joining twice keeps the original place.
    expect(await svc.locks.lock('com260', 'user:alice', '回归测试', { queue: 'join' })).toMatchObject({ queued: { position: 1 } })
    await expect(svc.locks.lock('com260', 'user:carol', '插队')).rejects.toThrow(/2 人排队/)
    expect(svc.boards.get('com260').waiters.map(waiter => waiter.holder)).toEqual(['user:alice', 'user:bob'])

    svc.locks.unlock('com260', { holder: 'user:dana' })
    expect(svc.boards.get('com260').lease).toMatchObject({ holder: 'user:alice', purpose: '回归测试' })
    expect(events).toContainEqual({ type: 'lease-granted', board: 'com260', holder: 'user:alice' })
    // A free board with a queue still goes to the queue, not to whoever asks.
    svc.locks.unlock('com260', { holder: 'user:alice' })
    expect(svc.boards.get('com260').lease!.holder).toBe('user:bob')
    expect(svc.boards.get('com260').waiters).toEqual([])
  })

  it('keeps the queue across a restart and lets people leave it', async () => {
    const bench = new Bench([])
    const svc = service(bench)
    await svc.locks.lock('com260', 'user:dana', '调试')
    await svc.locks.lock('com260', 'user:alice', 'a', { queue: 'join' })
    await svc.locks.lock('com260', 'user:bob', 'b', { queue: 'join' })
    const restarted = makeLab(bench.options(openDatabase(join(dir, 'boards.sqlite'))))
    expect(restarted.boards.get('com260').waiters.map(waiter => waiter.holder)).toEqual(['user:alice', 'user:bob'])
    restarted.locks.unqueue('com260', 'user:alice')
    expect(() => restarted.locks.unqueue('com260', 'user:alice')).toThrow(/没有在/)
    restarted.locks.unlock('com260', { holder: 'user:dana' })
    expect(restarted.boards.get('com260').lease!.holder).toBe('user:bob')
  })

  it('waits in the queue and leaves it when the waiting connection goes away', async () => {
    const svc = service()
    await svc.locks.lock('com260', 'user:dana', '调试')
    const granted = svc.locks.lock('com260', 'claude:a', '排队', { queue: 'wait' })
    const abort = new AbortController()
    const leaving = svc.locks.lock('com260', 'claude:b', '排队', { queue: 'wait', signal: abort.signal })
    await new Promise(resolve => setTimeout(resolve, 5))
    abort.abort()
    await expect(leaving).rejects.toThrow(/停止排队/)
    expect(svc.boards.get('com260').waiters.map(waiter => waiter.holder)).toEqual(['claude:a'])
    svc.locks.unlock('com260', { holder: 'user:dana' })
    const result = await granted
    expect(result.lease!.holder).toBe('claude:a')
    svc.locks.authorize('com260', { holder: 'claude:a', token: result.token })
  })

  it('allows only people to steal, with a reason, and tells the previous holder', async () => {
    const svc = service()
    const events: unknown[] = []
    svc.events.on('event', event => events.push(event))
    const agent = await svc.locks.lock('com260', 'claude:s1', '长任务')
    expect(() => svc.locks.steal('com260', 'claude:s2', '急用')).toThrow(/只有人/)
    expect(() => svc.locks.steal('com260', 'user:dana', ' ')).toThrow(/原因/)
    svc.locks.steal('com260', 'user:dana', '板子卡死，需要手动处理')
    expect(svc.boards.get('com260').lease!.holder).toBe('user:dana')
    expect(events).toContainEqual({ type: 'lease-stolen', board: 'com260', from: 'claude:s1', by: 'user:dana', reason: '板子卡死，需要手动处理' })
    expect(() => svc.locks.authorize('com260', { holder: 'claude:s1', token: agent.token })).toThrow(/正被 user:dana/)
  })
})

describe('serial gates', () => {
  it('lets only the holder type into a locked board and opens the port again on release', async () => {
    const bench = new Bench([])
    const svc = service(bench)
    const lock = await svc.locks.lock('com260', 'claude:s1', '调内核')
    await svc.locks.settle('com260')
    expect(bench.gates.get('com260')).toEqual({ token: lock.gateToken, note: 'claude:s1 正在使用 com260（调内核）' })
    // boardd presents the gate token itself, so the holder's input through boardd passes.
    await svc.consoles.send('com260', { holder: 'claude:s1', token: lock.token }, { text: 'uname -a', timeoutMs: 20 })
    expect(bench.sent.map(item => item.data)).toEqual(['uname -a\n'])
    // Asking for the lock again re-issues the lease token but keeps the gate token.
    const again = await svc.locks.lock('com260', 'claude:s1', '调内核')
    expect(again.gateToken).toBe(lock.gateToken)
    svc.locks.unlock('com260', { holder: 'claude:s1', token: again.token })
    await svc.locks.settle('com260')
    expect(bench.gates.has('com260')).toBe(false)
  })

  it('moves the gate to whoever gets the lock next', async () => {
    const bench = new Bench([])
    const svc = service(bench)
    const alice = await svc.locks.lock('com260', 'user:alice', '调试')
    await svc.locks.lock('com260', 'user:bob', '排队', { queue: 'join' })
    svc.locks.unlock('com260', { holder: 'user:alice' })
    await svc.locks.settle('com260')
    const bob = await svc.locks.lock('com260', 'user:bob', '排队')
    expect(bob.gateToken).not.toBe(alice.gateToken)
    expect(bench.gates.get('com260')!.token).toBe(bob.gateToken)
    const carol = svc.locks.steal('com260', 'user:carol', '紧急修复')
    await svc.locks.settle('com260')
    expect(bench.gates.get('com260')).toEqual({ token: carol.gateToken, note: 'user:carol 正在使用 com260（抢锁）' })
  })

  it('reports a serial-mux without the gate instead of leaving input silently open', async () => {
    const bench = new Bench([])
    bench.oldMux.add('com260')
    const svc = service(bench)
    await svc.locks.lock('com260', 'user:dana', '调试')
    await svc.locks.settle('com260')
    expect(svc.boards.get('com260').chips[0]!.gateError).toMatch(/版本太旧，不支持输入闸门/)
    expect(svc.history().actions.find(action => action.kind === 'gate')).toMatchObject({ ok: false, board: 'com260', detail: 'com260' })
    // A free port with an old serial-mux is open, which is what releasing asks for.
    svc.locks.unlock('com260', { holder: 'user:dana' })
    await svc.locks.settle('com260')
    expect(svc.boards.get('com260').chips[0]!.gateError).toBeNull()
  })

  it('gates ports again after a scan restarted their daemons', async () => {
    const bench = new Bench([
      { slot: 0, serial: ['/dev/serial/by-id/ftdi-A'], usb: [] },
      { slot: 1, serial: ['/dev/serial/by-id/com260-uart'], usb: [{ path: '3-2.3', usbId: '361c:1001', product: 'k3_com260', serial: '/dev/serial/by-id/com260-uart' }] },
    ])
    const svc = service(bench)
    svc.boards.add('user:dana', { name: 'pico', slot: 0, product: 'k3-pico-itx', chips: [{ serialPath: '/dev/serial/by-id/ftdi-A', alias: 'pico' }] })
    // Someone takes the board outside the scan while it runs; the scan still stops every daemon.
    const id = (await scanner(svc).start('user:dana', { slots: [1], confirmed: true })).id
    const alice = await svc.locks.lock('pico', 'user:alice', '跑测试')
    await svc.locks.settle('pico')
    for (let i = 0; i < 200 && scanner(svc).get(id).status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(scanner(svc).get(id).status).toBe('done')
    expect(bench.names.get('/dev/serial/by-id/ftdi-A')).toBe('pico')
    expect(bench.gates.get('pico')!.token).toBe(alice.gateToken)
  })

  it('gives leases taken before the upgrade a gate token', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const file = join(dir, 'v1.sqlite')
    const old = new DatabaseSync(file)
    old.exec(`CREATE TABLE leases (id TEXT PRIMARY KEY, board TEXT NOT NULL, holder TEXT NOT NULL, purpose TEXT NOT NULL,
      token_hash TEXT NOT NULL, started_at TEXT NOT NULL, status TEXT NOT NULL, ended_at TEXT, end_reason TEXT); PRAGMA user_version=1;`)
    old.close()
    const db = openDatabase(file)
    expect(db.prepare('PRAGMA table_info(leases)').all().map(row => row.name)).toContain('gate_token')
    db.prepare(`INSERT INTO leases(id, board, holder, purpose, token_hash, started_at, status) VALUES('l1', 'com260', 'user:dana', '旧锁', 'x', '2026-10-29T00:00:00Z', 'held')`).run()
    const bench = new Bench([])
    const svc = makeLab(bench.options(db))
    svc.boards.add('user:dana', { name: 'com260', slot: 1, chips: [{ serialPath: '/dev/ttyUSB1', alias: 'com260' }] })
    await svc.locks.settle('com260')
    expect(bench.gates.get('com260')!.token).toMatch(/^[\w-]{32}$/)
    expect((await svc.locks.lock('com260', 'user:dana', '旧锁')).gateToken).toBe(bench.gates.get('com260')!.token)
  })
})
