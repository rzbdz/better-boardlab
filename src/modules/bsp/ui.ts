/**
 * The bsp module's part of the page: in settings, its board hosts. Add one (a name and how to reach the machine: an
 * address, a user, a password or nothing when boardd's key or this machine's ssh setup gets in), install bspd on it
 * with its progress shown as it goes, update it (install again) or remove it.
 */
import { call } from '../../ui/api.ts'
import { action, job, notice, open, text, type Element, type ModuleUi, type Sink, type View } from '../../ui/contract.ts'
import type { LabSettings } from 'boardlab-core/shared/types.ts'

/** POST a streaming bsp endpoint: its `out` lines to the sink, its `exit` as the result. */
async function stream(path: string, body: unknown, sink: Sink, signal: AbortSignal): Promise<{ ok: boolean, message: string }> {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(localStorage.getItem('boards.user') ? { 'x-boards-user': localStorage.getItem('boards.user')! } : {}) }, body: JSON.stringify(body), signal })
  if (!response.ok || !response.body) { let message = await response.text(); try { message = JSON.parse(message).error ?? message } catch {} throw new Error(message) }
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', result: { ok: boolean, message: string } | null = null
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let at: number
    while ((at = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, at); buffer = buffer.slice(at + 2)
      const event = /^event: (.*)$/m.exec(block)?.[1]
      const data = block.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
      if (!data) continue
      const parsed = JSON.parse(data)
      if (event === 'out') sink.line(String(parsed.text ?? ''))
      else if (event === 'exit') result = parsed
    }
  }
  if (!result) throw new Error('连接断了，没收到结果')
  if (!result.ok) throw new Error(result.message)
  return result
}

const ACCESS = [
  { kind: 'text' as const, id: 'address', label: '主机地址', placeholder: 'IP、域名，或者 ssh 配置里的名字', required: true },
  { kind: 'text' as const, id: 'user', label: '登录用户', placeholder: '默认 root（要能装系统服务）', initial: 'root' },
  { kind: 'secret' as const, id: 'password', label: '密码（可选）', placeholder: '不填：先试 boardd 自己的密钥，再试这台机器的 ssh 设置；填了只用一次，之后用密钥' },
  { kind: 'text' as const, id: 'jump', label: '跳板机（可选）', placeholder: 'user@jumphost' },
  { kind: 'text' as const, id: 'board', label: '主机型号（可选）', placeholder: '不填：从设备树自动认（决定 GPIO 引脚）' },
]

function install(lab: LabSettings | null): Element[] {
  const host = lab?.url?.replace(/^bspd\+ssh:\/\//, '') ?? ''
  const [user, address] = host.includes('@') ? host.split('@') as [string, string] : ['root', host]
  return [
    text(lab ? `重新装一遍（升级、修好），或者换一台机器。` : '新的板卡主机：boardd 用 ssh 过去，装好 bspd（Python 服务，管这台机器的复位线、串口和下载口），接入成一个实验室。'),
    {
      kind: 'form',
      fields: [
        ...(lab ? [] : [{ kind: 'text' as const, id: 'id', label: '实验室名', placeholder: '例如 com260（字母、数字、横线）', required: true, pattern: '[A-Za-z0-9][A-Za-z0-9_-]{0,31}' }]),
        ...ACCESS.map(field => field.id === 'address' ? { ...field, initial: address.replace(/:\d+$/, '') } : field.id === 'user' ? { ...field, initial: user || 'root' } : field),
      ],
      submitLabel: lab ? '重新安装' : '添加并安装',
      submit: job('install', lab ? '重新安装' : '添加并安装', async (input, sink, signal) => {
        const id = lab?.id ?? String(input.id).trim()
        if (!lab) { sink.line(`添加实验室 ${id}…`); await call('POST', 'api/labs/add', { id, kind: 'bsp' }) }
        const done = await stream('api/bsp/install', { id, address: input.address, user: input.user, password: input.password, jump: input.jump, board: input.board }, sink, signal)
        return done.message
      }, { intent: 'primary' }),
    },
  ]
}

export const ui: ModuleUi = {
  module: 'bsp',
  views(state): View[] {
    const labs = state.labs.filter(lab => lab.addedAs === 'bsp')
    return [{
      id: 'bsp-hosts', slot: 'settings', title: 'bsp 板卡主机',
      status: labs.length ? { tone: labs.every(lab => lab.enabled && lab.verifyOk !== false) ? 'ok' : 'warn', text: `${labs.length} 台` } : undefined,
      body: [
        text('接着板子的机器。每台装上 bspd，就是一个实验室：它的复位线、串口和下载口由 boardd 管，锁和排队在这里。'),
        ...(labs.length ? [{
          kind: 'list' as const,
          items: labs.map(lab => ({
            key: lab.id, title: lab.id,
            description: [lab.url?.replace(/^bspd\+/, '') ?? '还没装', lab.verifyMessage ? ` · ${lab.verifyMessage}` : ''].join(''),
            status: !lab.enabled ? { tone: 'warn' as const, text: '还没装好' } : lab.verifyOk === false ? { tone: 'error' as const, text: '连不上' } : { tone: 'ok' as const, text: '在线' },
            actions: [
              open('reinstall', '重新安装', `重新安装 ${lab.id}`, () => install(lab)),
              action('remove', '删除', async () => { await call('POST', 'api/bsp/uninstall', { id: lab.id }); return `删除了 ${lab.id}：主机上的 bspd 卸掉了` },
                { intent: 'danger', confirm: { title: `删除 ${lab.id}`, body: '卸掉主机上的 bspd（它的板子记录留在主机上），并从 boardlab 删掉这个实验室和它的板子。有人拿着锁时不能删。', action: '删除' } }),
            ],
          })),
        }] : [notice('还没有板卡主机。添加一台：给出地址和登录方式，boardd 会装好它。', 'neutral')]),
        { kind: 'actions', actions: [open('add', '添加板卡主机', '添加板卡主机', () => install(null), { intent: 'primary' })] },
      ],
    }]
  },
}
