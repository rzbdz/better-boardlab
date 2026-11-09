/** The home-assistant module on the page: its access and switch, on the settings tab. */
import { useState } from 'react'
import type { HaSettings, Slot } from 'boardlab-core/shared/types.ts'
import { call } from 'boardlab-core/ui/api.ts'
import type { ModuleUi, ViewProps } from 'boardlab-core/ui/extensions.ts'
import { Pill, Section, time, type Run } from 'boardlab-core/ui/kit.tsx'

const haApi = {
  configure: (url: string, token?: string) => call<HaSettings>('POST', 'api/ha', { url, token: token || undefined }),
  setEnabled: (enabled: boolean) => call<HaSettings>('POST', 'api/ha/enabled', { enabled }),
  test: () => call<HaSettings>('POST', 'api/ha/test'),
}

function HaSection({ ha, slots, onRun }: { ha: HaSettings, slots: Slot[], onRun: Run }) {
  const [url, setUrl] = useState(ha.url ?? '')
  const [token, setToken] = useState('')
  return (
      <Section title="Home Assistant" extra={!ha.enabled ? <Pill tone="warn">未开启</Pill> : ha.verifiedAt && <Pill tone={ha.verifyOk ? 'ok' : 'err'}>{ha.verifyOk ? '连接正常' : '连接失败'}</Pill>}>
        <div className="form-grid">
          <label className="switch span"><input type="checkbox" checked={ha.enabled} onChange={event => { const on = event.target.checked; void onRun(on ? '已开启 Home Assistant' : '已关闭 Home Assistant', () => haApi.setEnabled(on)) }} />开启本机的 Home Assistant 控制器（复位开关和 fastboot 按钮）</label>
          {!ha.enabled && <p className="muted span">关闭时 boardd 不读也不按 HA 控制器，它的槽位不显示；登记在这些槽位上的板子还在，但不能复位。只用实验室（例如 bsp）时关掉。</p>}
        </div>
        {ha.enabled && <form className="form-grid" onSubmit={event => { event.preventDefault(); void onRun('已保存', async () => { await haApi.configure(url, token); setToken('') }) }}>
          <label>地址<input value={url} onChange={event => setUrl(event.target.value)} placeholder="http://homeassistant.local:8123" required /></label>
          <label>长期访问令牌
            <input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off"
              placeholder={ha.hasToken ? '已保存（不显示，留空则不修改）' : '粘贴令牌'} />
          </label>
          <div className="actions span">
            <button className="primary">保存并验证</button>
            <button type="button" disabled={!ha.hasToken} onClick={() => onRun('验证完成', () => haApi.test())}>重新验证</button>
            {ha.verifiedAt && <span className={ha.verifyOk ? 'muted' : 'warn'} data-testid="ha-status">{ha.verifyOk ? '连接正常' : '连接失败'}：{ha.verifyMessage} · {time(ha.verifiedAt)}{ha.verifyOk ? ` · 控制器 ${slots.filter(slot => slot.kind === 'ha').length} 个槽位` : ''}</span>}
          </div>
        </form>}
      </Section>
  )
}

function HaSettingsSection({ state, onRun }: ViewProps) {
  return state.ha ? <HaSection ha={state.ha} slots={state.slots} onRun={onRun} /> : null
}

export const ui: ModuleUi = { module: 'home-assistant', settings: HaSettingsSection }
