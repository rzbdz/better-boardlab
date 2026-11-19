/**
 * Cancelling a bsp board's flash after its lock ended: the board's backend lease stays while the flash runs, so the
 * host takes the cancel (a board host cancels a board's job only under that board's lease), and a cancel the host
 * refuses is reported as refused, never as accepted.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { openDatabase } from 'boardlab-core/core/db.ts'
import { BoardLab } from 'boardlab-core/core/lab.ts'
import { CancelledError } from 'boardlab-core/core/errors.ts'
import { bsp } from '../src/modules/bsp/index.ts'
import { bspLab, type BspRunner } from '../src/modules/bsp/driver.ts'
import { dir, useTempDir } from './fakes.ts'

useTempDir()

const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' })
const refuse = (message: string) => ({ code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'forbidden', message } }), stderr: '' })
const until = async (test: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 10))) if (test()) return true
  return test()
}

/** One board host with one board, `k3-a`: it keeps its lease and refuses what changes the board without it. */
function fakeHost() {
  const host = {
    lease: null as { token: string, holder: string } | null,
    job: null as { id: string, end: (how: 'cancelled' | 'done') => void } | null,
    /** Why the host will not stop its job (a cancel refused for a reason of its own); null: it stops it. */
    refuseCancel: null as string | null,
    cancels: [] as string[][], leases: 0,
  }
  const check = (args: string[]) => {
    const given = args.includes('--lease') ? args[args.indexOf('--lease') + 1] : null
    if (!host.lease) return 'DUT k3-a is not leased; mutating operations need a lease'
    if (given !== host.lease.token) return `DUT k3-a is leased by ${host.lease.holder}; wrong or missing lease token`
    return null
  }
  const run: BspRunner = async (args, { onStderr, signal }) => {
    let rest = args.slice(args.indexOf('--stateless') + 1)
    if (rest[0] === '-r') rest = rest.slice(2)
    const [group, verb] = rest
    if (group === 'hosts') return ok([{ host: 'h1', duts: ['k3-a'] }])
    if (group === 'slot') return ok([])
    if (group === 'dut' && verb === 'list') return ok([{ id: 'k3-a', host: 'h1', usb: 'usb:2-1.2', console: 'k3-a', lease: host.lease ? { holder: host.lease.holder } : null }])
    if (group === 'dut' && verb === 'acquire') {
      const holder = rest[rest.indexOf('--holder') + 1]!
      if (host.lease && check(rest)) return refuse(check(rest)!)
      host.lease = { token: host.lease?.token ?? `T${++host.leases}`, holder }
      return ok({ token: host.lease.token })
    }
    if (group === 'dut' && verb === 'release') {
      const why = check(rest)
      if (why) return refuse(why)
      host.lease = null
      return ok({ released: true })
    }
    if ((group === 'dut' && verb === 'cancel') || (group === 'job' && verb === 'cancel')) {
      host.cancels.push(rest)
      const why = check(rest) ?? host.refuseCancel
      if (why) return refuse(why)
      host.job?.end('cancelled')
      return ok({ cancelled: host.job ? [host.job.id] : [] })
    }
    if (group === 'dut' && verb === 'flash') {
      const why = check(rest)
      if (why) return refuse(why)
      onStderr?.('k3-a @ h1: flash pkg.zip with tool-b, job flash-1794977803-12')
      return new Promise(resolve => {
        host.job = { id: 'flash-1794977803-12', end: how => { host.job = null; resolve(how === 'cancelled' ? { code: 4, stdout: JSON.stringify({ ok: false, error: { code: 'cancelled', message: 'job flash-1794977803-12 cancelled' } }), stderr: '' } : ok({ lines: ['flashed'] })) } }
        // Killing the CLI does not stop the host's job; it only stops boardd following it.
        signal?.addEventListener('abort', () => resolve({ code: null, stdout: '', stderr: 'killed' }), { once: true })
      })
    }
    return ok({})
  }
  return { host, run }
}

async function setup() {
  const { host, run } = fakeHost()
  const lab = new BoardLab({ db: openDatabase(join(dir, 'b.sqlite')), modules: [bsp({ sdk: { run: async () => 0 } as never, instances: [] })] })
  lab.backends.register('live', bspLab({ run, cancelGraceMs: 50 }))
  await lab.backends.configure('user:alice', 'live', { enabled: true, url: 'http://registry.test:8765', username: '', password: 'tok', devices: '' })
  const call = (path: string, holder: string, body: Record<string, unknown>) =>
    Promise.resolve().then(() => lab.api.match('POST', path)!.endpoint.handle({ body, query: new URLSearchParams(), params: {}, caller: { holder, local: true }, signal: new AbortController().signal, upload: null } as never))
  return { lab, host, call }
}

