/**
 * The system module's part of the page: in settings, this boardlab's version, whether a newer release is out (checked
 * every few hours by boardd, or now), updating to it, and where new releases come from.
 */
import { call } from '../../ui/api.ts'
import { action, notice, text, type ModuleUi, type View } from '../../ui/contract.ts'

interface Version { version: string, revision: string, source: string | null, latest: { version: string, revision: string } | null, checkedAt: string | null, error: string | null, updating: boolean, newer: boolean }
interface Source { source: string | null, token: string | null }
let known: Version | null = null, origin: Source | null = null
const load = async (check = false) => { known = await call<Version>('GET', `api/system/version${check ? '?check=1' : ''}`); return known }
const loadSource = async () => { origin = await call<Source>('GET', 'api/system/source'); return origin }
void load().catch(() => {})
void loadSource().catch(() => {})
// The source and token as typed: a token only when one was typed (or `clear` asked to drop it).
const sourceBody = (input: Record<string, unknown>) => ({ source: String(input.source ?? '').trim(), ...(input.token ? { token: String(input.token) } : input.clear ? { token: '' } : {}) })

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
        ...(v?.source ? [{
          kind: 'form' as const,
          fields: [
            { kind: 'text' as const, id: 'source', label: '发布源', initial: origin?.source ?? v.source, placeholder: 'https://…、git@host:组/仓库.git#release 或 https://host/api/v4/projects/<id>#release', wide: true },
            { kind: 'secret' as const, id: 'token', label: '令牌（私有项目）', stored: !!origin?.token, placeholder: origin?.token ? `已保存 ${origin.token}（留空则不修改）` : '公开的源不用填' },
            ...(origin?.token ? [{ kind: 'switch' as const, id: 'clear', label: '删掉已保存的令牌', initial: false }] : []),
          ],
          submitLabel: '保存',
          submit: action('source', '保存', async input => {
            const result = await call<{ message: string }>('POST', 'api/system/source', sourceBody(input))
            await Promise.all([load(), loadSource()])
            return result.message
          }, { intent: 'primary' }),
          secondary: [action('source-check', '检查', async input => (await call<{ message: string }>('POST', 'api/system/source', { ...sourceBody(input), check: true })).message)],
          note: ['现在的发布源：', { code: origin?.source ?? v.source }, origin?.token ? `（令牌 ${origin.token}）` : ''],
        }] : []),
      ],
    }]
  },
}
