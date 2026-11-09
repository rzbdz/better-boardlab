/** The script-slots module on the page: slots driven by scripts, on the settings tab. */
import { useState } from 'react'
import type { Slot } from 'boardlab-core/shared/types.ts'
import { call } from 'boardlab-core/ui/api.ts'
import type { ModuleUi, ViewProps } from 'boardlab-core/ui/extensions.ts'
import { Section } from 'boardlab-core/ui/kit.tsx'

const slotApi = {
  save: (input: { slot: number, label: string, resetScript: string, fastbootScript: string }) => call<Slot>('POST', 'api/slots/script', input),
  remove: (slot: number) => call('POST', 'api/slots/script/remove', { slot }),
}

const BLANK_SLOT = { slot: '', label: '', resetScript: '', fastbootScript: '' }

/** Slots outside the Home Assistant controller, driven by scripts people paste here. */
function ScriptSlots(props: ViewProps) {
  const { state } = props
  const [form, setForm] = useState(BLANK_SLOT)
  const [editing, setEditing] = useState<number | null>(null)
  const scripted = state.slots.filter(slot => slot.kind === 'script')
  const boardIn = (slot: number) => state.boards.find(board => board.slot === slot)
  const number = Number(form.slot)
  const clash = editing === null && form.slot !== '' && state.slots.find(slot => slot.slot === number)
  const edit = (slot: Slot) => {
    setEditing(slot.slot)
    setForm({ slot: String(slot.slot), label: slot.label ?? '', resetScript: slot.resetScript ?? '', fastbootScript: slot.fastbootScript ?? '' })
  }
  const reset = () => { setEditing(null); setForm(BLANK_SLOT) }
  return (
    <Section title="自定义槽位">
      <p className="muted">
        控制器以外的板子，用脚本复位，例如让米家插座断电再上电。脚本在 boardd 所在的机器上以它的用户身份运行：首行有 <code>#!</code> 就用指定的解释器，否则用 bash；
        超过 2 分钟会被终止，退出码不是 0 算失败。脚本能读到 <code>BOARDS_SLOT</code>、<code>BOARDS_ACTION</code>（reset 或 fastboot）和 <code>BOARDS_BOARD</code>。fastboot 脚本留空，这个槽位就只能复位。
      </p>
      {scripted.length > 0 && (
        <ul className="images script-slots">
          {scripted.map(slot => (
            <li key={slot.slot}>
              <span className="slot-tag">槽位 {slot.slot}</span>
              <div className="grow"><b>{slot.label ?? '自定义槽位'}</b><small>{slot.canFastboot ? '复位 · fastboot' : '只能复位'}{boardIn(slot.slot) ? ` · ${boardIn(slot.slot)!.name}` : ''}</small></div>
              <button onClick={() => edit(slot)}>编辑</button>
              <button disabled={!!boardIn(slot.slot)} title={boardIn(slot.slot) ? '槽位上还有板子' : undefined}
                onClick={() => props.onPrompt({ kind: 'confirm', title: `删除槽位 ${slot.slot}`, body: '脚本会一起删除。', action: '删除', danger: true, run: async () => { await slotApi.remove(slot.slot); if (editing === slot.slot) reset() } })}>删除</button>
            </li>
          ))}
        </ul>
      )}
      <form className="form-grid image-form" onSubmit={event => {
        event.preventDefault()
        void props.onRun(editing === null ? '已添加槽位' : '已保存', async () => { await slotApi.save({ slot: number, label: form.label, resetScript: form.resetScript, fastbootScript: form.fastbootScript }); reset() })
      }}>
        <label>槽位号<input type="number" min={0} max={9999} step={1} required value={form.slot} disabled={editing !== null} onChange={event => setForm({ ...form, slot: event.target.value })} /></label>
        <label>名称<input value={form.label} maxLength={60} placeholder="米家插座 · 工位 3" onChange={event => setForm({ ...form, label: event.target.value })} /></label>
        <label className="span">复位脚本
          <textarea required rows={6} spellCheck={false} value={form.resetScript} onChange={event => setForm({ ...form, resetScript: event.target.value })}
            placeholder={'#!/bin/bash\n# 断电 3 秒再上电\nmiiocli plug --ip 192.168.1.50 --token "$TOKEN" off\nsleep 3\nmiiocli plug --ip 192.168.1.50 --token "$TOKEN" on'} />
        </label>
        <label className="span">fastboot 脚本
          <textarea rows={3} spellCheck={false} value={form.fastbootScript} onChange={event => setForm({ ...form, fastbootScript: event.target.value })} placeholder="留空表示这个槽位只能复位" />
        </label>
        <div className="actions span">
          <button className="primary" disabled={!!clash}>{editing === null ? '添加槽位' : `保存槽位 ${editing}`}</button>
          {editing !== null && <button type="button" onClick={reset}>取消</button>}
          {clash && <span className="warn">槽位 {number} 已存在{clash.kind === 'ha' ? '（属于 Home Assistant 控制器）' : '，点它的「编辑」修改'}</span>}
        </div>
      </form>
    </Section>
  )
}

export const ui: ModuleUi = { module: 'script-slots', settings: ScriptSlots }