describe('cancelling a bsp flash whose lock ended', () => {
  it('keeps the backend lease while the flash runs, so the cancel reaches the host under it', async () => {
    const { lab, host, call } = await setup()
    const board = 'live-k3-a'
    const { token } = await lab.locks.lock(board, 'claude:s1', '刷机')
    expect(host.lease).toMatchObject({ token: 'T1' })
    const flashing = call('/api/flash/package', 'claude:s1', { board, token, url: 'https://images.test/pkg.zip' }).then(() => 'done', error => error)
    await until(() => !!host.job)
    // The holder lets go while the flash runs: the board stays busy, and the host's lease stays with the flash.
    lab.locks.unlock(board, { holder: 'claude:s1', token })
    await lab.locks.settle(board)
    expect(lab.boards.get(board).busy).toMatchObject({ kind: 'boot', cancellable: true })
    expect(host.lease).toMatchObject({ token: 'T1' })
    // Anyone may stop what runs on a free board; the host takes it, under the lease.
    expect(await call('/api/cancel', 'user:bob', { target: board })).toMatchObject({ cancelled: true })
    expect(host.cancels.length).toBeGreaterThan(0)
    expect(host.cancels.every(args => args.includes('T1'))).toBe(true)
    const error = await flashing
    expect(error).toBeInstanceOf(CancelledError)
    expect(lab.boards.get(board).busy).toBeNull()
    // The run is over: the lease the lock no longer needs goes back to the host.
    expect(await until(() => host.lease === null)).toBe(true)
  })

  it('reports a cancel the host refused as refused, and the flash goes on to its end', async () => {
    const { lab, host, call } = await setup()
    const board = 'live-k3-a'
    const { token } = await lab.locks.lock(board, 'claude:s1', '刷机')
    const flashing = call('/api/flash/package', 'claude:s1', { board, token, url: 'https://images.test/pkg.zip' }).then(out => out, error => error)
    await until(() => !!host.job)
    host.refuseCancel = 'job flash-1794977803-12 is writing the boot partition and cannot stop now'
    await expect(call('/api/cancel', 'claude:s1', { target: board, token })).rejects.toMatchObject({ code: 'hardware', message: expect.stringContaining('cannot stop now') })
    expect(lab.boards.detail(board).actions.find(action => action.kind === 'cancel')).toMatchObject({ ok: false })
    // Past the grace of an accepted cancel, boardd still follows the job: it ends as the host ends it.
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(lab.boards.get(board).busy).toMatchObject({ kind: 'boot' })
    host.job!.end('done')
    expect(await flashing).toMatchObject({ output: 'flashed' })
    expect(lab.boards.get(board).busy).toBeNull()
  })
})

describe('removing a bsp lab', () => {
  it('is refused while the lab is being installed, and the uninstall that removes it is not refused by its own run', async () => {
    const lab = new BoardLab({ db: openDatabase(join(dir, 'u.sqlite')), modules: [bsp({ stateDir: join(dir, 'state'), sdk: { run: async () => 0 } as never, instances: [] })] })
    lab.backends.add('user:alice', 'host1', 'bsp')
    const call = (path: string, body: Record<string, unknown>) =>
      Promise.resolve().then(() => lab.api.match('POST', path)!.endpoint.handle({ body, query: new URLSearchParams(), params: {}, caller: { holder: 'user:alice', local: true }, signal: new AbortController().signal, upload: null } as never))
    let installed!: () => void
    const installing = lab.kernel.doing(['lab:host1'], 'install', '安装中', 'user:bob', () => new Promise<void>(resolve => { installed = resolve }))
    await expect(call('/api/labs/remove', { id: 'host1' })).rejects.toThrow(/正在安装/)
    installed(); await installing
    // Not installed over ssh: uninstalling only forgets the lab, as its own run on the lab.
    expect(await call('/api/bsp/uninstall', { id: 'host1' })).toEqual({ ok: true })
    expect(lab.backends.labSettings().map(item => item.id)).not.toContain('host1')
  })
})
