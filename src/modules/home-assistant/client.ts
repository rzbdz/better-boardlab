/** Home Assistant access. The token stays inside this module's caller and never appears in errors. */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { HaDiscovery } from 'boardlab-core/shared/types.ts'

export interface HaConfig { url: string, token: string }

export interface HaClient {
  verify(config: HaConfig): Promise<string>
  call(config: HaConfig, entity: string): Promise<void>
  discover(config: HaConfig): Promise<HaDiscovery>
}

const TIMEOUT_MS = 8000
// A response may take this long once connected; service calls are never resent after connecting.
const SERVICE_TIMEOUT_MS = 15000
const CONNECT_TIMEOUT_MS = 4000
const CONNECT_ATTEMPTS = 3

function apiUrl(config: HaConfig, path: string) { return new URL(path, config.url.endsWith('/') ? config.url : config.url + '/').toString() }

/** The connection never opened, so the request did not reach HA. */
class NotConnected extends Error {}
/** HA answered with an error; its message is shown as is. */
class HaRejected extends Error {}

/**
 * One fresh connection per request, because a pooled keep-alive socket HA already closed makes a POST fail or hang.
 * A request whose connection never opened did not reach HA, so it is safe to try again; once connected it is not,
 * because a second press would reset the board twice.
 */
async function request(config: HaConfig, path: string, init: { method?: string, body?: string } = {}, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    try { return await requestOnce(config, path, init, timeoutMs) }
    catch (error) {
      if (error instanceof HaRejected) throw error
      if (!(error instanceof NotConnected) || attempt >= CONNECT_ATTEMPTS) throw new Error(`无法连接 Home Assistant：${(error as Error).message}`)
      await new Promise(resolve => setTimeout(resolve, 300 * attempt))
    }
  }
}

function requestOnce(config: HaConfig, path: string, init: { method?: string, body?: string }, timeoutMs: number): Promise<unknown> {
  const url = new URL(apiUrl(config, path))
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    let connected = false
    const req = send(url, {
      method: init.method ?? 'GET', agent: false,
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', Connection: 'close' },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        clearTimeout(timer)
        if (response.statusCode === 401) return reject(new HaRejected('Home Assistant 拒绝了令牌（401）'))
        if ((response.statusCode ?? 500) >= 400) return reject(new HaRejected(`Home Assistant 返回 ${response.statusCode}`))
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new HaRejected('Home Assistant 返回的不是 JSON')) }
      })
    })
    let timer = setTimeout(() => req.destroy(new NotConnected('连接超时')), CONNECT_TIMEOUT_MS)
    req.on('socket', socket => socket.once('connect', () => {
      connected = true
      clearTimeout(timer)
      timer = setTimeout(() => req.destroy(new Error('响应超时')), timeoutMs)
    }))
    req.on('error', error => {
      clearTimeout(timer)
      reject(connected || error instanceof NotConnected ? error : new NotConnected(error.message))
    })
    req.end(init.body)
  })
}

/** Reset switches pulse on `turn_on`; fastboot entities are buttons. */
export function serviceFor(entity: string): string {
  const domain = entity.split('.')[0]
  if (domain === 'switch') return 'switch/turn_on'
  if (domain === 'button') return 'button/press'
  throw new Error(`不支持的实体类型：${entity}`)
}

/** Group controller entities into slots by their `board_N_reset` / `board_N_fastboot_mode` suffix. */
export function groupEntities(entities: Array<{ entity_id: string, device_id?: string | null }>, devices: Map<string, string>): HaDiscovery {
  const slots = new Map<number, HaDiscovery['slots'][number]>()
  const unassigned: string[] = []
  for (const entity of entities) {
    const id = entity.entity_id
    const match = id.match(/board_(\d+)_(reset|fastboot_mode)$/)
    if (!match || !/^(switch|button)\./.test(id)) {
      if (/^(switch|button)\./.test(id)) unassigned.push(id)
      continue
    }
    const slot = Number(match[1])
    const entry = slots.get(slot) ?? { slot, resetEntity: null, fastbootEntity: null, device: null }
    if (match[2] === 'reset') entry.resetEntity = id; else entry.fastbootEntity = id
    entry.device ??= entity.device_id ? devices.get(entity.device_id) ?? null : null
    slots.set(slot, entry)
  }
  return {
    devices: [...devices].map(([id, name]) => ({ id, name })),
    slots: [...slots.values()].sort((a, b) => a.slot - b.slot),
    unassigned: unassigned.sort(),
  }
}

async function websocketCommands(config: HaConfig, commands: string[]): Promise<unknown[]> {
  const url = apiUrl(config, 'api/websocket').replace(/^http/, 'ws')
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const results: unknown[] = []
    const timer = setTimeout(() => { socket.close(); reject(new Error('Home Assistant WebSocket 超时')) }, TIMEOUT_MS)
    const finish = (error?: Error) => { clearTimeout(timer); socket.close(); error ? reject(error) : resolve(results) }
    socket.onerror = () => finish(new Error('无法连接 Home Assistant WebSocket'))
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data))
      if (message.type === 'auth_required') socket.send(JSON.stringify({ type: 'auth', access_token: config.token }))
      else if (message.type === 'auth_invalid') finish(new Error('Home Assistant 拒绝了令牌'))
      else if (message.type === 'auth_ok') commands.forEach((type, index) => socket.send(JSON.stringify({ id: index + 1, type })))
      else if (message.type === 'result') {
        if (!message.success) return finish(new Error(`Home Assistant 命令失败：${message.error?.message ?? commands[message.id - 1]}`))
        results[message.id - 1] = message.result
        if (results.filter(item => item !== undefined).length === commands.length) finish()
      }
    }
  })
}

export const homeAssistant: HaClient = {
  async verify(config) {
    const root = await request(config, 'api/') as { message?: string }
    const info = await request(config, 'api/config') as { location_name?: string, version?: string }
    return `${root.message ?? 'API running'}；${info.location_name ?? '未命名'} ${info.version ?? ''}`.trim()
  },
  async call(config, entity) {
    await request(config, `api/services/${serviceFor(entity)}`, { method: 'POST', body: JSON.stringify({ entity_id: entity }) }, SERVICE_TIMEOUT_MS)
  },
  async discover(config) {
    const commands = ['config/device_registry/list', 'config/entity_registry/list']
    // Reading the registries is harmless, so one more try covers a stalled connection.
    const [deviceList, entityList] = await websocketCommands(config, commands).catch(() => websocketCommands(config, commands)) as [
      Array<{ id: string, name?: string, name_by_user?: string, manufacturer?: string }>,
      Array<{ entity_id: string, device_id?: string | null, platform?: string }>,
    ]
    const controllers = new Map(deviceList
      .filter(device => entityList.some(entity => entity.device_id === device.id && entity.platform === 'esphome' && /board_\d+_(reset|fastboot_mode)$/.test(entity.entity_id)))
      .map(device => [device.id, device.name_by_user ?? device.name ?? device.id]))
    return groupEntities(entityList.filter(entity => entity.device_id && controllers.has(entity.device_id)), controllers)
  },
}
