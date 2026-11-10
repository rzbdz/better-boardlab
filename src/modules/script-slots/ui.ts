/**
 * The script-slots module's part of the page, as views any frontend renders: on settings, the slots driven by scripts
 * people paste here, and the form to add or change one.
 */
import { call } from '../../ui/api.ts'
import { action, open, text, type Element, type ModuleUi, type View } from '../../ui/contract.ts'
import type { Slot } from 'boardlab-core/shared/types.ts'

const slotApi = {
  save: (input: { slot: number, label: string, resetScript: string, fastbootScript: string }) => call<Slot>('POST', 'api/slots/script', input),
  remove: (slot: number) => call('POST', 'api/slots/script/remove', { slot }),
}

const RESET_EXAMPLE = '#!/bin/bash\n# 断电 3 秒再上电\nmiiocli plug --ip 192.168.1.50 --token "$TOKEN" off\nsleep 3\nmiiocli plug --ip 192.168.1.50 --token "$TOKEN" on'

/** The form for one slot: a new one, or `slot` to change. */
function slotForm(slot: Slot | null, taken: Set<number>): Element {
  return {
    kind: 'form',
    fields: [
      { kind: 'number', id: 'slot', label: '槽位号', initial: slot?.slot, min: 0, max: 9999, required: true, disabled: !!slot },
      { kind: 'text', id: 'label', label: '名称', initial: slot?.label ?? '', placeholder: '米家插座 · 工位 3' },
      { kind: 'code', id: 'resetScript', label: '复位脚本', initial: slot?.resetScript ?? '', placeholder: RESET_EXAMPLE, required: true, rows: 6 },
      { kind: 'code', id: 'fastbootScript', label: 'fastboot 脚本', initial: slot?.fastbootScript ?? '', placeholder: '留空表示这个槽位只能复位', rows: 3 },
    ],
    submitLabel: slot ? `保存槽位 ${slot.slot}` : '添加槽位',
    submit: action('save', slot ? '保存' : '添加槽位', async input => {
      const number = slot?.slot ?? Number(input.slot)
      if (!slot && taken.has(number)) throw new Error(`槽位 ${number} 已存在`)
      await slotApi.save({ slot: number, label: String(input.label ?? ''), resetScript: String(input.resetScript ?? ''), fastbootScript: String(input.fastbootScript ?? '') })
      return slot ? '已保存' : `已添加槽位 ${number}`
    }, { intent: 'primary' }),
  }
}

export const ui: ModuleUi = {
  module: 'script-slots',
  views(state): View[] {
    const scripted = state.slots.filter(slot => slot.kind === 'script')
    const boardIn = (slot: number) => state.boards.find(board => board.slot === slot)
    const taken = new Set(state.slots.map(slot => slot.slot))
    return [{
      id: 'script-slots', slot: 'settings', title: '自定义槽位',
      body: [
        text(['控制器以外的板子用脚本复位，例如让米家插座断电再上电。脚本在 boardd 所在机器上以它的用户身份运行：首行有 ', { code: '#!' },
          ' 就用指定的解释器，否则用 bash；超过 2 分钟会被终止，退出码不是 0 算失败。脚本能读到 ', { code: 'BOARDS_SLOT' }, '、', { code: 'BOARDS_ACTION' },
          '（reset 或 fastboot）和 ', { code: 'BOARDS_BOARD' }, '。fastboot 脚本留空，这个槽位就只能复位。']),
        {
          kind: 'list', empty: '还没有自定义槽位。',
          items: scripted.map(slot => ({
            key: String(slot.slot), tag: `槽位 ${slot.slot}`, title: slot.label ?? '自定义槽位',
            description: `${slot.canFastboot ? '复位 · fastboot' : '只能复位'}${boardIn(slot.slot) ? ` · ${boardIn(slot.slot)!.name}` : ''}`,
            actions: [
              open('edit', '编辑', `编辑槽位 ${slot.slot}`, () => [slotForm(slot, taken)]),
              action('remove', '删除', async () => { await slotApi.remove(slot.slot); return `已删除槽位 ${slot.slot}` }, {
                intent: 'danger', blocked: boardIn(slot.slot) ? '槽位上还有板子' : undefined,
                confirm: { title: `删除槽位 ${slot.slot}`, body: '脚本会一起删除。', action: '删除' },
              }),
            ],
          })),
        },
        { kind: 'group', title: '添加槽位', body: [slotForm(null, taken)] },
      ],
    }]
  },
}
