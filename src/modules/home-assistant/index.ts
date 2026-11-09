/**
 * The `home-assistant` module: control slots on a Home Assistant board controller (`board_N_reset` switches and
 * `board_N_fastboot_mode` buttons). It keeps the slot table in step with the controller and can be switched off, which
 * hides its slots and never presses them.
 */
import type { HaDiscovery, HaSettings } from 'boardlab-core/shared/types.ts'
import { required } from 'boardlab-core/core/api.ts'
import { transaction } from 'boardlab-core/core/db.ts'
import { BoardError } from 'boardlab-core/core/errors.ts'
import type { Module } from 'boardlab-core/core/module.ts'
import { LOCAL, type LocalApi } from '../local/index.ts'
import type { SlotDriver } from '../local/slots.ts'
import type { HaClient, HaConfig } from './client.ts'

export interface HomeAssistantApi {
  enabled(): boolean
  settings(): HaSettings
  setEnabled(actor: string, enabled: boolean): HaSettings
  configure(actor: string, input: { url: string, token?: string | null }): Promise<HaSettings>
  test(actor: string): Promise<HaSettings>
  sync(actor?: string): Promise<void>
  confirm(actor: string, slots: Array<{ slot: number, resetEntity: string | null, fastbootEntity: string | null, device?: string | null }>): void
}

