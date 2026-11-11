/**
 * The system module's part of the page: in settings, this boardlab's version, whether a newer release is out (checked
 * every few hours by boardd, or now), and updating to it.
 */
import { call } from '../../ui/api.ts'
import { action, notice, text, type ModuleUi, type View } from '../../ui/contract.ts'

interface Version { version: string, revision: string, source: string | null, latest: { version: string, revision: string } | null, checkedAt: string | null, error: string | null, updating: boolean, newer: boolean }
let known: Version | null = null
const load = async (check = false) => { known = await call<Version>('GET', `api/system/version${check ? '?check=1' : ''}`); return known }
void load().catch(() => {})

export const ui: ModuleUi = {
  module: 'system',
  views(): View[] {
    const v = known
    return [{
      id: 'version', slot: 'settings', title: '版本',
      status: v?.newer ? { tone: 'warn', text: `有新版 ${v.latest?.version}` } : v ? { tone: 'ok', text: v.version } : undefined,
      body: [
        text(v ? `boardlab ${v.version}（${v.revision}）${v.latest ? ` · 最新 ${v.latest.version}（${v.latest.revision}）` : ''}${v.checkedAt ? ` · ${new Date(v.checkedAt).toLocaleString()} 查过` : ''}` : '读取中…'),
        ...(v?.error ? [notice(`查新版失败：${v.error}`)] : []),
        ...(v && !v.source ? [notice('这个 boardlab 不是用 install.sh 装的（比如从源码跑的），没有新版可查：在源码里 git pull 再 build。', 'neutral')] : []),
        {
          kind: 'actions', actions: [
            action('check', '检查更新', async () => { const now = await load(true); return now.newer ? `有新版：${now.latest?.version}（${now.latest?.revision}）` : `已经是最新：${now.version}` }, { blocked: v && !v.source ? '没有发布源' : undefined }),
            action('update', '升级', async () => (await call<{ message: string }>('POST', 'api/system/update', {})).message, {
              intent: 'primary', blocked: !v?.newer ? '已经是最新' : v.updating ? '正在升级' : undefined,
              confirm: { title: '升级 boardlab', body: '下载新版，等没人拿锁时换上并重启 boardd（锁、排队和设置都保留）。页面会自己刷新。', action: '升级' },
            }),
          ],
        },
      ],
    }]
  },
}
