/**
 * The clients module's part of the page: in settings, the machines that use this boardd through the CLI. Add one (how
 * to reach it as the user who works there), and boardd installs the CLI there and points it at itself, with the
 * progress shown as it goes; update it, check it, or remove it. Each says which version it has and whether boardd gets
 * in.
 */
import { call, stream } from '../../ui/api.ts'
import { action, job, notice, open, text, type Badge, type Element, type Field, type ModuleUi, type PageState, type View } from '../../ui/contract.ts'

interface Status { reachable: boolean | null, version: string | null, revision: string | null, remote: string | null, checkedAt: string | null, error: string | null }
interface Machine { id: string, address: string, user: string, jump?: string, sshPort?: number, status: Status, busy: boolean }
interface Clients {
  hub: { address: string | null, tunnel: string, sshPort: number | null, port: number, url: string | null }
  release: { version: string, revision: string } | null
  machines: Machine[]
}

const here = () => typeof location === 'undefined' ? '' : location.hostname

function badge(machine: Machine, clients: Clients): Badge {
  const s = machine.status
  if (machine.busy) return { tone: 'info', text: '正在装' }
  if (s.reachable === null && !s.error) return { tone: 'neutral', text: '没查过' }
  if (s.reachable === false) return { tone: 'error', text: '连不上' }
  if (!s.version) return { tone: 'warn', text: '没装' }
  if (s.error) return { tone: 'warn', text: '没连上 boardd' }
  if (clients.hub.url && s.remote !== clients.hub.url) return { tone: 'warn', text: '连的不是这台' }
  if (clients.release && s.revision !== clients.release.revision) return { tone: 'warn', text: `旧版 ${s.version}` }
  return { tone: 'ok', text: s.version }
}

function describe(machine: Machine): string {
  const s = machine.status
  return [
    `${machine.user}@${machine.address}${machine.sshPort ? `:${machine.sshPort}` : ''}${machine.jump ? `（经 ${machine.jump}）` : ''}`,
    s.version ? `boardlab ${s.version}（${s.revision}）` : '',
    s.checkedAt ? `${new Date(s.checkedAt).toLocaleString()} 查过` : '',
    s.error ?? '',
  ].filter(Boolean).join(' · ')
}

function install(clients: Clients, machine: Machine | null): Element[] {
  const fields: Field[] = [
    ...(machine ? [] : [{ kind: 'text' as const, id: 'id', label: '名字（可选）', placeholder: '不填就用地址', pattern: '[A-Za-z0-9][A-Za-z0-9_.\\-]{0,62}' }]),
    { kind: 'text', id: 'address', label: '机器地址', placeholder: 'IP、域名，或者 ssh 配置里的名字', required: true, initial: machine?.address },
    { kind: 'text', id: 'user', label: '登录用户', placeholder: '在那台机器上用命令行的普通用户（不能是 root）', required: true, initial: machine?.user },
    { kind: 'secret', id: 'password', label: '密码（可选）', placeholder: '不填：先试 boardd 自己的密钥，再试这台机器的 ssh 设置；填了只用一次，之后用密钥' },
    { kind: 'text', id: 'jump', label: '跳板机（可选）', placeholder: 'user@jumphost', initial: machine?.jump },
    { kind: 'text', id: 'hub', label: 'boardd 地址', initial: clients.hub.address ?? here(), required: true, help: `那台机器 ssh 到这台 boardd 用的地址；它以 ${clients.hub.tunnel} 登录，只能转发到 boardd 的端口` },
  ]
  return [
    text(machine
      ? '用这台 boardd 的版本重新装一遍（升级、修好），再连一次。'
      : '新的客户端：boardd 用 ssh 过去，用这台 boardd 的版本装好 boardlab 命令行（装在那个用户的 ~/.local 下），设成经 ssh 隧道连到这台 boardd，最后在那边跑一次 boardlab status。'),
    {
      kind: 'form', fields, submitLabel: machine ? '更新' : '添加并安装',
      submit: job('install', machine ? '更新' : '添加并安装', async (input, sink, signal) => (await stream('api/clients/install', {
        id: machine?.id ?? input.id, address: input.address, user: input.user, password: input.password, jump: input.jump ?? '', hub: input.hub,
      }, sink, signal)).message, { intent: 'primary' }),
    },
  ]
}

function remove(machine: Machine): Element[] {
  return [
    text(`那台机器上的命令行不再连这台 boardd，收回它的隧道授权，boardd 也拿掉自己放在那边的密钥。连不上那台机器时，只从这里删掉。`),
    {
      kind: 'form', fields: [{ kind: 'switch', id: 'uninstall', label: '也卸掉命令行', initial: false }], submitLabel: '删除',
      submit: action('remove', '删除', async input => (await call<{ message: string }>('POST', 'api/clients/remove', { id: machine.id, uninstall: input.uninstall === true })).message, { intent: 'danger' }),
    },
  ]
}

