import { describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase } from 'boardlab-core/core/db.ts'
import { BoardLab } from 'boardlab-core/core/lab.ts'
import { adapterPortName, diffUsb, listSerialAdapters, type SerialAdapter } from '../src/modules/local/hardware.ts'
import { local } from '../src/modules/local/index.ts'
import { scriptSlots } from '../src/modules/script-slots/index.ts'
import { SerialMux, startAlias } from '../src/modules/serial-mux/client.ts'
import { Bench, dir, makeLab, service, shipFirmware, useTempDir } from './fakes.ts'

useTempDir()

describe('inventory', () => {
  it('starts empty: no boards until a scan or a person registers one', () => {
    const svc = makeLab(new Bench([]).options(openDatabase(join(dir, 'empty.sqlite'))))
    expect(svc.state('user:dana')).toMatchObject({ boards: [], slots: [], ha: { url: null, hasToken: false } })
  })

  it('registers boards by hand and exports TOML', async () => {
    const svc = service()
    expect(svc.boards.get('com260')).toMatchObject({ slot: 1, product: 'k3_com260', soc: 'k3', source: 'manual' })
    expect(() => svc.boards.add('user:dana', { name: 'other', slot: 1 })).toThrow(/槽位 1 已有/)
    expect(svc.boards.exportToml()).toContain('[boards.com260.die0]')
    await svc.boards.remove('user:dana', 'com260')
    expect(svc.boards.list()).toEqual([])
  })

  it('only offers consoles on serial ports that have a device bound', async () => {
    const bench = new Bench([])
    bench.offline.add('com260')
    const svc = service(bench)
    expect(svc.boards.get('com260').chips[0]!.online).toBe(false)
    await expect(svc.consoles.open('com260')).rejects.toThrow(/没有绑定设备/)
    await svc.locks.lock('com260', 'user:dana', '调试')
    await expect(svc.consoles.send('com260', { holder: 'user:dana' }, { text: 'x' })).rejects.toThrow(/没有绑定设备/)
  })

  it('moves a board\'s serial-mux daemons to its new name, keeping their ports, and the lock follows', async () => {
    const bench = new Bench([{ slot: 1, serial: ['/dev/ttyUSB1'], usb: [] }])
    bench.names.clear(); bench.names.set('/dev/ttyUSB1', 'com260')
    const svc = makeLab(bench.options(openDatabase(join(dir, 'rename.sqlite'))))
    svc.boards.add('user:dana', { name: 'com260', slot: 1, chips: [{ serialPath: '/dev/ttyUSB1', alias: 'com260' }] })
    const held = await svc.locks.lock('com260', 'user:dana', '调试')
    const out = await svc.backends.rename('user:dana', 'com260', 'pegasus', { holder: 'user:dana', token: held.token })
    expect(out.board).toBe('pegasus')
    expect(bench.names.get('/dev/ttyUSB1')).toBe('pegasus')
    expect(bench.started.at(-1)).toEqual(['/dev/ttyUSB1', 'pegasus'])
    expect(bench.gates.get('pegasus')?.token).toBe(held.gateToken)
    const board = svc.boards.get('pegasus')
    expect(board.chips[0]!.alias).toBe('pegasus')
    expect(board.lease?.holder).toBe('user:dana')
    expect(() => svc.boards.get('com260')).toThrow(/没有这块板/)
    // An unplugged console is just renamed on the record: its daemon starts under the new name on the next scan.
    bench.names.clear()
    const again = await svc.backends.rename('user:dana', 'pegasus', 'atlas', { holder: 'user:dana', token: held.token })
    expect(again.board).toBe('atlas')
    expect(svc.boards.get('atlas').chips[0]!.alias).toBe('atlas')
  })
})

