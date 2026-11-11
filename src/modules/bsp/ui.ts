/**
 * The bsp module's part of the page: in settings, its board hosts. Add one (a name and how to reach the machine: an
 * address, a user, a password or nothing when boardd's key or this machine's ssh setup gets in), install bspd on it
 * with its progress shown as it goes, update it (install again) or remove it. And the site the hosts read: where it
 * comes from, its SDKs and build servers (added, edited, removed), its SoC profiles and the images they need, and
 * syncing it to every host.
 */
import { call, stream } from '../../ui/api.ts'
import { action, job, notice, open, text, type Element, type ModuleUi, type View } from '../../ui/contract.ts'
import type { LabSettings } from 'boardlab-core/shared/types.ts'

const ACCESS = [
  { kind: 'text' as const, id: 'address', label: '主机地址', placeholder: 'IP、域名、ssh 配置里的名字，或 localhost（就是这台）', required: true },
  { kind: 'text' as const, id: 'user', label: '登录用户', placeholder: '默认 root（要能装系统服务）', initial: 'root' },
  { kind: 'secret' as const, id: 'password', label: '密码（可选）', placeholder: '不填：先试 boardd 自己的密钥，再试这台机器的 ssh 设置；填了只用一次，之后用密钥' },
  { kind: 'text' as const, id: 'jump', label: '跳板机（可选）', placeholder: 'user@jumphost' },
  { kind: 'text' as const, id: 'board', label: '主机型号（可选）', placeholder: '不填：从设备树自动认（决定 GPIO 引脚）' },
]

