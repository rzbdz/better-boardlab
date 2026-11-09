/**
 * The `script-slots` module: control slots driven by shell scripts entered on the page, for anything else that can
 * power-cycle a board (a smart plug, a relay board). Without a fastboot script a slot can only reset its board.
 */
import type { Slot } from 'boardlab-core/shared/types.ts'
import { BoardError } from 'boardlab-core/core/errors.ts'
import type { Module } from 'boardlab-core/core/module.ts'
import type { ScriptRunner } from '../local/hardware.ts'
import { LOCAL, type LocalApi } from '../local/index.ts'
import { slotKey } from '../local/slots.ts'

/** Power-cycling through a smart plug can take a while; anything longer is treated as hung. */
const SCRIPT_TIMEOUT_MS = 120_000
const SCRIPT_LIMIT = 64 * 1024

export interface ScriptSlotsApi {
  save(actor: string, input: { slot: number, label?: string | null, resetScript: string, fastbootScript?: string | null }): Slot
  remove(actor: string, slot: number): void
}

export function scriptSlots(options: { runner: ScriptRunner, timeoutMs?: number }): Module<ScriptSlotsApi> {
  const timeoutMs = options.timeoutMs ?? SCRIPT_TIMEOUT_MS
  return {
    id: 'script-slots',
    title: '脚本槽位',
    requires: [LOCAL],
    setup(lab) {
      const { kernel } = lab
      const local = lab.module<LocalApi>(LOCAL)
      local.slots.addDriver({
        kind: 'script',
        title: '脚本槽位',
        enabled: () => true,
        disabled: slot => `槽位 ${slot} 的脚本没有开启`,
        can: (slot, action) => !!(action === 'reset' ? slot.resetScript : slot.fastbootScript),
        cannot: (slot, action) => action === 'reset' ? `槽位 ${slot.slot} 没有复位脚本` : `槽位 ${slot.slot} 只能复位`,
        describe: (slot, action) => `槽位 ${slot.slot} 的${action === 'reset' ? '复位' : ' fastboot '}脚本`,
        /** A non-zero exit or a timeout fails with the end of its output. */
        async press(slot, action, board) {
          const script = (action === 'reset' ? slot.resetScript : slot.fastbootScript)!
          const result = await options.runner.run(script, { BOARDS_SLOT: String(slot.slot), BOARDS_ACTION: action, BOARDS_BOARD: board ?? '' }, timeoutMs)
          const tail = result.output.split('\n').slice(-5).join('\n').slice(-500)
          if (result.timedOut) throw new BoardError('hardware', `脚本超过 ${timeoutMs / 1000} 秒没有结束，已终止${tail ? `：${tail}` : ''}`)
          if (result.code !== 0) throw new BoardError('hardware', `脚本退出码 ${result.code ?? '未知'}${tail ? `：${tail}` : ''}`)
          return tail || null
        },
      })
      const owner = (slot: number) => {
        const kind = local.slots.kindOf(slot)
        return kind === null ? null : local.slots.driver(kind)?.title ?? kind
      }
      const api: ScriptSlotsApi = {
        /** Create or change a script slot. The reset script is required; numbers other kinds of slot use are not available. */
        save(actor, input) {
          const slot = input.slot
          if (!Number.isInteger(slot) || slot < 0 || slot > 9999) throw new BoardError('invalid', `槽位号不合法：${slot}`)
          const resetScript = input.resetScript.replace(/\r\n/g, '\n')
          const fastbootScript = (input.fastbootScript ?? '').replace(/\r\n/g, '\n')
          const label = input.label?.trim() || null
          if (!resetScript.trim()) throw new BoardError('invalid', '复位脚本不能为空')
          if (resetScript.length > SCRIPT_LIMIT || fastbootScript.length > SCRIPT_LIMIT) throw new BoardError('invalid', '脚本太长（最多 64 KB）')
          if (label && label.length > 60) throw new BoardError('invalid', '名称太长（最多 60 个字符）')
          const kind = local.slots.kindOf(slot)
          if (kind && kind !== 'script') throw new BoardError('conflict', `槽位 ${slot} 属于 ${owner(slot)}，换一个槽位号`)
          kernel.db.prepare(`INSERT INTO slots(slot, kind, label, reset_script, fastboot_script, confirmed_at) VALUES(?,'script',?,?,?,?)
            ON CONFLICT(slot) DO UPDATE SET label=excluded.label, reset_script=excluded.reset_script, fastboot_script=excluded.fastboot_script, confirmed_at=excluded.confirmed_at`)
            .run(slot, label, resetScript, fastbootScript.trim() ? fastbootScript : null, kernel.iso())
          kernel.record(actor, null, 'slot-save', `槽位 ${slot}${label ? `（${label}）` : ''}${fastbootScript.trim() ? '' : '，只能复位'}`, true)
          kernel.changed(null)
          return local.slots.list().find(item => item.slot === slot)!
        },
        remove(actor, slot) {
          const kind = local.slots.kindOf(slot)
          if (!kind) throw new BoardError('not-found', `没有槽位 ${slot}`)
          if (kind !== 'script') throw new BoardError('invalid', `槽位 ${slot} 来自 ${owner(slot)}，不能在这里删除`)
          const board = kernel.db.prepare('SELECT name FROM boards WHERE slot=?').get(slot)
          if (board) throw new BoardError('conflict', `槽位 ${slot} 上还有板子 ${String(board.name)}，先移除板子`)
          if (lab.locks.held(slotKey(slot))) throw new BoardError('locked', `槽位 ${slot} 正被使用`)
          kernel.db.prepare('DELETE FROM slots WHERE slot=?').run(slot)
          kernel.record(actor, null, 'slot-remove', `槽位 ${slot}`, true)
          kernel.changed(null)
        },
      }
      lab.api.add('script-slots', [
        { method: 'POST', path: '/api/slots/script', about: '添加或修改脚本槽位', handle: ({ body, caller }) => api.save(caller.holder, { slot: Number(body.slot), label: typeof body.label === 'string' ? body.label : null, resetScript: String(body.resetScript ?? ''), fastbootScript: typeof body.fastbootScript === 'string' ? body.fastbootScript : null }) },
        { method: 'POST', path: '/api/slots/script/remove', about: '删除脚本槽位', handle: ({ body, caller }) => { api.remove(caller.holder, Number(body.slot)) } },
      ])
      return api
    },
  }
}
