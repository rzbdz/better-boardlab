/** `boardlab update`: this boardlab's version, whether a newer one is out, and installing it. */
import type { Command, CommandGroup } from 'boardlab-core/cli/command.ts'

interface Version { version: string, revision: string, source: string | null, latest: { version: string, revision: string } | null, checkedAt: string | null, error: string | null, newer: boolean }

interface Source { source: string | null, token: string | null }

const update: Command[] = [{
  name: 'update', noBoard: true, usage: [
    'update [--check] [--force]\t看有没有新版（--check 只看），有就升级：新版本接手新连接，旧版本把手上的串口、任务跑完（不停机；实在接不了才重启）',
    'update --show-source\t新版从哪里来（令牌只显示末尾几位）',
    'update --set-source <source> [--token T]\t换发布源（https 目录、git@host:组/仓库.git#分支、https://host/api/v4/projects/<id>#分支）；先看那里有 release.json 才保存；--token "" 删掉令牌',
    'update --from <source> [--token T] [--force]\t换发布源并升级到那里的版本',
  ],
  async run({ client, flags, flag, json, out }) {
    if (flags.has('show-source')) {
      const now = await client.call<Source>('GET', '/api/system/source')
      return out(now, () => console.log(now.source ? `发布源：${now.source}${now.token ? `（令牌 ${now.token}）` : ''}` : '不是用 install.sh 装的，没有发布源'))
    }
    const to = flag('set-source') ?? flag('from')
    if (flags.has('set-source') || flags.has('from')) {
      if (!to) throw new Error('要给发布源：boardlab update --set-source <source>')
      if (flags.get('token') === true) throw new Error('--token 后面要给令牌（"" 删掉已保存的）')
      const token = flag('token')
      const set = await client.call<{ message: string }>('POST', '/api/system/source', { source: to, ...(token !== undefined ? { token } : {}) })
      if (flags.has('set-source')) return out(set, () => console.log(set.message))
      if (!json) console.log(set.message)
    }
    const now = await client.call<Version>('GET', '/api/system/version?check=1')
    const line = `boardlab ${now.version}（${now.revision}）${now.latest ? `，最新 ${now.latest.version}（${now.latest.revision}）` : ''}${now.error ? `；查新版失败：${now.error}` : ''}${now.source ? '' : '（不是用 install.sh 装的，没有新版可查）'}`
    if (flags.has('check') || !now.newer) return out(now, () => console.log(now.newer ? `${line}：有新版，boardlab update 升级` : `${line}：已经是最新`))
    const result = await client.call<{ message: string }>('POST', '/api/system/update', { force: flags.has('force') })
    out(result, () => console.log(`${line}\n${result.message}`))
  },
}]

export const commands: CommandGroup = { id: 'system', summary: '检查和安装新版', title: '系统', commands: update }