function install(lab: LabSettings | null): Element[] {
  // `bspd+ssh://user@host:port`, or this machine's own bspd on its loopback port.
  const host = lab?.url?.startsWith('bspd+http://127.0.0.1') ? 'root@localhost' : lab?.url?.replace(/^bspd\+ssh:\/\//, '') ?? ''
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

/** A bsp board's record, changed in bspd while you hold its lock: only the fields filled in change. */
function boardForm(board: string): Element[] {
  const keep = '不填：不改'
  return [
    text('改这块板子在 bsp 里的登记（要拿着锁）。只改填了的项。'),
    {
      kind: 'form',
      fields: [
        { kind: 'choice', id: 'fdl', label: '怎么进下载模式', initial: '', options: [
          { value: '', label: '不改' }, { value: 'strapped', label: '复位就进（FDL 拨码/短接了）' },
          { value: 'button', label: '按住 FDL 线再复位（要填 FDL 线）' }, { value: 'unset', label: '还不知道' }] },
        { kind: 'text', id: 'fdlPin', label: 'FDL 线', placeholder: `GPIO 引脚，例如 P15；${keep}` },
        { kind: 'text', id: 'resetPin', label: '复位线', placeholder: `GPIO 引脚，例如 P33；${keep}` },
        { kind: 'text', id: 'usb', label: '下载口', placeholder: `usb:2-1.3（fastboot devices -l 里看）；${keep}` },
        { kind: 'text', id: 'model', label: '型号', placeholder: `例如 k3_deb1；${keep}` },
        { kind: 'text', id: 'soc', label: 'SoC', placeholder: `例如 k3；${keep}` },
      ],
      submitLabel: '保存',
      submit: action('save', '保存', async input => (await call<{ message: string }>('POST', 'api/bsp/board', { board, ...input })).message, { intent: 'primary' }),
    },
  ]
}

// ---- the site: SDKs, build servers and SoC profiles every host reads, kept by boardd ----

type Kind = 'instances' | 'servers' | 'workspaces' | 'families'
interface SiteDoc { kind: Kind, id: string, file: string, layer: string, text: string, fields: Record<string, string> }
interface HostSync { revision: string, at: string, ok: boolean, message: string }
interface ImagesState { at: string, ok: boolean, message: string, fetched: string[], present: string[], failed: Array<{ image: string, error: string }>, missing: string[] }
interface SiteStatus {
  source: 'managed' | 'git', url: string, branch: string, ready: boolean, revision: string | null, ahead: number
  docs: SiteDoc[], socs: Array<{ soc: string, layer: string }>, problems: string[], hosts: Record<string, HostSync>, syncing: boolean
  images: ImagesState | null
}
let site: SiteStatus | null = null, siteError: string | null = null, loadedAt = 0
const loadSite = async () => {
  loadedAt = Date.now()
  try {
    const got = await call<SiteStatus>('GET', 'api/bsp/site')
    // A boardd without the site (an older one) answers something else: say so, and keep the hosts view working.
    if (!got || !Array.isArray(got.docs) || !got.hosts) { site = null; siteError = '这个 boardd 不管站点' }
    else { site = got; siteError = null }
  } catch (error) { siteError = (error as Error).message }
  return site
}
void loadSite()
/** Do something to the site, then read it again so the page shows the change. */
const change = async (path: string, body: unknown, say: (out: { message?: string, file?: string }) => string) => {
  try { return say(await call<{ message?: string, file?: string }>('POST', path, body)) } finally { await loadSite() }
}

function hostSite(id: string): string {
  const had = site?.hosts[id]
  if (!had) return site?.ready ? ' · 站点：还没同步' : ''
  return ` · 站点 ${had.revision || '无'}${had.ok ? '' : `（上次同步失败：${had.message.slice(0, 60)}）`}${had.revision && had.revision !== site?.revision ? '，不是最新' : ''}`
}

const KIND_NAME: Record<Kind, string> = { instances: 'SDK', servers: '编译服务器', workspaces: '源码树', families: '编译方式' }
const docs = (kind: Kind) => site?.docs.filter(doc => doc.kind === kind) ?? []
const fromPack = (doc: SiteDoc) => doc.layer !== 'site'

function sdkForm(doc: SiteDoc | null): Element[] {
  const f = doc?.fields ?? {}
  const pick = (kind: Kind, none?: string) => [...(none ? [{ value: '', label: none }] : []), ...docs(kind).map(item => ({ value: item.id, label: item.id }))]
  const boot = f.boot ?? ''
  return [
    text(doc ? `改 ${doc.file}。没改的内容和注释都保留。` : '新的 SDK：一棵 BSP 源码树，在哪台编译服务器上，怎么编，板子怎么启动。'),
    {
      kind: 'form',
      fields: [
        { kind: 'text', id: 'id', label: '名字', initial: doc?.id ?? '', required: true, pattern: '[A-Za-z0-9][A-Za-z0-9._-]{0,63}', placeholder: '例如 vendor-bsp-a' },
        { kind: 'choice', id: 'family', label: '编译方式', options: pick('families'), initial: f.family ?? docs('families')[0]?.id ?? '' },
        { kind: 'choice', id: 'server', label: '编译服务器', options: pick('servers', '（用源码树）'), initial: f.server ?? docs('servers')[0]?.id ?? '' },
        { kind: 'text', id: 'path', label: '源码路径', initial: f.path ?? '', placeholder: '编译服务器上的目录，例如 /home/dev/work/bsp-a' },
        { kind: 'choice', id: 'workspace', label: '源码树（可选）', options: pick('workspaces', '（不用，按服务器和路径）'), initial: f.workspace ?? '' },
        { kind: 'text', id: 'soc', label: 'SoC', initial: f.soc ?? '', placeholder: site?.socs.length ? `例如 ${site.socs.map(item => item.soc).slice(0, 3).join('、')}` : '例如 soc-a' },
        { kind: 'text', id: 'description', label: '说明', initial: f.description ?? '', wide: true },
        { kind: 'code', id: 'boot', label: '启动步骤（YAML）', initial: boot, rows: 10, help: '要有 load 和 download；还没写的用 status: todo。不填：新的 SDK 两个都先是 todo，修改时保留原样。' },
      ],
      submitLabel: doc ? '保存' : '添加',
      submit: action('save-sdk', doc ? '保存' : '添加', input => change('api/bsp/site/sdk', { ...input, original: doc?.id ?? '' }, out => `${doc ? '保存了' : '添加了'} ${out.file ?? input.id}`), { intent: 'primary' }),
    },
  ]
}

function serverForm(doc: SiteDoc | null): Element[] {
  const f = doc?.fields ?? {}
  return [
    text(doc ? `改 ${doc.file}。` : '新的编译服务器：bsp 用 ssh（user@host）到这里编 SDK。'),
    {
      kind: 'form',
      fields: [
        { kind: 'text', id: 'id', label: '名字', initial: doc?.id ?? '', required: true, pattern: '[A-Za-z0-9][A-Za-z0-9._-]{0,63}', placeholder: '例如 build-a' },
        { kind: 'text', id: 'host', label: '地址', initial: f.host ?? '', required: true, placeholder: 'IP、域名或 ssh 配置里的名字' },
        { kind: 'text', id: 'user', label: '用户', initial: f.user ?? '', required: true },
        { kind: 'text', id: 'description', label: '说明', initial: f.description ?? '', wide: true },
      ],
      submitLabel: doc ? '保存' : '添加',
      submit: action('save-server', doc ? '保存' : '添加', input => change('api/bsp/site/server', { ...input, original: doc?.id ?? '' }, out => `${doc ? '保存了' : '添加了'} ${out.file ?? input.id}`), { intent: 'primary' }),
    },
  ]
}

/** Any catalog document as its YAML (families and workspaces). */
function yamlForm(kind: Kind, doc: SiteDoc | null): Element[] {
  return [
    text(doc ? `改 ${doc.file}。` : `新的${KIND_NAME[kind]}，用 YAML 写（要有 id）。`),
    {
      kind: 'form',
      fields: [
        { kind: 'text', id: 'id', label: '名字', initial: doc?.id ?? '', required: true, pattern: '[A-Za-z0-9][A-Za-z0-9._-]{0,63}' },
        { kind: 'code', id: 'text', label: 'YAML', initial: doc?.text ?? 'id: \n', rows: 14, required: true },
      ],
      submitLabel: doc ? '保存' : '添加',
      submit: action('save-doc', doc ? '保存' : '添加', input => change('api/bsp/site/doc', { kind, ...input, original: doc?.id ?? '' }, out => `保存了 ${out.file ?? input.id}`), { intent: 'primary' }),
    },
  ]
}

function docList(kind: Kind, describe: (doc: SiteDoc) => string, form: (doc: SiteDoc | null) => Element[]): Element {
  return {
    kind: 'list', empty: `还没有${KIND_NAME[kind]}`,
    items: docs(kind).map(doc => ({
      key: `${doc.layer}/${doc.id}`, title: doc.id, description: describe(doc),
      tag: fromPack(doc) ? `bsp 自带（${doc.layer}）` : undefined,
      actions: fromPack(doc) ? [] : [
        open('edit', '编辑', `编辑${KIND_NAME[kind]} ${doc.id}`, () => form(doc)),
        action('remove', '删除', () => change('api/bsp/site/remove', { kind, id: doc.id }, out => out.message ?? `删掉了 ${doc.id}`),
          { intent: 'danger', confirm: { title: `删除 ${doc.id}`, body: `从站点删掉 ${doc.file}。同步后主机上也没有了。`, action: '删除' } }),
      ],
    })),
  }
}

function sourceForm(): Element[] {
  return [
    text('站点可以就在这里管，也可以跟着一个 git 仓库（用 boardd 的密钥、再用这台机器的 ssh 设置去取）。'),
    {
      kind: 'form',
      fields: [
        { kind: 'choice', id: 'source', label: '来源', options: [{ value: 'managed', label: '就在这里管' }, { value: 'git', label: 'git 仓库' }], initial: site?.source ?? 'managed' },
        { kind: 'text', id: 'url', label: 'git 地址', initial: site?.url ?? '', placeholder: 'git@git.example.test:lab/bsp-site.git' },
        { kind: 'text', id: 'branch', label: '分支', initial: site?.branch ?? 'main' },
        { kind: 'switch', id: 'discard', label: '丢掉这里的改动', initial: false, help: '这里的站点有新来源里没有的提交或改动时，不勾就不换（它们会留在一个本地分支里）' },
      ],
      submitLabel: '换来源',
      submit: action('set-source', '换来源', input => change('api/bsp/site/source', input, out => out.message ?? '换好了'), { intent: 'primary' }),
    },
  ]
}

function siteView(labs: LabSettings[]): View {
  if (Date.now() - loadedAt > 20_000) void loadSite()
  const s = site
  const sdkText = (doc: SiteDoc) => [doc.fields.workspace ? `源码树 ${doc.fields.workspace}` : `${doc.fields.server ?? '?'}:${doc.fields.path ?? '?'}`,
    doc.fields.soc ? `SoC ${doc.fields.soc}` : '', doc.fields.family ? `编译 ${doc.fields.family}` : '',
    `下载 ${doc.fields.download ?? '?'} / 内存启动 ${doc.fields.load ?? '?'}`, doc.fields.description ?? ''].filter(Boolean).join(' · ')
  const behind = s ? labs.filter(lab => s.hosts[lab.id]?.revision !== s.revision) : []
  return {
    id: 'bsp-site', slot: 'settings', title: 'SDK 与站点',
    status: !s ? undefined : s.problems.length ? { tone: 'warn', text: `${s.problems.length} 个问题` } : { tone: behind.length ? 'warn' : 'ok', text: s.revision ?? '空' },
    body: !s ? [siteError ? notice(`读不到站点：${siteError}`) : text('读取中…')] : [
      text('每台 bsp 主机都读的站点：SoC 资料、SDK 目录（SDK、编译服务器、编译方式、源码树）、钩子和镜像。在这里改，再同步到主机；主机自己的 hosts/ 不动。'),
      {
        kind: 'facts', items: [
          { label: '来源', value: s.source === 'git' ? [{ code: s.url }, ` 的 ${s.branch}`] : '就在这里管' },
          { label: '版本', value: s.revision ? { code: s.revision } : '还没有' },
          ...(s.source === 'git' ? [{ label: '没推送的提交', value: String(s.ahead), tone: s.ahead ? 'warn' as const : undefined }] : []),
          { label: '主机', value: labs.length ? `${labs.length - behind.length}/${labs.length} 台是这个版本` : '还没有' },
          { label: '镜像', value: s.images?.message ?? '还没取（拉取或同步时取）', tone: s.images && !s.images.ok ? 'warn' as const : undefined },
        ],
      },
      ...s.problems.map(problem => notice(problem)),
      // Images not there do not stop a sync; the hosts then lack them, so say which.
      ...(s.images?.failed ?? []).slice(0, 8).map(item => notice(`镜像 ${item.image} 没取到：${item.error}`)),
      ...(s.images?.missing ?? []).slice(0, 8).map(name => notice(`镜像 ${name} 哪儿都没有，也没写从哪取：放进站点的 socs/ 里，或在 soc.yaml 里写上 sha256 和 source`)),
      {
        kind: 'actions', actions: [
          job('sync', '同步到所有主机', async (_input, sink, signal) => { try { return (await stream('api/bsp/site/sync', {}, sink, signal)).message } finally { await loadSite() } }, {
            intent: 'primary', blocked: !labs.length ? '还没有 bsp 主机' : s.syncing ? '正在同步' : s.problems.length ? '站点有问题，先改好' : undefined,
          }),
          action('pull', '拉取', () => change('api/bsp/site/pull', {}, out => out.message ?? '拉好了'), { blocked: s.source !== 'git' ? '站点就在这里管' : undefined }),
          ...(s.source === 'git' ? [action('push', '推送', () => change('api/bsp/site/push', {}, out => out.message ?? '推送了'), { blocked: s.ahead ? undefined : '没有要推送的' })] : []),
          open('source', '换来源', '站点的来源', sourceForm),
        ],
      },
      { kind: 'group', title: 'SDK', body: [docList('instances', sdkText, sdkForm), { kind: 'actions', actions: [open('add-sdk', '添加 SDK', '添加 SDK', () => sdkForm(null))] }] },
      { kind: 'group', title: '编译服务器', body: [docList('servers', doc => [`${doc.fields.user ?? '?'}@${doc.fields.host ?? '?'}`, doc.fields.description ?? ''].filter(Boolean).join(' · '), serverForm), { kind: 'actions', actions: [open('add-server', '添加编译服务器', '添加编译服务器', () => serverForm(null))] }] },
      {
        kind: 'group', title: '编译方式和源码树', body: [
          docList('families', doc => [doc.fields.runner ? `用 ${doc.fields.runner}` : '', doc.fields.description ?? ''].filter(Boolean).join(' · '), doc => yamlForm('families', doc)),
          docList('workspaces', doc => `${doc.fields.server ?? '?'}:${doc.fields.path ?? '?'}`, doc => yamlForm('workspaces', doc)),
          { kind: 'actions', actions: [open('add-family', '添加编译方式', '添加编译方式', () => yamlForm('families', null)), open('add-workspace', '添加源码树', '添加源码树', () => yamlForm('workspaces', null))] },
        ],
      },
      {
        kind: 'group', title: 'SoC 资料', body: [{
          kind: 'list', empty: '没有 SoC 资料', items: s.socs.map(item => ({ key: `${item.layer}/${item.soc}`, title: item.soc, description: item.layer === 'site' ? `站点的 socs/${item.soc}` : `bsp 自带（${item.layer}）` })),
        }],
      },
    ],
  }
}

export const ui: ModuleUi = {
  module: 'bsp',
  views(state, context): View[] {
    const labs = state.labs.filter(lab => lab.addedAs === 'bsp')
    const board = context.board ? state.boards.find(item => item.name === context.board) : undefined
    if (board) {
      const bspBoard = !!board.lab && !board.lab.empty && labs.some(lab => lab.id === board.lab!.id)
      return bspBoard ? [{ id: 'bsp-board', slot: 'board', title: 'bsp 登记', body: [{ kind: 'actions', actions: [open('edit', '改登记…', `${board.name.toUpperCase()} 的 bsp 登记`, () => boardForm(board.name))] }] }] : []
    }
    return [{
      id: 'bsp-hosts', slot: 'settings', title: 'bsp 板卡主机',
      status: labs.length ? { tone: labs.every(lab => lab.enabled && lab.verifyOk !== false) ? 'ok' : 'warn', text: `${labs.length} 台` } : undefined,
      body: [
        text('接着板子的机器。每台装上 bspd，就是一个实验室：它的复位线、串口和下载口由 boardd 管，锁和排队在这里。'),
        ...(labs.length ? [{
          kind: 'list' as const,
          items: labs.map(lab => ({
            key: lab.id, title: lab.id,
            description: [lab.url?.replace(/^bspd\+/, '') ?? '还没装', lab.verifyMessage ? ` · ${lab.verifyMessage}` : '', hostSite(lab.id)].join(''),
            status: lab.busy ? { tone: 'neutral' as const, text: lab.busy.line ? `${lab.busy.label}：${lab.busy.line.slice(0, 60)}` : `${lab.busy.label}…` }
              : !lab.enabled ? { tone: 'warn' as const, text: '还没装好' } : lab.verifyOk === false ? { tone: 'error' as const, text: '连不上' } : { tone: 'ok' as const, text: '在线' },
            actions: [
              open('reinstall', '重新安装', `重新安装 ${lab.id}`, () => install(lab)),
              action('remove', '删除', async () => { await call('POST', 'api/bsp/uninstall', { id: lab.id }); return `删除了 ${lab.id}：主机上的 bspd 卸掉了` },
                { intent: 'danger', confirm: { title: `删除 ${lab.id}`, body: '卸掉主机上的 bspd（它的板子记录留在主机上），并从 boardlab 删掉这个实验室和它的板子。有人拿着锁时不能删。', action: '删除' } }),
            ],
          })),
        }] : [notice('还没有板卡主机。添加一台：给出地址和登录方式，boardd 会装好它。', 'neutral')]),
        { kind: 'actions', actions: [open('add', '添加板卡主机', '添加板卡主机', () => install(null), { intent: 'primary' })] },
      ],
    }, siteView(labs)]
  },
}
