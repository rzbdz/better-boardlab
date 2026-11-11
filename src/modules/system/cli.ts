/** `boardlab update`: this boardlab's version, whether a newer one is out, and installing it. */
import type { Command, CommandGroup } from 'boardlab-core/cli/command.ts'

interface Version { version: string, revision: string, source: string | null, latest: { version: string, revision: string } | null, checkedAt: string | null, error: string | null, newer: boolean }

const update: Command[] = [{
  name: 'update', noBoard: true, usage: ['update [--check] [--force]\t看有没有新版（--check 只看），有就升级：boardd 等没人拿锁时换上新版并重启（--force 不等）'],
  async run({ client, flags, out }) {
    const now = await client.call<Version>('GET', '/api/system/version?check=1')
    const line = `boardlab ${now.version}（${now.revision}）${now.latest ? `，最新 ${now.latest.version}（${now.latest.revision}）` : ''}${now.error ? `；查新版失败：${now.error}` : ''}${now.source ? '' : '（不是用 install.sh 装的，没有新版可查）'}`
    if (flags.has('check') || !now.newer) return out(now, () => console.log(now.newer ? `${line}：有新版，boardlab update 升级` : `${line}：已经是最新`))
    const result = await client.call<{ message: string }>('POST', '/api/system/update', { force: flags.has('force') })
    out(result, () => console.log(`${line}\n${result.message}`))
  },
}]

export const commands: CommandGroup = { title: '系统', commands: update }