describe('console and firmware', () => {
  it('sends input under a lease and waits for a pattern', async () => {
    const bench = new Bench([])
    const svc = service(bench)
    await svc.locks.lock('com260', 'user:dana', '调试')
    const result = await svc.consoles.send('com260', { holder: 'user:dana' }, { text: 'uname -a', wait: 'root@board' })
    expect(result).toMatchObject({ matched: true })
    expect(bench.sent).toEqual([{ alias: 'com260', data: 'uname -a\n' }])
    expect(await svc.consoles.log('com260')).toEqual(['[t] old line'])
    await svc.locks.unlock('com260', { holder: 'user:dana' })
    await expect(svc.consoles.send('com260', { holder: 'user:dana' }, { text: 'x' })).rejects.toThrow(/请先拿/)
  })

  it('types into a console as a terminal does, over one session per lock, passing the gate', async () => {
    const bench = new Bench([])
    const svc = service(bench)
    await expect(svc.consoles.input('com260', { holder: 'claude:s1' }, { data: 'l' })).rejects.toThrow(/请先拿/)
    const { token } = await svc.locks.lock('com260', 'claude:s1', '交互')
    await svc.locks.settle('com260')
    for (const data of ['l', 's', '\r', '\x03']) await svc.consoles.input('com260', { holder: 'claude:s1', token }, { data })
    expect(bench.sent).toEqual(['l', 's', '\r', '\x03'].map(data => ({ alias: 'com260', data })))
    expect(svc.boards.detail('com260').actions.filter(action => action.kind === 'console-input')).toHaveLength(1)
    svc.locks.unlock('com260', { holder: 'claude:s1', token })
    const again = await svc.locks.lock('com260', 'claude:s1', '交互')
    await svc.consoles.input('com260', { holder: 'claude:s1', token: again.token }, { data: 'x' })
    expect(svc.boards.detail('com260').actions.filter(action => action.kind === 'console-input')).toHaveLength(2)
  })

  it('lets a person type without the lock, never an agent, and still passes the gate', async () => {
    const bench = new Bench([])
    const svc = service(bench)
    const { token } = await svc.locks.lock('com260', 'claude:s1', '跑测试')
    await svc.locks.settle('com260')
    await expect(svc.consoles.input('com260', { holder: 'claude:s2' }, { data: 'x', human: true })).rejects.toThrow(/正被 claude:s1 使用/)
    await svc.consoles.input('com260', { holder: 'user:dana' }, { data: '\x03', human: true })
    expect(bench.sent).toEqual([{ alias: 'com260', data: '\x03' }])
    expect(svc.boards.detail('com260').actions.find(action => action.kind === 'console-input')?.detail).toBe('die0（人，不查锁；锁在 claude:s1 手里）')
    // The person's typing session outlives the agent's lock.
    svc.locks.unlock('com260', { holder: 'claude:s1', token })
    await svc.consoles.input('com260', { holder: 'user:dana' }, { data: 'y', human: true })
    expect(bench.sent.at(-1)).toEqual({ alias: 'com260', data: 'y' })
  })

  it('only stages its own firmware whose content still matches firmware.json', async () => {
    const bench = new Bench([])
    const svc = service(bench)
    const file = shipFirmware('minor-board-info', 'image-v1')
    expect(svc.download.firmware()).toMatchObject([{ soc: 'k3', purpose: 'minor-board-info', path: file }])
    await svc.locks.lock('com260', 'user:dana', '读型号')
    await svc.download.stage('com260', { holder: 'user:dana' }, { firmware: 'minor-board-info' })
    expect(bench.staged.get('3-2.3')).toBe(file)
    await expect(svc.download.stage('com260', { holder: 'user:dana' }, { firmware: 'fsbl' })).rejects.toThrow(/没有自带 k3 的固件 fsbl/)
    writeFileSync(file, 'tampered')
    await expect(svc.download.stage('com260', { holder: 'user:dana' }, { firmware: 'minor-board-info' })).rejects.toThrow(/sha256 与 firmware.json 不符/)
  })

  it('boots from RAM by staging each file in order once the download port is back', async () => {
    const bench = new Bench([])
    bench.usbPresent.push({ path: '3-2.3', usbId: '361c:1001', serial: '????????????', product: null })
    const order: string[] = []
    const run = bench.options().hardware.fastboot.run
    const svc = makeLab({ ...bench.options(openDatabase(join(dir, 'boot.sqlite'))), sleep: async () => {}, bootTiming: { firstMs: 0, laterMs: 0, waitMs: 2, pollMs: 1 },
      hardware: { ...bench.options().hardware, fastboot: { run: async args => { if (args[2] === 'stage') order.push(args[3]!); return run(args) } } } })
    svc.boards.add('user:dana', { name: 'com260', slot: 1, chips: [{ serialPath: '/dev/ttyUSB1', alias: 'com260', downloadUsbPath: '3-2.3' }] })
    const files = ['FSBL.bin', 'u-boot-opensbi.itb', 'Image.itb'].map(name => { const file = join(dir, name); writeFileSync(file, name); return file })
    const fsbl = shipFirmware('fsbl', 'shipped FSBL')
    await expect(svc.download.boot('com260', { holder: 'claude:s1' }, { files })).rejects.toThrow(/请先拿/)
    const { token } = await svc.locks.lock('com260', 'claude:s1', '内存启动内核')
    const claude = { holder: 'claude:s1', token }
    await expect(svc.download.boot('com260', claude, { files: ['FSBL.bin'] })).rejects.toThrow(/绝对路径/)
    const output = await svc.download.boot('com260', claude, { files })
    expect(order).toEqual(files)
    expect(output).toContain('1. ' + files[0])
    expect(svc.boards.detail('com260').actions.filter(action => action.kind === 'boot').map(action => action.ok)).toEqual([true, true, true])

    // A bare name is boardd's own firmware, checked against firmware.json like any stage.
    order.length = 0
    await svc.download.boot('com260', claude, { files: ['fsbl', files[2]!] })
    expect(order).toEqual([fsbl, files[2]])
    await expect(svc.download.boot('com260', claude, { files: ['u-boot-opensbi', files[2]!] })).rejects.toThrow(/没有自带固件 u-boot-opensbi/)

    // A stage that never brings the port back stops the boot before the next file.
    order.length = 0
    bench.usbPresent = bench.usbPresent.filter(device => device.path !== '3-2.3')
    await expect(svc.download.boot('com260', claude, { files })).rejects.toThrow(/第 2 个文件.*没有重新出现/)
    expect(order).toEqual([files[0]])
  })
})

