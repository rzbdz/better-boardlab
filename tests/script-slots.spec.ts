import { describe, expect, it } from 'vitest'
import type { BoardLab } from 'boardlab-core/core/lab.ts'
import { scriptRunner } from '../src/modules/local/hardware.ts'
import { Bench, ha, scanner, scripts, service, slotsOf, useTempDir } from './fakes.ts'

useTempDir()

describe('script slots', () => {
  it('adds a slot run by scripts, which can only reset without a fastboot script', async () => {
    const bench = new Bench([])
    const svc = service(bench)
    const slot = scripts(svc).save('user:dana', { slot: 5, label: '米家插座', resetScript: 'echo plug off-on' })
    expect(slot).toMatchObject({ slot: 5, kind: 'script', label: '米家插座', canReset: true, canFastboot: false, fastbootScript: null })
    expect(() => scripts(svc).save('user:dana', { slot: 1, resetScript: 'true' })).toThrow(/属于 Home Assistant/)
    expect(() => scripts(svc).save('user:dana', { slot: 6, resetScript: '  ' })).toThrow(/复位脚本不能为空/)

    await svc.locks.lock('slot:5', 'user:dana', '试插座')
    await svc.relay.reset('slot:5', { holder: 'user:dana' })
    expect(bench.scriptRuns).toEqual([{ script: 'echo plug off-on', env: { BOARDS_SLOT: '5', BOARDS_ACTION: 'reset', BOARDS_BOARD: '' } }])
    expect(svc.history().actions[0]).toMatchObject({ kind: 'reset', ok: true, detail: '槽位 5 的复位脚本', message: 'plug off-on' })
    await expect(svc.relay.fastboot('slot:5', { holder: 'user:dana' })).rejects.toThrow(/槽位 5 只能复位/)

    // Adding a fastboot script later lets it switch the board too.
    expect(scripts(svc).save('user:dana', { slot: 5, label: '米家插座', resetScript: 'echo off-on', fastbootScript: 'echo strap' }).canFastboot).toBe(true)
    await svc.relay.fastboot('slot:5', { holder: 'user:dana' })
    expect(bench.scriptRuns.at(-1)!.env.BOARDS_ACTION).toBe('fastboot')
  })

  it('reports a failing script with its exit code', async () => {
    const svc = service(new Bench([]))
    scripts(svc).save('user:dana', { slot: 6, resetScript: 'echo relay offline\nexit 7' })
    await svc.locks.lock('slot:6', 'user:dana', '试')
    await expect(svc.relay.reset('slot:6', { holder: 'user:dana' })).rejects.toThrow(/脚本退出码 7：relay offline/)
    expect(svc.history().actions[0]).toMatchObject({ kind: 'reset', ok: false })
  })

  it('leaves script slots alone when Home Assistant slots change', async () => {
    const bench = new Bench([])
    const svc = service(bench)
    scripts(svc).save('user:dana', { slot: 5, resetScript: 'echo x' })
    // The controller now reports slots 0 and 5; slot 1 keeps its board, slot 5 stays a script slot.
    bench.ha.discover = async () => ({ devices: [], unassigned: [], slots: [0, 5].map(slot => ({ slot, resetEntity: `switch.ctrl_002_board_${slot}_reset`, fastbootEntity: `button.ctrl_002_board_${slot}_fastboot_mode`, device: 'ctrl_002' })) })
    await ha(svc).sync()
    expect(slotsOf(svc).map(slot => [slot.slot, slot.kind, slot.resetEntity])).toEqual([
      [0, 'ha', 'switch.ctrl_002_board_0_reset'], [1, 'ha', 'switch.ctrl_001_board_1_reset'], [5, 'script', null],
    ])
    expect(() => scripts(svc).remove('user:dana', 0)).toThrow(/来自 Home Assistant/)
    scripts(svc).remove('user:dana', 5)
    expect(slotsOf(svc).map(slot => slot.slot)).toEqual([0, 1])
  })

  it('finds a reset-only slot\'s serial port by its boot log and registers the board under the name given', async () => {
    const bench = new Bench([{ slot: 5, serial: ['/dev/serial/by-id/plug-uart'], usb: [] }])
    const svc = service(bench)
    scripts(svc).save('user:dana', { slot: 5, label: '米家插座', resetScript: 'echo off-on' })
    const id = (await scanner(svc).start('user:dana', { slots: [5], confirmed: true })).id
    for (let i = 0; i < 200 && scanner(svc).get(id).status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10))
    const scan = scanner(svc).get(id)
    expect(scan.status).toBe('done')
    expect(scan.result).toEqual([{ slot: 5, board: null, flags: ['这个槽位只能复位，没有下载口，读不到型号'], chips: [{ die: 'die0', serialPath: '/dev/serial/by-id/plug-uart', downloadUsbPath: null, usbId: null, product: null, pending: true }] }])
    // Two reset rounds and no extra reset at the end: the board is already booting normally.
    expect(bench.scriptRuns.map(run => run.env.BOARDS_ACTION)).toEqual(['reset', 'reset'])
    expect(bench.calls).toEqual([])

    const [proposal] = svc.state('user:dana').proposals
    expect(proposal).toMatchObject({ kind: 'new-board', slot: 5, summary: '槽位 5 发现新板子（只能复位，读不到型号，填板名后应用）' })
    await expect(svc.proposals.resolve('user:dana', [proposal!.id], 'apply')).rejects.toThrow(/槽位 5 的新板子要先填板名/)
    await expect(svc.proposals.resolve('user:dana', [proposal!.id], 'apply', { [proposal!.id]: 'bad name' })).rejects.toThrow(/板名不合法/)
    await expect(svc.proposals.resolve('user:dana', [proposal!.id], 'apply', { [proposal!.id]: 'com260' })).rejects.toThrow(/已有板子 com260/)
    await svc.proposals.resolve('user:dana', [proposal!.id], 'apply', { [proposal!.id]: 'mijia-dev' })
    expect(svc.boards.get('mijia-dev')).toMatchObject({ slot: 5, product: null, source: 'scan' })
    expect(svc.boards.get('mijia-dev').chips[0]).toMatchObject({ serialPath: '/dev/serial/by-id/plug-uart', alias: 'mijia-dev' })
    expect(bench.names.get('/dev/serial/by-id/plug-uart')).toBe('mijia-dev')
  })

  async function scanSlot(svc: BoardLab, slot: number) {
    const id = (await scanner(svc).start('user:dana', { slots: [slot], confirmed: true })).id
    for (let i = 0; i < 200 && scanner(svc).get(id).status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10))
    return scanner(svc).get(id)
  }

  it('names each port after its die once a board gains a second chip, in the same batch as other changes', async () => {
    const bench = new Bench([{ slot: 4, serial: ['/dev/serial/by-path/a'], usb: [] }])
    const svc = service(bench)
    scripts(svc).save('user:dana', { slot: 4, label: '米家插座', resetScript: 'echo off-on' })
    await scanSlot(svc, 4)
    const [found] = svc.state('user:dana').proposals
    await svc.proposals.resolve('user:dana', [found!.id], 'apply', { [found!.id]: 'gemini' })
    expect(bench.names.get('/dev/serial/by-path/a')).toBe('gemini')

    // The second chip's port answers too now.
    bench.wiring[0]!.serial.push('/dev/serial/by-path/b')
    await scanSlot(svc, 4)
    const proposals = svc.state('user:dana').proposals
    expect(proposals.map(item => item.summary)).toEqual(['gemini 新增芯片 die1，串口 /dev/serial/by-path/b'])
    await svc.proposals.resolve('user:dana', proposals.map(item => item.id), 'apply')
    expect(svc.boards.get('gemini').chips.map(chip => [chip.die, chip.serialPath, chip.alias])).toEqual([
      ['die0', '/dev/serial/by-path/a', 'gemini-die0'], ['die1', '/dev/serial/by-path/b', 'gemini-die1'],
    ])
    expect(bench.names).toEqual(new Map([['/dev/serial/by-path/a', 'gemini-die0'], ['/dev/serial/by-path/b', 'gemini-die1']]))
  })

  it('keeps a reset-only board\'s dies when a scan hears only some of its ports', async () => {
    const bench = new Bench([{ slot: 4, serial: ['/dev/serial/by-path/b'], usb: [] }])
    const svc = service(bench)
    scripts(svc).save('user:dana', { slot: 4, resetScript: 'echo off-on' })
    svc.boards.add('user:dana', { name: 'gemini', slot: 4, chips: [{ die: 'die0', serialPath: '/dev/serial/by-path/a' }, { die: 'die1', serialPath: '/dev/serial/by-path/b' }] })
    const scan = await scanSlot(svc, 4)
    // Only die1's port printed this time: it keeps its die, and die0 is reported, not moved.
    expect(scan.result[0]!.chips.map(chip => [chip.die, chip.serialPath])).toEqual([['die1', '/dev/serial/by-path/b']])
    expect(scan.result[0]!.flags).toContain('gemini.die0 的串口这次没有响应，登记保持不变')
    expect(svc.state('user:dana').proposals).toEqual([])
  })

  it('separates ports that ended up sharing one name when consoles are restored', async () => {
    const bench = new Bench([{ slot: 4, serial: ['/dev/serial/by-path/a', '/dev/serial/by-path/b'], usb: [] }])
    const svc = service(bench)
    scripts(svc).save('user:dana', { slot: 4, resetScript: 'echo off-on' })
    svc.boards.add('user:dana', { name: 'gemini', slot: 4, chips: [{ die: 'die0', serialPath: '/dev/serial/by-path/a', alias: 'gemini' }, { die: 'die1', serialPath: '/dev/serial/by-path/b', alias: 'gemini' }] })
    await scanner(svc).restoreConsoles()
    expect(svc.boards.get('gemini').chips.map(chip => chip.alias)).toEqual(['gemini-die0', 'gemini-die1'])
    expect(bench.names.get('/dev/serial/by-path/a')).toBe('gemini-die0')
    expect(bench.names.get('/dev/serial/by-path/b')).toBe('gemini-die1')
    expect([...bench.names.values()]).not.toContain('gemini')
  })

  it('runs scripts with bash or their own interpreter, with the slot in the environment, and stops hung ones', async () => {
    expect(await scriptRunner.run('echo "slot $BOARDS_SLOT $BOARDS_ACTION"; echo oops >&2; exit 3', { BOARDS_SLOT: '5', BOARDS_ACTION: 'reset' }, 5000))
      .toEqual({ code: 3, output: 'slot 5 reset\noops', timedOut: false })
    expect(await scriptRunner.run('#!/bin/sh\necho "from sh"', {}, 5000)).toEqual({ code: 0, output: 'from sh', timedOut: false })
    const hung = await scriptRunner.run('echo started; sleep 30', {}, 300)
    expect(hung).toMatchObject({ timedOut: true, output: 'started' })
  })
})
