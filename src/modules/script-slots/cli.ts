/** The script-slots module's commands: slots driven by scripts. */
import { readFileSync } from 'node:fs'
import type { Command, CommandGroup } from 'boardlab-core/cli/command.ts'

const slot: Command = {
  name: 'slot',
  usage: [
    'slot set <n> --reset-script <文件|-> [--fastboot-script <文件>] [--label <名称>]\t自定义槽位；没有 fastboot 脚本就只能复位',
    'slot remove <n>',
  ],
  async run({ client, args, flag, out }) {
    const sub = args[0]
    const number = Number(args[1])
    if ((sub !== 'set' && sub !== 'remove') || !Number.isInteger(number)) throw new Error('slot 子命令：set <n> --reset-script <文件>、remove <n>')
    if (sub === 'remove') { await client.removeScriptSlot(number); return out({ ok: true }, () => console.log(`已删除槽位 ${number}`)) }
    const script = (path: string | undefined) => path === undefined ? null : readFileSync(path === '-' ? 0 : path, 'utf8')
    const resetScript = script(flag('reset-script'))
    if (!resetScript) throw new Error('请用 --reset-script 给出复位脚本（- 表示从标准输入读）')
    const saved = await client.saveScriptSlot({ slot: number, label: flag('label') ?? null, resetScript, fastbootScript: script(flag('fastboot-script')) })
    out(saved, () => console.log(`已保存槽位 ${number}${saved.canFastboot ? '' : '（只能复位）'}`))
  },
}

export const commands: CommandGroup = { title: '脚本槽位', commands: [slot] }
