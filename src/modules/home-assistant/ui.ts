/**
 * The home-assistant module's part of the page, as views any frontend renders: on settings, the switch for this
 * machine's Home Assistant controller and its address and token.
 */
import { call } from '../../ui/api.ts'
import { action, notice, plain, text, type ModuleUi, type View } from '../../ui/contract.ts'
import type { HaSettings } from 'boardlab-core/shared/types.ts'

const haApi = {
  configure: (url: string, token?: string) => call<HaSettings>('POST', 'api/ha', { url, token: token || undefined }),
  setEnabled: (enabled: boolean) => call<HaSettings>('POST', 'api/ha/enabled', { enabled }),
  test: () => call<HaSettings>('POST', 'api/ha/test'),
}

const verdict = (ha: HaSettings) => `${ha.verifyOk ? '连接正常' : '连接失败'}：${ha.verifyMessage ?? ''}`

export const ui: ModuleUi = {
  module: 'home-assistant',
  views(state): View[] {
    const ha = state.ha
    if (!ha) return []
    const slots = state.slots.filter(slot => slot.kind === 'ha').length
    return [{
      id: 'ha', slot: 'settings', title: 'Home Assistant',
      status: !ha.enabled ? { tone: 'warn', text: '未开启' } : ha.verifiedAt ? { tone: ha.verifyOk ? 'ok' : 'error', text: ha.verifyOk ? '连接正常' : '连接失败' } : undefined,
      body: [
        text('本机 Home Assistant 控制器上的复位开关和 fastboot 按钮，就是本机的槽位。'),
        {
          kind: 'actions', actions: [
            ha.enabled
              ? action('disable', '关闭', async () => { await haApi.setEnabled(false); return '已关闭 Home Assistant' },
                { confirm: { title: '关闭 Home Assistant', body: '关闭后 boardd 不再读也不再按 HA 控制器，它的槽位不显示；登记在这些槽位上的板子还在，但不能复位。', action: '关闭' } })
              : action('enable', '开启', async () => { await haApi.setEnabled(true); return '已开启 Home Assistant' }, { intent: 'primary' }),
          ],
        },
        ...(ha.enabled ? [{
          kind: 'form' as const,
          fields: [
            { kind: 'text' as const, id: 'url', label: '地址', initial: ha.url ?? '', placeholder: 'http://homeassistant.local:8123', required: true },
            { kind: 'secret' as const, id: 'token', label: '长期访问令牌', stored: ha.hasToken, placeholder: ha.hasToken ? '已保存（不显示，留空则不修改）' : '粘贴令牌' },
          ],
          submitLabel: '保存并验证',
          submit: action('save', '保存并验证', async input => { const next = await haApi.configure(String(input.url), String(input.token ?? '')); return plain(verdict(next)) }, { intent: 'primary' }),
          secondary: [action('test', '重新验证', async () => plain(verdict(await haApi.test())), { blocked: ha.hasToken ? undefined : '还没有令牌' })],
          note: ha.verifiedAt ? [verdict(ha), ' · ', { time: ha.verifiedAt }, ha.verifyOk ? ` · 控制器 ${slots} 个槽位` : ''] : undefined,
        }] : [notice('关闭时 boardd 不读也不按 HA 控制器。只用实验室（例如 bsp）时关掉。', 'neutral')]),
      ],
    }]
  },
}
