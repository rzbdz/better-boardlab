import { describe, expect, it } from 'vitest'
import type { BoardLab } from 'boardlab-core/core/lab.ts'
import { Bench, ha, scanner, service, shipFirmware, slotsOf, useTempDir } from './fakes.ts'

useTempDir()

describe('scan', () => {
  const wiring = [
    { slot: 0, serial: ['/dev/serial/by-id/ftdi-A'], usb: [{ path: '3-6.4.3', usbId: '361c:1001', product: 'k3-pico-itx', serial: '/dev/serial/by-id/ftdi-A' }] },
    { slot: 1, serial: ['/dev/serial/by-id/com260-uart'], usb: [{ path: '3-2.3', usbId: '361c:1001', product: 'k3_com260', serial: '/dev/serial/by-id/com260-uart' }] },
  ]

  async function finish(svc: BoardLab, id: string) {
    for (let i = 0; i < 200 && scanner(svc).get(id).status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10))
    return scanner(svc).get(id)
  }

  it('needs confirmation and every lease up front', async () => {
    const svc = service(new Bench(wiring))
    await expect(scanner(svc).start('user:dana', { confirmed: false })).rejects.toThrow(/确认/)
    await svc.locks.lock('com260', 'claude:x', '忙')
    await expect(scanner(svc).start('user:dana', { confirmed: true })).rejects.toThrow(/com260 正被 claude:x/)
  })

  it('does not start while any board is held, even outside its scope or by the scanner', async () => {
    const svc = service(new Bench(wiring))
    const agent = await svc.locks.lock('com260', 'claude:x', '忙')
    await expect(scanner(svc).start('user:dana', { slots: [0], confirmed: true })).rejects.toThrow(/com260 正被 claude:x 使用，扫描未开始/)
    svc.locks.unlock('com260', { holder: 'claude:x', token: agent.token })
    await svc.locks.lock('com260', 'user:dana', '自己拿着')
    await expect(scanner(svc).start('user:dana', { slots: [0], confirmed: true })).rejects.toThrow(/com260 正被 user:dana/)
  })

  it('maps slots to serial ports, download ports and products, then proposes inventory changes', async () => {
    const bench = new Bench(wiring)
    const svc = service(bench)
    shipFirmware('minor-board-info', 'minor')
    const scan = await finish(svc, (await scanner(svc).start('user:dana', { confirmed: true })).id)
    expect(scan.status).toBe('done')
    expect(scan.result).toEqual([
      { slot: 0, board: null, flags: [], chips: [{ die: 'die0', serialPath: '/dev/serial/by-id/ftdi-A', downloadUsbPath: '3-6.4.3', usbId: '361c:1001', product: 'k3-pico-itx', pending: false }] },
      { slot: 1, board: 'com260', flags: [], chips: [{ die: 'die0', serialPath: '/dev/serial/by-id/com260-uart', downloadUsbPath: '3-2.3', usbId: '361c:1001', product: 'k3_com260', pending: false }] },
    ])
    // Both slots were restored by a reset and the scan's own leases are gone.
    expect(bench.calls.filter(call => call.endsWith('_reset'))).toEqual(['switch.ctrl_001_board_0_reset', 'switch.ctrl_001_board_1_reset'])
    expect(svc.boards.list().every(board => board.lease === null)).toBe(true)
    expect(scanner(svc).evidence(scan.id).some(item => item.body.includes('product_name=k3_com260'))).toBe(true)
    // The scan trusted no earlier daemon: it stopped them all and listened on fresh ones, which it then took down
    // because no registered board claims those ports yet.
    expect(bench.started).toEqual([['/dev/serial/by-id/com260-uart', 'port-com260-uart'], ['/dev/serial/by-id/ftdi-A', 'port-ftdi-A']])
    expect(bench.stopped).toEqual(['com260', 'port-com260-uart', 'port-ftdi-A'])
    expect(bench.names).toEqual(new Map())

    const proposals = svc.state('user:dana').proposals
    expect(proposals.map(item => item.summary)).toEqual([
      '槽位 0 发现新板子（k3-pico-itx）',
      'com260.die0 串口 /dev/ttyUSB1 → /dev/serial/by-id/com260-uart',
    ])
    await svc.proposals.resolve('user:dana', proposals.map(item => item.id), 'apply')
    expect(svc.boards.get('k3-pico-itx-slot0')).toMatchObject({ slot: 0, product: 'k3-pico-itx', soc: 'k3', source: 'scan' })
    // Applying renames each identified port's daemon after its board.
    expect(svc.boards.get('k3-pico-itx-slot0').chips[0]).toMatchObject({ serialPath: '/dev/serial/by-id/ftdi-A', alias: 'k3-pico-itx-slot0', downloadUsbPath: '3-6.4.3' })
    expect(svc.boards.get('com260').chips[0]).toMatchObject({ serialPath: '/dev/serial/by-id/com260-uart', alias: 'com260' })
    expect(bench.names).toEqual(new Map([['/dev/serial/by-id/com260-uart', 'com260'], ['/dev/serial/by-id/ftdi-A', 'k3-pico-itx-slot0']]))
  })

  it('still finds a download port that was already up from an earlier fastboot press', async () => {
    const bench = new Bench(wiring)
    // Slot 1 was left in boot-ROM mode: its download port is present before the scan starts.
    bench.usbPresent.push({ path: '3-2.3', usbId: '361c:1001', serial: '????????????', product: null, devnum: 3 })
    const svc = service(bench)
    shipFirmware('minor-board-info', 'minor')
    const scan = await finish(svc, (await scanner(svc).start('user:dana', { slots: [1], confirmed: true })).id)
    expect(scan.result[0]!.chips[0]).toMatchObject({ downloadUsbPath: '3-2.3', product: 'k3_com260' })
  })

  it('keeps the ROM banner in the evidence even though it starts with NUL bytes', async () => {
    const svc = service(new Bench(wiring))
    const scan = await finish(svc, (await scanner(svc).start('user:dana', { slots: [1], confirmed: true })).id)
    const round = scanner(svc).evidence(scan.id).find(item => item.label.startsWith('第 1 次 fastboot'))!
    expect(round.body).toBe('sys: 0x10001200\r\nROM: usb download handler\r\n')
  })

  it('does not register a board whose product it could not read', async () => {
    // Serial answers on slot 0, but its download cable is missing, so minor-board-info cannot run.
    const bench = new Bench([{ slot: 0, serial: ['/dev/serial/by-id/ftdi-A'], usb: [] }])
    const svc = service(bench)
    shipFirmware('minor-board-info', 'minor')
    const scan = await finish(svc, (await scanner(svc).start('user:dana', { slots: [0], confirmed: true })).id)
    expect(scan.result[0]!.flags).toEqual(['fastboot 后没有出现下载口', '认不出型号，没有登记为板子；按上面的原因处理后重新扫描'])
    expect(svc.state('user:dana').proposals).toEqual([])
    expect(bench.names).toEqual(new Map())
  })

  it('renames a board an earlier scan registered under a placeholder once its product is read', async () => {
    const bench = new Bench(wiring)
    const svc = service(bench)
    shipFirmware('minor-board-info', 'minor')
    const db = svc.kernel.db
    db.prepare(`INSERT INTO boards(name, slot, source) VALUES('board-slot0', 0, 'scan')`).run()
    db.prepare(`INSERT INTO chips(board, die, serial_path, alias) VALUES('board-slot0', 'die0', '/dev/serial/by-id/ftdi-A', 'board-slot0')`).run()
    await svc.locks.lock('board-slot0', 'user:alice', '调试')
    await svc.locks.lock('board-slot0', 'user:bob', '排队', { queue: 'join' })
    const scan = scanner(svc).start('user:dana', { slots: [0], confirmed: true })
    await expect(scan).rejects.toThrow(/board-slot0 正被 user:alice/)
    svc.locks.unlock('board-slot0', { holder: 'user:alice' })
    svc.locks.unlock('board-slot0', { holder: 'user:bob' })
    await finish(svc, (await scanner(svc).start('user:dana', { slots: [0], confirmed: true })).id)
    const proposals = svc.state('user:dana').proposals
    expect(proposals.map(item => item.summary)).toContain('board-slot0 读到型号 k3-pico-itx，改名为 k3-pico-itx-slot0')
    await svc.locks.lock('board-slot0', 'user:carol', '持锁时改名')
    await svc.proposals.resolve('user:dana', proposals.map(item => item.id), 'apply')
    expect(svc.boards.list().map(board => board.name)).toContain('k3-pico-itx-slot0')
    expect(svc.boards.get('k3-pico-itx-slot0')).toMatchObject({ product: 'k3-pico-itx', lease: { holder: 'user:carol' } })
    expect(svc.boards.get('k3-pico-itx-slot0').chips[0]).toMatchObject({ alias: 'k3-pico-itx-slot0', downloadUsbPath: '3-6.4.3' })
    expect(bench.names.get('/dev/serial/by-id/ftdi-A')).toBe('k3-pico-itx-slot0')
  })

  it('gives every registered board its serial-mux daemon back when a scan ends', async () => {
    const bench = new Bench(wiring)
    const svc = service(bench)
    shipFirmware('minor-board-info', 'minor')
    const db = svc.kernel.db
    db.prepare(`UPDATE chips SET serial_path='/dev/serial/by-id/com260-uart' WHERE board='com260'`).run()
    // Slot 0 holds a board outside the scan; its daemon was stopped all the same.
    svc.boards.add('user:dana', { name: 'pico', slot: 0, product: 'k3-pico-itx', chips: [{ serialPath: '/dev/serial/by-id/ftdi-A', alias: 'pico', downloadUsbPath: '3-6.4.3' }] })
    const scan = await finish(svc, (await scanner(svc).start('user:dana', { slots: [1], confirmed: true })).id)
    expect(scan.status).toBe('done')
    // Nothing changed, so no proposal would have renamed the scan's `port-*` listeners.
    expect(svc.state('user:dana').proposals).toEqual([])
    expect(bench.names).toEqual(new Map([['/dev/serial/by-id/com260-uart', 'com260'], ['/dev/serial/by-id/ftdi-A', 'pico']]))
  })

  it('notices a moved cable and a board that does not answer', async () => {
    const moved = [
      { slot: 0, serial: [], usb: [] },
      { slot: 1, serial: ['/dev/serial/by-id/ftdi-A'], usb: [{ path: '3-2.4', usbId: '361c:1001', product: 'k3_com260', serial: '/dev/serial/by-id/ftdi-A' }] },
    ]
    const svc = service(new Bench(moved))
    shipFirmware('minor-board-info', 'minor')
    const scan = await finish(svc, (await scanner(svc).start('user:dana', { confirmed: true })).id)
    expect(scan.result[0]!.flags).toEqual(['无串口响应（可能没上电、没接线或板子坏了）', 'fastboot 后没有出现下载口'])
    expect(svc.state('user:dana').proposals.map(item => item.kind)).toEqual(['serial-moved', 'download-moved'])
  })

  it('groups two chips on one board and marks unknown non-K3 download ports', async () => {
    const svc = service(new Bench([
      { slot: 1, serial: ['/dev/serial/by-id/d0', '/dev/serial/by-id/d1'], usb: [
        { path: '3-1.2', usbId: '361c:1001', product: 'k3_dual', serial: '/dev/serial/by-id/d1' },
        { path: '3-1.1', usbId: '361c:1001', product: 'k3_dual', serial: '/dev/serial/by-id/d0' },
      ] },
      { slot: 0, serial: ['/dev/serial/by-id/k1'], usb: [{ path: '3-9', usbId: '361c:1000' }] },
    ]))
    shipFirmware('minor-board-info', 'minor')
    const scan = await finish(svc, (await scanner(svc).start('user:dana', { slots: [0, 1], confirmed: true })).id)
    expect(scan.result[0]!.chips).toEqual([{ die: 'die0', serialPath: '/dev/serial/by-id/k1', downloadUsbPath: '3-9', usbId: '361c:1000', product: null, pending: false }])
    expect(scan.result[0]!.flags).toEqual(['下载口 3-9（361c:1000）不是 K3，型号未知', '认不出型号，没有登记为板子；按上面的原因处理后重新扫描'])
    expect(scan.result[1]!.chips.map(chip => [chip.die, chip.downloadUsbPath, chip.serialPath])).toEqual([
      ['die0', '3-1.1', '/dev/serial/by-id/d0'], ['die1', '3-1.2', '/dev/serial/by-id/d1'],
    ])
    // Slot 1 held com260, so the scan proposes a board swap; each chip's daemon is named <board>-<die>.
    const swap = svc.state('user:dana').proposals.find(item => item.slot === 1)!
    expect(swap.kind).toBe('replace-board')
    await svc.proposals.resolve('user:dana', [swap.id], 'apply')
    expect(svc.boards.get('com260').chips.map(chip => [chip.die, chip.alias])).toEqual([['die0', 'com260-die0'], ['die1', 'com260-die1']])
  })

  it('stops between steps when cancelled and still restores touched slots', async () => {
    const bench = new Bench(wiring)
    const svc = service(bench)
    const scan = await scanner(svc).start('user:dana', { confirmed: true })
    while (!bench.calls.length) await new Promise(resolve => setTimeout(resolve, 1))
    scanner(svc).cancel('user:dana', scan.id)
    const done = await finish(svc, scan.id)
    expect(done.status).toBe('cancelled')
    expect(bench.calls.filter(call => call.includes('board_1'))).toEqual([])
    expect(bench.calls.at(-1)).toBe('switch.ctrl_001_board_0_reset')
    expect(svc.boards.list().every(board => board.lease === null)).toBe(true)
  })
})
