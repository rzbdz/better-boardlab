/**
 * A hub boardd over host boardds (the `boardlab` module): each host boardd runs on fake hardware and is served over
 * HTTP as on a board host; the hub lists its boards and forwards to it. The host stays the authority: a lock taken
 * through the hub is the host's lock for the same person, one taken on the host shows on the hub as held, and a host
 * that goes away is reported, never answered from a copy.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { openDatabase } from 'boardlab-core/core/db.ts'
import { BoardLab } from 'boardlab-core/core/lab.ts'
import type { Backend, LabDevice } from 'boardlab-core/core/backend.ts'
import type { ConsoleSession } from 'boardlab-core/core/console.ts'
import { serve } from 'boardlab-core/server/http.ts'
import { boardlabHosts } from '../src/modules/boardlab/index.ts'
import { dir, useTempDir } from './fakes.ts'

useTempDir()

/** A board host's own hardware, faked: two boards in slots, one of them waiting for a person to press RESET. */
class Bench implements Backend {
  kind = '假主机'
  fields = { url: { label: '地址', placeholder: '', required: true } }
  calls: string[] = []
  consoles = new Map<string, Set<(data: Buffer) => void>>()
  listed: LabDevice[] = [
    { name: 'k3-a', slot: 'lab-1/s1', host: 'lab-1', model: 'k3_deb1', soc: 'k3', online: true, serialPort: 'lab-1:s1', serialConnected: true, downloadUsbPath: '1-1', ip: null },
    { name: 'k1-b', slot: 'lab-1/s2', host: 'lab-1', model: 'k1-x_deb1', soc: 'k1', online: true, serialPort: 'lab-1:s2', serialConnected: true, downloadUsbPath: '1-2', ip: null, attention: '按一下 k1-b 的 RESET 键' },
  ]
  inventory: NonNullable<Backend['inventory']> = { verify: async () => '2 块板子', devices: async () => this.listed }
  relay: Backend['relay'] = {
    reset: async (_config, target) => { this.calls.push(`reset ${target.device}`) },
    enterDownload: async (_config, target) => { this.calls.push(`fastboot ${target.device}`) },
    confirm: async (_config, target, note) => { this.calls.push(`confirm ${target.device}`); this.listed[1] = { ...this.listed[1]!, attention: null }; return `已确认 ${note || ''}`.trim() },
  }
  serial: Backend['serial'] = {
    // One serial port per board: every session on it sees what it prints.
    open: async (_config, target): Promise<ConsoleSession> => {
      const listeners = this.consoles.get(target.device) ?? new Set<(data: Buffer) => void>()
      this.consoles.set(target.device, listeners)
      return {
        hello: { alias: target.device, device: null, baud: 115200, transport: 'fake' }, history: [`${target.device} login:`],
        send: data => { this.calls.push(`type ${target.device} ${String(data)}`); for (const fn of listeners) fn(Buffer.from(`echo ${String(data)}`)) },
        onOutput: fn => { listeners.add(fn); return () => { listeners.delete(fn) } }, onClose: () => {}, close: () => {},
      }
    },
  }
  download: Backend['download'] = { stage: async () => 'staged', present: async () => true }
}

async function host(port: number) {
  const bench = new Bench()
  const lab = new BoardLab({ db: openDatabase(join(dir, `host-${port}.sqlite`)), modules: [{ id: 'bench', title: '假主机', setup: lab => lab.backends.register('bsp', bench) }] })
  await lab.backends.configure('user:root', 'bsp', { enabled: true, url: 'http://bench', username: '', password: '', devices: '' })
  await lab.backends.sync('bsp')
  const running = await serve(lab, { port, socketPath: join(dir, `host-${port}.sock`), uiDir: null })
  return { lab, bench, running }
}

async function hub(ports: Record<string, number>) {
  const lab = new BoardLab({ db: openDatabase(join(dir, 'hub.sqlite')), modules: [boardlabHosts({ instances: Object.keys(ports) })] })
  for (const [id, port] of Object.entries(ports)) {
    await lab.backends.configure('user:root', id, { enabled: true, url: `http://127.0.0.1:${port}`, username: '', password: '', devices: '' })
    await lab.backends.sync(id)
  }
  return lab
}

const port = () => 41000 + Math.floor(Math.random() * 4000)
/** The port a served boardd listens on. */
const portOf = (running: { http: import('node:http').Server[] }) => (running.http[0]!.address() as import('node:net').AddressInfo).port