describe('modules', () => {
  it('refuse to load without the modules they need, or twice', () => {
    const lab = new BoardLab({ db: openDatabase(join(dir, 'order.sqlite')) })
    expect(() => lab.use(scriptSlots({ runner: { run: async () => ({ code: 0, output: '', timedOut: false }) } }))).toThrow(/needs local/)
    const bench = new Bench([])
    lab.use(local({ mux: bench.options().mux, hardware: bench.options().hardware }))
    expect(() => lab.use(local({ mux: bench.options().mux, hardware: bench.options().hardware }))).toThrow(/loaded twice/)
    expect(lab.modules().map(item => item.id)).toEqual(['local'])
  })
})

describe('usb diff', () => {
  it('reports devices that appeared and disappeared', () => {
    const a = { path: '3-2.3', usbId: '361c:1001', serial: null, product: null }
    const b = { path: '3-6', usbId: '0403:6001', serial: null, product: null }
    expect(diffUsb([b], [a, b])).toEqual({ added: [a], removed: [] })
  })
})

describe('multi-port serial adapters', () => {
  // A quad FTDI (1-2.3) has four ttys, one per USB interface, beside a single-port adapter (1-2.1).
  const ports = [['ttyUSB4', '1-2.1', '1.0'], ['ttyUSB5', '1-2.3', '1.0'], ['ttyUSB6', '1-2.3', '1.1'], ['ttyUSB7', '1-2.3', '1.2'], ['ttyUSB8', '1-2.3', '1.3']] as const
  const byPath = (usb: string, iface: string) => `pci-0000:00:14.0-usb-0:${usb.replace(/^\d+-/, '')}:${iface}-port0`

  function sysfs() {
    const sys = join(dir, 'sys'), dev = join(dir, 'dev')
    mkdirSync(join(sys, 'class/tty'), { recursive: true })
    mkdirSync(join(dev, 'serial/by-path'), { recursive: true })
    for (const [tty, usb, iface] of ports) {
      const device = join(sys, 'devices/pci0000:00/0000:00:14.0/usb1/1-2', usb, `${usb}:${iface}`, tty)
      mkdirSync(device, { recursive: true })
      mkdirSync(join(sys, 'class/tty', tty), { recursive: true })
      symlinkSync(device, join(sys, 'class/tty', tty, 'device'))
      mkdirSync(join(sys, 'bus/usb/devices', usb), { recursive: true })
      writeFileSync(join(sys, 'bus/usb/devices', usb, 'idVendor'), '0403\n')
      writeFileSync(join(dev, tty), '')
      symlinkSync(join(dev, tty), join(dev, 'serial/by-path', byPath(usb, iface)))
    }
    return { sys, dev }
  }

  it('tells the ports of one adapter apart by their USB interface', () => {
    const { sys, dev } = sysfs()
    const adapters = listSerialAdapters(dev, sys)
    expect(adapters.map(adapter => [adapter.device.split('/').at(-1), adapter.usbPath, adapter.usbInterface])).toEqual(ports.map(([tty, usb, iface]) => [tty, usb, `${usb}:${iface}`]))
    expect(adapters.map(adapter => adapter.link)).toEqual(ports.map(([, usb, iface]) => join(dev, 'serial/by-path', byPath(usb, iface))))
    // Only the adapter whose ports share one USB port needs the interface in its name.
    expect(adapters.map(adapter => adapterPortName(adapter, adapters))).toEqual(['1-2.1', '1-2.3-1.0', '1-2.3-1.1', '1-2.3-1.2', '1-2.3-1.3'])
  })

  it('starts a daemon for each port, not one for the whole adapter', async () => {
    const home = join(dir, 'mux')
    mkdirSync(join(home, 'run'), { recursive: true })
    mkdirSync(join(home, 'sock'), { recursive: true })
    const mux = new SerialMux(home)
    const calls: string[][] = []
    const run = async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'stop') { rmSync(mux.socketPath(args[1]!), { force: true }); rmSync(join(home, 'run', `${args[1]}.json`), { force: true }) }
      if (args[0] !== 'start') return
      const alias = args[2]!, link = args[5]!
      const iface = link.match(/usb-0:([\d.]+:\d+\.\d+)-port0$/)![1]
      writeFileSync(mux.socketPath(alias), '')
      writeFileSync(join(home, 'run', `${alias}.json`), JSON.stringify({ alias, device: link, baud: 115200, pid: 1, socket: mux.socketPath(alias), usb_port: `pci0000:00/0000:00:14.0/usb/usb-1/usb-${iface.split(':')[0]}/usb-${iface}` }))
    }
    const adapter = (iface: string): SerialAdapter => ({ link: `/dev/serial/by-path/${byPath('1-2.3', iface)}`, device: `/dev/ttyUSB${5 + Number(iface.split('.')[1])}`, usbPath: '1-2.3', usbInterface: `1-2.3:${iface}` })
    for (const iface of ['1.0', '1.1', '1.2', '1.3']) await startAlias(mux, adapter(iface), `port-1-2.3-${iface}`, 115200, run)
    // Each port got its own daemon, and none stopped another port's daemon of the same adapter.
    expect(calls.map(args => args.slice(0, 3))).toEqual(['1.0', '1.1', '1.2', '1.3'].map(iface => ['start', '--alias', `port-1-2.3-${iface}`]))
    expect(mux.daemons().map(daemon => daemon.alias).sort()).toEqual(['port-1-2.3-1.0', 'port-1-2.3-1.1', 'port-1-2.3-1.2', 'port-1-2.3-1.3'])
    // A port already under the name it asks for is left running; a new name for a held port replaces the old one.
    calls.length = 0
    await startAlias(mux, adapter('1.2'), 'port-1-2.3-1.2', 115200, run)
    expect(calls).toEqual([])
    await startAlias(mux, adapter('1.2'), 'gemini-die0', 115200, run)
    expect(calls.map(args => args.slice(0, 3))).toEqual([['stop', 'port-1-2.3-1.2'], ['start', '--alias', 'gemini-die0']])
  })
})