function hubForm(clients: Clients): Element[] {
  return [
    text('客户端经 ssh 连到这台 boardd：以隧道用户登录这台机器，只能转发到 boardd 的端口。改了以后，更新一下各台机器。'),
    {
      kind: 'form', submitLabel: '保存',
      fields: [
        { kind: 'text', id: 'address', label: 'boardd 地址', initial: clients.hub.address ?? here(), required: true, help: '那些机器 ssh 到这里用的地址：IP、域名' },
        { kind: 'text', id: 'tunnel', label: '隧道用户', initial: clients.hub.tunnel, required: true, help: 'boardd 以 root 运行时，没有这个用户就建一个只能开隧道的' },
        { kind: 'number', id: 'sshPort', label: 'ssh 端口', initial: clients.hub.sshPort ?? 22, min: 1, max: 65535 },
      ],
      submit: action('save', '保存', async input => { await call('POST', 'api/clients/settings', input); return '保存了' }, { intent: 'primary' }),
    },
  ]
}

const hubUrl = (clients: Clients) => clients.hub.url ?? `ssh://${clients.hub.tunnel}@${clients.hub.address ?? (here() || '<地址>')}`

/** The clients as text for an AI assistant: how they reach this boardd, and each machine (no password is kept). */
function clientsContext(clients: Clients): string {
  return [
    `这台 boardd：${clients.release ? `boardlab ${clients.release.version}（${clients.release.revision}）` : '从源码跑的（不能从页面给别的机器装命令行）'}`,
    `客户端连过来用：${hubUrl(clients)}（隧道用户 ${clients.hub.tunnel}，ssh 端口 ${clients.hub.sshPort ?? 22}）`,
    '已经加的机器：',
    ...(clients.machines.length ? clients.machines.map(machine => `- ${machine.id}：${describe(machine)}；${badge(machine, clients).text}`) : ['（还没有）']),
  ].join('\n')
}

export const ui: ModuleUi = {
  module: 'clients',
  views(state: PageState): View[] {
    const clients = (state as PageState & { clients?: Clients }).clients
    if (!clients) return []
    const noRelease = clients.release ? undefined : '这个 boardd 是从源码跑的'
    const behind = clients.machines.filter(machine => badge(machine, clients).tone !== 'ok')
    return [{
      id: 'cli-machines', slot: 'settings', title: '客户端配置', help: 'clients',
      hint: {
        commands: [`boardlab remote set ${hubUrl(clients)}`, 'boardlab remote show', 'boardlab status', 'boardlab install'],
        context: () => clientsContext(clients),
        produce: '在那台机器上要跑的命令（装命令行、连到这台 boardd、给 agent 装 skill），或者在页面上「添加机器」要填的内容',
      },
      status: clients.machines.length ? { tone: behind.length ? 'warn' : 'ok', text: `${clients.machines.length} 台` } : undefined,
      body: [
        text('用 boardlab 命令行的机器（编译服务器、笔记本）。boardd 用 ssh 过去装好命令行，让它经 ssh 隧道连到这台 boardd，人和 agent 就在那边拿板子。'),
        {
          kind: 'facts', items: [
            { label: '这台 boardd', value: clients.release ? `boardlab ${clients.release.version}（${clients.release.revision}）` : '从源码跑的' },
            { label: '连过来用', value: { code: hubUrl(clients) } },
          ],
        },
        ...(clients.release ? [] : [notice('这个 boardd 是从源码跑的，没有发布包可装。用 install.sh 装的 boardd 才能给别的机器装命令行；也可以在那台机器上自己跑 install.sh，再 boardlab remote set。')]),
        ...(clients.machines.length ? [{
          kind: 'list' as const,
          items: clients.machines.map(machine => ({
            key: machine.id, title: machine.id, description: describe(machine), status: badge(machine, clients),
            actions: [
              open('update', '更新', `更新 ${machine.id}`, () => install(clients, machine), { blocked: noRelease ?? (machine.busy ? '正在装' : undefined) }),
              action('check', '检查', async () => {
                const now = await call<Clients>('POST', 'api/clients/check', { id: machine.id })
                const found = now.machines.find(item => item.id === machine.id)
                return found ? `${machine.id}：${badge(found, now).text}` : undefined
              }, { blocked: machine.busy ? '正在装' : undefined }),
              open('remove', '删除', `删除 ${machine.id}`, () => remove(machine), { intent: 'danger', blocked: machine.busy ? '正在装' : undefined }),
            ],
          })),
        }] : [notice('还没有客户端。添加一台：给出地址和那边的用户，boardd 会装好命令行并连过来。', 'neutral')]),
        {
          kind: 'actions', actions: [
            open('add', '添加机器', '添加客户端', () => install(clients, null), { intent: 'primary', blocked: noRelease }),
            open('hub', '连接设置', '客户端怎么连过来', () => hubForm(clients)),
            action('check-all', '全部检查', async () => {
              const now = await call<Clients>('POST', 'api/clients/check', {})
              const ok = now.machines.filter(machine => badge(machine, now).tone === 'ok').length
              return `查了 ${now.machines.length} 台：${ok} 台是最新的`
            }, { blocked: clients.machines.length ? undefined : '还没有机器' }),
          ],
        },
      ],
    }]
  },
}
