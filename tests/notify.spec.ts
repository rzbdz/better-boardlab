/** What the page tells a person about, from two successive states: the rules every frontend's notifications follow. */
import { describe, expect, it } from 'vitest'
import type { Board, Lease, Waiter } from 'boardlab-core/shared/types.ts'
import { changes } from '../src/ui/notify.ts'

const lease = (holder: string, purpose = '调试'): Lease => ({ id: holder, board: 'b', holder, purpose, startedAt: '2026-11-10T00:00:00Z', status: 'held', endedAt: null, endReason: null })
const waiter = (holder: string): Waiter => ({ id: holder, board: 'b', holder, purpose: '等', queuedAt: '2026-11-10T00:00:00Z' })
function board(name: string, change: Partial<Board> = {}): Board {
  return { name, slot: null, serial: null, product: null, baseMac: null, soc: null, notes: null, source: 'manual', mode: 'normal', chips: [], lease: null, waiters: [], lastSeenAt: null, backend: 'local', slotRef: null, lab: null, ...change } as Board
}
const lab = (attention: string | null) => ({ id: 'bsp', device: 'd', online: false, ip: null, heldBy: null, leaseError: null, attention, canConfirm: true, empty: false, slotGone: false, canRefresh: false, mediaBoot: null, sdks: [], progress: null, canFlashPackage: false })

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
})
