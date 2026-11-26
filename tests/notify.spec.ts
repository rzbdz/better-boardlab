/** What the page tells a person about, from two successive states: the rules every frontend's notifications follow. */
import { describe, expect, it } from 'vitest'
import type { Board, Lease, Waiter } from 'boardlab-core/shared/types.ts'
import { changes, show, prefs } from '../src/ui/notify.ts'

const lease = (holder: string, purpose = '调试'): Lease => ({ id: holder, board: 'b', holder, purpose, startedAt: '2026-11-10T00:00:00Z', status: 'held', endedAt: null, endReason: null })
const waiter = (holder: string): Waiter => ({ id: holder, board: 'b', holder, purpose: '等', queuedAt: '2026-11-10T00:00:00Z' })
function board(name: string, change: Partial<Board> = {}): Board {
  return { name, slot: null, serial: null, product: null, baseMac: null, soc: null, notes: null, source: 'manual', mode: 'normal', chips: [], lease: null, waiters: [], lastSeenAt: null, backend: 'local', slotRef: null, lab: null, ...change } as Board
}
const lab = (attention: string | null) => ({ id: 'boardctrl', device: 'd', online: false, ip: null, heldBy: null, leaseError: null, attention, attentionRequest: null, canConfirm: true, empty: false, slotGone: false, canRefresh: false, mediaBoot: null, sdks: [], progress: null, packages: null, canFlashPackage: false })

describe('notifications', () => {
  const me = 'user:alice'

  it('tell a person whose turn came that the lock is theirs, and one whose lock was taken who took it', () => {
    const queued = board('k3', { lease: lease('user:bob'), waiters: [waiter(me)] })
    expect(changes([queued], [board('k3', { lease: lease(me, '修 U-Boot') })], me, [])).toEqual([
      { topic: 'granted', board: 'k3', title: '轮到你了：k3', body: '已拿到锁（修 U-Boot）' },
    ])
    expect(changes([board('k3', { lease: lease(me) })], [board('k3', { lease: lease('user:bob', '紧急') })], me, [])).toEqual([
      { topic: 'stolen', board: 'k3', title: 'k3 的锁被 bob 拿走', body: '紧急' },
    ])
    // Taking a free lock yourself is no news.
    expect(changes([board('k3')], [board('k3', { lease: lease(me) })], me, [])).toEqual([])
  })

  it('tell a person when a board they watch becomes free, unless someone is queued for it', () => {
    const before = [board('k3', { lease: lease('user:bob') })]
    expect(changes(before, [board('k3')], me, ['k3'])).toEqual([{ topic: 'free', board: 'k3', title: 'k3 空闲了', body: 'bob 已放锁，现在可以拿锁' }])
    expect(changes(before, [board('k3')], me, [])).toEqual([])                                // not watched
    expect(changes(before, [board('k3', { lease: lease('user:carol'), waiters: [] })], me, ['k3'])).toEqual([])  // handed on
  })

  it('tell everyone once when a board starts waiting for a person', () => {
    const waiting = board('k1', { lab: lab('按 RESET，然后点我已完成') as Board['lab'] })
    expect(changes([board('k1', { lab: lab(null) as Board['lab'] })], [waiting], me, [])).toEqual([
      { topic: 'attention', board: 'k1', title: 'k1：需要你操作', body: '按 RESET，然后点我已完成' },
    ])
    expect(changes([waiting], [waiting], me, [])).toEqual([])                                  // still the same request
  })

  it('two failures are two notes in the operating system, while a board asking again replaces its own', () => {
    const made: Array<{ title: string, options: { tag?: string } }> = []
    class FakeNotification { static permission = 'granted'; onclick: (() => void) | null = null; constructor(title: string, options: { tag?: string }) { made.push({ title, options }) } close() {} }
    const globals = globalThis as unknown as Record<string, unknown>
    const before = { Notification: globals.Notification, localStorage: globals.localStorage, window: globals.window, isSecureContext: Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext') }
    globals.window = { isSecureContext: true, focus: () => {}, Notification: FakeNotification }
    const saved = new Map<string, string>()
    globals.localStorage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value) }, removeItem: (key: string) => { saved.delete(key) } }
    globals.Notification = FakeNotification
    Object.defineProperty(globalThis, 'isSecureContext', { value: true, configurable: true })
    prefs.set({ ...prefs.get(), enabled: { ...prefs.get().enabled, failed: true, attention: true } })
    try {
      show({ topic: 'failed', board: 'page', title: '拿不到 k3 的锁', body: '正被 bob 使用' })
      show({ topic: 'failed', board: 'page', title: '复位失败', body: '串口没回应' })
      expect(made[0]!.options.tag).not.toBe(made[1]!.options.tag)
      // The same failure again wears the same tag: it replaces the earlier note rather than piling up.
      show({ topic: 'failed', board: 'page', title: '拿不到 k3 的锁', body: '正被 bob 使用' })
      expect(made[2]!.options.tag).toBe(made[0]!.options.tag)
      // One board asking twice is one note.
      show({ topic: 'attention', board: 'k3', title: 'k3：需要你操作', body: '按 RESET' })
      show({ topic: 'attention', board: 'k3', title: 'k3：需要你操作', body: '按 RESET 再按一次' })
      expect(made[4]!.options.tag).toBe(made[3]!.options.tag)
    } finally {
      globals.Notification = before.Notification
      globals.localStorage = before.localStorage
      globals.window = before.window
      if (before.isSecureContext) Object.defineProperty(globalThis, 'isSecureContext', before.isSecureContext)
      else delete (globalThis as { isSecureContext?: boolean }).isSecureContext
    }
  })
})