describe('a hub over host boardds', () => {
  it('lists every host\'s boards, and a lock through the hub is the host\'s lock for the same person', async () => {
    const one = await host(port()), two = await host(port())
    try {
      const central = await hub({ lab1: portOf(one.running), lab2: portOf(two.running) })
      const names = central.boards.list().map(board => board.name).sort()
      expect(names).toEqual(['lab1-bsp-k1-b', 'lab1-bsp-k3-a', 'lab2-bsp-k1-b', 'lab2-bsp-k3-a'])

      const { token } = await central.locks.lock('lab1-bsp-k3-a', 'codex:uboot-net-fix', 'boot test')
      expect(one.lab.locks.held('bsp-k3-a')).toMatchObject({ holder: 'codex:uboot-net-fix', purpose: 'boot test' })
      expect(two.lab.locks.held('bsp-k3-a')).toBeNull()                       // the other host is untouched

      // Working the board goes to its host, under the hub's lock.
      await central.relay.reset('lab1-bsp-k3-a', { holder: 'codex:uboot-net-fix', token })
      expect(one.bench.calls).toContain('reset k3-a')

      // Released through the hub: released on the host.
      await central.locks.unlock('lab1-bsp-k3-a', { holder: 'codex:uboot-net-fix', token })
      await central.backends.sync('lab1')
      expect(one.lab.locks.held('bsp-k3-a')).toBeNull()
    } finally { await one.running.close(); await two.running.close() }
  })

  it('shows a board held on the host itself as held, and a board waiting for a person with what to do', async () => {
    const one = await host(port())
    try {
      const central = await hub({ lab1: portOf(one.running) })
      await one.lab.locks.lock('bsp-k3-a', 'user:bob', '在主机页面上调试')
      await central.backends.sync('lab1')
      expect(central.boards.get('lab1-bsp-k3-a').lab).toMatchObject({ heldBy: 'user:bob' })
      await expect(central.locks.lock('lab1-bsp-k3-a', 'user:alice', '我也要')).rejects.toThrow(/user:bob/)

      expect(central.boards.get('lab1-bsp-k1-b').lab).toMatchObject({ attention: '按一下 k1-b 的 RESET 键' })
      await central.relay.confirm('lab1-bsp-k1-b', 'user:alice', '按好了')
      expect(one.bench.calls).toContain('confirm k1-b')
      await one.lab.backends.sync('bsp')                                         // the host hears from its hardware
      await central.backends.sync('lab1')
      expect(central.boards.get('lab1-bsp-k1-b').lab).toMatchObject({ attention: null })
    } finally { await one.running.close() }
  })

  it('opens the host\'s console from the hub and types into it under the hub\'s lock', async () => {
    const one = await host(port())
    try {
      const central = await hub({ lab1: portOf(one.running) })
      await central.locks.lock('lab1-bsp-k3-a', 'user:alice', '看串口')
      const session = await central.consoles.open('lab1-bsp-k3-a')
      expect(session.history.join('\n')).toContain('k3-a login:')
      const seen: string[] = []
      session.onOutput(data => seen.push(data.toString()))
      await central.consoles.input('lab1-bsp-k3-a', { holder: 'user:alice' }, { data: 'root\r' })
      for (let i = 0; i < 50 && !seen.join('').includes('echo root'); i++) await new Promise(resolve => setTimeout(resolve, 20))
      expect(one.bench.calls).toContain('type k3-a root\r')
      expect(seen.join('')).toContain('echo root')
      session.close()
    } finally { await one.running.close() }
  })

  it('gives the board to the hub\'s waiter once the host\'s holder releases it, and takes it on the host for them', async () => {
    const one = await host(port())
    try {
      const central = await hub({ lab1: portOf(one.running) })
      await one.lab.locks.lock('bsp-k3-a', 'user:bob', '在主机页面上调试')
      await central.backends.sync('lab1')
      const queued = await central.locks.lock('lab1-bsp-k3-a', 'claude:kernel-bisect', '等它空出来', { queue: 'join' })
      expect(queued.queued).toEqual({ position: 1 })
      await one.lab.locks.unlock('bsp-k3-a', { holder: 'user:bob' })
      await central.backends.sync('lab1')
      for (let i = 0; i < 50 && !one.lab.locks.held('bsp-k3-a'); i++) await new Promise(resolve => setTimeout(resolve, 20))
      expect(central.locks.held('lab1-bsp-k3-a')).toMatchObject({ holder: 'claude:kernel-bisect' })
      expect(one.lab.locks.held('bsp-k3-a')).toMatchObject({ holder: 'claude:kernel-bisect', purpose: '等它空出来' })
    } finally { await one.running.close() }
  })

  it('reports a host that went away instead of answering from a copy', async () => {
    const one = await host(port())
    const central = await hub({ lab1: portOf(one.running) })
    await one.running.close()
    await expect(central.backends.sync('lab1')).rejects.toThrow()
    expect(central.backends.labSettings()[0]).toMatchObject({ syncOk: false })
  })
})
