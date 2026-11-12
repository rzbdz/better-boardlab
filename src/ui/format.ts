/** Formatting shared by the Ant Design frontend's views. */
import type { Board } from 'boardlab-core/shared/types.ts'

const pad = (n: number) => String(n).padStart(2, '0')
/** `11-10 09:40:05`, or the clock alone. */
export function stamp(iso: string | null | undefined, withDate = true) {
  if (!iso) return '—'
  const d = new Date(iso)
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return withDate ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock}` : clock
}
/** How long ago, briefly: `刚刚`, `5 分钟前`. */
export function ago(iso: string | null | undefined) {
  if (!iso) return '—'
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  return s < 45 ? '刚刚' : s < 3600 ? `${Math.round(s / 60)} 分钟前` : s < 86400 ? `${Math.round(s / 3600)} 小时前` : `${Math.round(s / 86400)} 天前`
}
/** `user:alice` → `alice`; agents keep their kind. */
export const who = (holder: string) => holder.startsWith('user:') ? holder.slice(5) : holder
/** `/dev/serial/by-path/…-usb-0:6.4.2:1.0-port0` → `USB 6.4.2`. */
export const shortLink = (link: string) => { const port = link.match(/-usb-\d+:([\d.]+):/)?.[1]; return port ? `USB ${port}` : link.split('/').at(-1)! }

export const MODE: Record<Board['mode'], string> = { unknown: '状态未知', normal: '已复位', resetting: '复位中', fastboot: 'fastboot' }
export const ACTIONS: Record<string, string> = {
  lock: '拿锁', unlock: '放锁', queue: '排队', unqueue: '退出排队', steal: '抢锁', reset: '复位', fastboot: '进入 fastboot',
  send: '串口输入', stage: '加载镜像', boot: '内存启动', scan: '开始扫描', 'scan-end': '扫描结束', 'scan-cancel': '取消扫描',
  'proposal-apply': '应用建议', 'proposal-reject': '拒绝建议', 'ha-config': '配置 HA', 'ha-test': '验证 HA', 'slots-confirm': '确认槽位',
  'slots-sync': '同步槽位', 'slot-save': '保存自定义槽位', 'slot-remove': '删除自定义槽位', add: '登记板子', remove: '移除板子', edit: '编辑板子',
  'lab-config': '配置实验室', 'lab-test': '验证实验室', 'lab-sync': '实验室板子变动', 'lab-lease': '实验室租约', 'lab-discover': '发现板子',
  'lab-rebuild': '重建主机', 'lab-bind': '用空闲端口登记', 'lab-ports': '接线变化', confirm: '确认人工操作', 'console-input': '串口交互',
  flash: '刷机', sdk: 'SDK 操作', relay: '继电器', refresh: '重新读取', 'lab-slot': '槽位换板',
  yield: '让给 AI', 'yield-request': 'AI 请求让出', cancel: '取消操作', 'lab-install': '装板卡主机', 'lab-remove': '删板卡主机',
  'bsp-board': '改 bsp 登记', update: '升级 boardlab', catalog: 'SDK 目录', bsp: 'bsp 命令', 'lab-sync-host': '同步站点',
  'flash-package': '刷机包', configure: '改操作',
}
/** One-click purposes when taking or queueing for a lock. */
export const PURPOSES = ['临时调试', 'boardlab 调试', '临时开发任务']