export function homeAssistant(options: { client: HaClient }): Module<HomeAssistantApi> {
  return {
    id: 'home-assistant',
    title: 'Home Assistant 控制器',
    requires: [LOCAL],
    setup(lab) {
      const { kernel } = lab
      const local = lab.module<LocalApi>(LOCAL)
      const settings = kernel.settings('ha')
      const client = options.client
      // On unless someone switched it off, so boardds set up before the switch keep using it.
      const enabled = () => settings.get('enabled') !== '0'
      const configured = () => !!settings.get('url') && !!settings.get('token')
      const config = (): HaConfig => {
        const url = settings.get('url'), token = settings.get('token')
        if (!enabled()) throw new BoardError('invalid', 'Home Assistant 已关闭（在「设置」里开启）')
        if (!url || !token) throw new BoardError('invalid', '还没有配置 Home Assistant')
        return { url, token }
      }
      const view = (): HaSettings => {
        const ok = settings.get('verify_ok')
        return {
          enabled: enabled(), url: settings.get('url'), hasToken: !!settings.get('token'), verifiedAt: settings.get('verified_at'),
          verifyOk: ok === null ? null : ok === '1', verifyMessage: settings.get('verify_message'),
        }
      }
      const slotRows = () => JSON.stringify(local.slots.list().map(slot => [slot.slot, slot.resetEntity, slot.fastbootEntity]))

      /**
       * Keep the slot table in step with the controller. People never pick entities: `board_N_reset` and
       * `board_N_fastboot_mode` entities are grouped into slot N. An empty answer changes nothing, and a slot that
       * vanished from HA is kept while a board still sits in it.
       */
      const sync = async (actor = 'boardd') => {
        let found: HaDiscovery
        try { found = await client.discover(config()) }
        catch (error) { throw new BoardError('hardware', (error as Error).message) }
        if (!found.slots.length) return
        const before = slotRows()
        transaction(kernel.db, () => {
          for (const slot of found.slots) {
            // A slot of another kind keeps its number even if the controller later offers the same one.
            kernel.db.prepare(`INSERT INTO slots(slot, reset_entity, fastboot_entity, device, confirmed_at) VALUES(?,?,?,?,?)
              ON CONFLICT(slot) DO UPDATE SET reset_entity=excluded.reset_entity, fastboot_entity=excluded.fastboot_entity, device=excluded.device WHERE slots.kind='ha'`)
              .run(slot.slot, slot.resetEntity, slot.fastbootEntity, slot.device, kernel.iso())
          }
          const keep = found.slots.map(slot => slot.slot)
          kernel.db.prepare(`DELETE FROM slots WHERE kind='ha' AND slot NOT IN (${keep.map(() => '?').join(',')}) AND slot NOT IN (SELECT slot FROM boards WHERE slot IS NOT NULL)`).run(...keep)
        })
        if (slotRows() !== before) { kernel.record(actor, null, 'slots-sync', `${found.slots.length} 个槽位`, true); kernel.changed(null) }
      }

      const test = async (actor: string) => {
        let ok = true, message: string
        try { message = await client.verify(config()) }
        catch (error) { ok = false; message = (error as Error).message }
        settings.set('verified_at', kernel.iso())
        settings.set('verify_ok', ok ? '1' : '0')
        settings.set('verify_message', message)
        kernel.record(actor, null, 'ha-test', null, ok, message)
        if (ok) await sync(actor).catch(() => {})
        kernel.changed(null)
        return view()
      }

      const driver: SlotDriver = {
        kind: 'ha',
        title: 'Home Assistant 控制器',
        enabled,
        disabled: slot => `槽位 ${slot} 在 Home Assistant 控制器上，Home Assistant 已关闭（在「设置」里开启）`,
        can: (slot, action) => !!(action === 'reset' ? slot.resetEntity : slot.fastbootEntity),
        cannot: (slot, action) => action === 'reset' ? `槽位 ${slot.slot} 没有复位实体` : `槽位 ${slot.slot} 没有 fastboot 实体`,
        describe: (slot, action) => (action === 'reset' ? slot.resetEntity : slot.fastbootEntity)!,
        press: (slot, action) => client.call(config(), (action === 'reset' ? slot.resetEntity : slot.fastbootEntity)!),
        check: () => { config() },
        refresh: async actor => { if (enabled() && configured()) await sync(actor) },
      }
      local.slots.addDriver(driver)
      lab.addState(() => ({ ha: view() }))
      // Pick up controller changes made in HA while boardd was down.
      lab.addService(() => { if (enabled() && configured()) void sync().catch(() => {}) })

      const api: HomeAssistantApi = {
        enabled,
        settings: view,
        sync,
        test,
        /**
         * Switch Home Assistant on or off. Off, boardd neither reads nor presses its controller and hides its slots;
         * boards registered on them stay listed but cannot be reset until it is on again.
         */
        setEnabled(actor, on) {
          if (!on) {
            const held = kernel.db.prepare(`SELECT boards.name, leases.holder FROM boards JOIN slots ON slots.slot = boards.slot JOIN leases ON leases.board = boards.name WHERE slots.kind='ha' AND leases.status='held' LIMIT 1`).get()
            if (held) throw new BoardError('locked', `${String(held.name)} 正被 ${String(held.holder)} 使用，放锁以后才能关掉 Home Assistant`)
          }
          settings.set('enabled', on ? '1' : '0')
          kernel.record(actor, null, 'ha-config', on ? '开启' : '关闭', true)
          kernel.changed(null)
          if (on && configured()) void sync(actor).catch(() => {})
          return view()
        },
        /** Save HA access. The token is write-only: omit it to keep the stored one. */
        async configure(actor, input) {
          let url: URL
          try { url = new URL(input.url) } catch { throw new BoardError('invalid', 'Home Assistant 地址不合法') }
          if (!/^https?:$/.test(url.protocol)) throw new BoardError('invalid', 'Home Assistant 地址须是 http 或 https')
          settings.set('url', url.toString().replace(/\/$/, ''))
          if (input.token) settings.set('token', input.token.trim())
          kernel.record(actor, null, 'ha-config', url.origin, true, input.token ? '已更新令牌' : null)
          return test(actor)
        },
        /** Set slots by hand (tests, and controllers HA cannot describe). */
        confirm(actor, slots) {
          transaction(kernel.db, () => {
            for (const slot of slots) {
              if (!Number.isInteger(slot.slot) || slot.slot < 0) throw new BoardError('invalid', `槽位号不合法：${slot.slot}`)
              for (const entity of [slot.resetEntity, slot.fastbootEntity]) {
                if (entity && !/^(switch|button)\.[a-z0-9_]+$/.test(entity)) throw new BoardError('invalid', `实体名不合法：${entity}`)
              }
              kernel.db.prepare(`INSERT INTO slots(slot, reset_entity, fastboot_entity, device, confirmed_at) VALUES(?,?,?,?,?)
                ON CONFLICT(slot) DO UPDATE SET reset_entity=excluded.reset_entity, fastboot_entity=excluded.fastboot_entity, device=excluded.device, confirmed_at=excluded.confirmed_at`)
                .run(slot.slot, slot.resetEntity, slot.fastbootEntity, slot.device ?? null, kernel.iso())
            }
            kernel.record(actor, null, 'slots-confirm', slots.map(slot => slot.slot).join(','), true)
          })
          kernel.changed(null)
        },
      }
      lab.api.add('home-assistant', [
        { method: 'POST', path: '/api/ha', about: '设置 Home Assistant 的地址和令牌并验证', handle: ({ body, caller }) => api.configure(caller.holder, { url: required(body.url, 'url'), token: body.token }) },
        { method: 'POST', path: '/api/ha/enabled', about: '开关 Home Assistant', handle: ({ body, caller }) => api.setEnabled(caller.holder, body.enabled === true) },
        { method: 'POST', path: '/api/ha/test', about: '重新验证 Home Assistant', handle: ({ caller }) => api.test(caller.holder) },
      ])
      return api
    },
  }
}
