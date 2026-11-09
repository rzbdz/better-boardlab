/** The home-assistant module's commands: its access, and switching it on or off. */
import { readFileSync } from 'node:fs'
import type { Command, CommandGroup } from 'boardlab-core/cli/command.ts'

const ha: Command = {
  name: 'ha', usage: ['ha set <url> [--token-stdin] | ha test | ha on | ha off\t验证通过后自动从 HA 同步槽位；off 不再用 HA 控制器、隐藏它的槽位'],
  async run({ client, args, flags, out }) {
    const sub = args[0]
    if (sub === 'set') {
      if (!args[1]) throw new Error('缺少 Home Assistant 地址')
      const secret = flags.has('token-stdin') ? readFileSync(0, 'utf8').trim() : undefined
      const result = await client.configureHa(args[1], secret)
      return out(result, () => console.log(result.verifyOk ? `已连接：${result.verifyMessage}` : `保存了，但验证失败：${result.verifyMessage}`))
    }
    if (sub === 'on' || sub === 'off') { const result = await client.setHaEnabled(sub === 'on'); return out(result, () => console.log(`Home Assistant 已${result.enabled ? '开启' : '关闭'}`)) }
    if (sub === 'test') { const result = await client.testHa(); return out(result, () => console.log(result.verifyOk ? `正常：${result.verifyMessage}` : `失败：${result.verifyMessage}`)) }
    throw new Error('ha 子命令：set、test、on、off')
  },
}

export const commands: CommandGroup = { title: 'Home Assistant', commands: [ha] }
