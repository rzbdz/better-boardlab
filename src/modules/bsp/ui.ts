/**
 * The bsp module's part of the page: in settings, its board hosts. Add one (a name and how to reach the machine: an
 * address, a user, a password or nothing when boardd's key or this machine's ssh setup gets in), install bspd on it
 * with its progress shown as it goes, update it (install again) or remove it. And the site the hosts read: where it
 * comes from, its SDKs and build servers (added, edited, removed), its SoC facts and the images they need, and
 * syncing it to every host.
 */
import { call, stream } from '../../ui/api.ts'
import { action, job, notice, open, text, type Element, type ModuleUi, type View } from '../../ui/contract.ts'
import type { Board, LabSettings } from 'boardlab-core/shared/types.ts'

const ACCESS = [
  { kind: 'text' as const, id: 'address', label: '主机地址', placeholder: 'IP、域名、ssh 配置里的名字，或 localhost（就是这台）', required: true },
  { kind: 'text' as const, id: 'user', label: '登录用户', placeholder: '默认 root（要能装系统服务）', initial: 'root' },
  { kind: 'secret' as const, id: 'password', label: '密码（可选）', placeholder: '不填：先试 boardd 自己的密钥，再试这台机器的 ssh 设置；填了只用一次，之后用密钥' },
  { kind: 'text' as const, id: 'jump', label: '跳板机（可选）', placeholder: 'user@jumphost' },
  { kind: 'choice' as const, id: 'board', label: '主机型号（决定 GPIO 排针图和复位线）', initial: 'auto', options: [] as Array<{ value: string, label: string }> },
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
        ...ACCESS.map(field => field.id === 'address' ? { ...field, initial: address.replace(/:\d+$/, '') } : field.id === 'user' ? { ...field, initial: user || 'root' }
          : field.id === 'board' ? { ...field, options: modelOptions() } : field),
      ],
      submitLabel: lab ? '重新安装' : '添加并安装',
      submit: job('install', lab ? '重新安装' : '添加并安装', async (input, sink, signal) => {
        const id = lab?.id ?? String(input.id).trim()
        if (!lab) { sink.line(`添加实验室 ${id}…`); await call('POST', 'api/labs/add', { id, kind: 'bsp' }) }
        try {
          const done = await stream('api/bsp/install', { id, address: input.address, user: input.user, password: input.password, jump: input.jump, board: input.board }, sink, signal)
          return done.message
        } catch (error) {
          // A lab added for this attempt and then not installed is not a lab: without this, the next try would be
          // refused ("已经有实验室") and the form could never retry.
          if (!lab) await call('POST', 'api/labs/remove', { id }).catch(() => {})
          throw error
        }
      }, { intent: 'primary' }),
    },
  ]
}

/** Where a host's GPIO page is opened: directly at its bspd (`bspd+ssh://user@host:p`), or through boardd for a host
 * on boardd's own machine, which answers only on loopback. */
function gpioLink(url: string | null, lab: string): string {
  const match = /^bspd\+(http|ssh):\/\/(?:[^@/]*@)?([^:/]+)(?::(\d+))?\/?$/.exec(url ?? '')
  if (!match || match[1] === 'http') return `api/bsp/hosts/${encodeURIComponent(lab)}/panel/`
  return `http://${match[2]}:${match[3] ?? '8765'}/`
}

interface BoardChoices {
  control: { backend?: string, reset?: { pin?: string }, fdl?: { strategy?: string, pin?: string } }
  usb: string | null, gpios: Array<{ value: string, label: string }>, ports: Array<{ value: string, label: string }>
  /** Its SoC and SDKs as registered, and the SoCs and SDKs the catalog offers (`sdks` empty: every SDK of its SoC). */
  soc: string | null, sdks: string[], socs: Array<{ value: string, label: string }>, sdkOptions: Array<{ value: string, label: string }>
}
/** A bsp board's record, edited as choices from its actual host, never hand-written GPIO/USB identifiers. */
const boardChoices = new Map<string, BoardChoices>()
const boardAsking = new Map<string, Promise<BoardChoices>>()
function readBoardChoices(board: string): Promise<BoardChoices> {
  const asking = boardAsking.get(board)
  if (asking) return asking
  const ask = call<BoardChoices>('GET', `api/bsp/board?board=${encodeURIComponent(board)}`)
  boardAsking.set(board, ask)
  return ask.then(current => { boardChoices.set(board, current); return current })
    .finally(() => { if (boardAsking.get(board) === ask) boardAsking.delete(board) })
}
function boardForm(board: string, current: BoardChoices): Element[] {
  boardChoices.set(board, current)
  const option = (value: string | undefined, label: string) => value ? [{ value, label }] : []
  const withCurrent = (options: Array<{ value: string, label: string }>, value: string | undefined) =>
    options.some(item => item.value === value) || !value ? options : [...options, { value, label: `${value}（当前登记，未在扫描中）` }]
  const gpios = withCurrent(current.gpios, current.control.reset?.pin)
  const fdlGpios = withCurrent(gpios, current.control.fdl?.pin)
  const ports = withCurrent(current.ports, current.usb ?? undefined)
  const currentFdl = current.control.fdl?.strategy ?? 'unset'
  return [
    text('改登记（保存时检查你持有这块板子的锁）。GPIO 和下载口来自主机的实际列表；human 表示由人完成该动作。SoC 和 SDK 决定这块板子能用哪些启动/刷机配方。'),
    { kind: 'select-many', id: 'sdks', label: 'SDK（不选 = 这个 SoC 的全部）', options: current.sdkOptions, initial: current.sdks },
    { kind: 'form', fields: [
      { kind: 'choice', id: 'soc', label: 'SoC', initial: current.soc ?? '', options: [
        { value: '', label: '不改 / 不知道' }, ...current.socs] },
      { kind: 'choice', id: 'resetPin', label: 'reset GPIO', initial: current.control.reset?.pin ?? '', options: [
        { value: '', label: '不改 / 不使用' }, ...gpios] },
      { kind: 'choice', id: 'fdl', label: '怎么进下载模式', initial: currentFdl, options: [
        { value: 'unset', label: '还不知道' }, { value: 'button', label: '按 BOOT + RESET' },
        { value: 'strapped', label: '复位就进下载模式' }] },
      { kind: 'choice', id: 'fdlPin', label: 'FDL GPIO', initial: current.control.fdl?.pin ?? '', options: [
        { value: '', label: '不改 / 不使用' }, ...fdlGpios] },
      { kind: 'choice', id: 'usb', label: '下载口', initial: current.usb ?? '', options: [
        { value: '', label: '不改' }, ...ports] },
    ], submitLabel: '保存',
      submit: action('save', '保存', async input => {
        // Only what changed is sent: an untouched field that is only observable in some state (the download port is
        // enumerated in download mode) must not make a save fail. Every save may say which SDKs explicitly; an
        // empty list means every SDK of the SoC (bsp's own default).
        const changed: Record<string, unknown> = { board }
        const sdks = input.sdks as string[] | undefined
        if (sdks !== undefined && sdks.join('\u0000') !== (current.sdks ?? []).join('\u0000')) changed.sdks = sdks
        if (typeof input.usb === 'string' && input.usb && input.usb !== current.usb) changed.usb = input.usb
        if (typeof input.soc === 'string' && input.soc && input.soc !== current.soc) changed.soc = input.soc
        if (typeof input.resetPin === 'string' && input.resetPin && input.resetPin !== current.control.reset?.pin) changed.resetPin = input.resetPin
        if (typeof input.fdlPin === 'string' && input.fdlPin && input.fdlPin !== current.control.fdl?.pin) changed.fdlPin = input.fdlPin
        if (typeof input.fdl === 'string' && input.fdl && input.fdl !== currentFdl) changed.fdl = input.fdl
        if (Object.keys(changed).length === 1) return '没有改动'
        return (await call<{ message: string }>('POST', 'api/bsp/board', changed)).message
      }, { intent: 'primary', using: ['sdks'] }) },
  ]
}

function openBoardForm(board: string) {
  const cached = boardChoices.get(board)
  return open('edit', '改登记…', `${board.toUpperCase()} 的 bsp 登记`, () => cached ? boardForm(board, cached) : [], {
    load: () => readBoardChoices(board).then(current => boardForm(board, current)),
  })
}

// ---- the site: SDKs, build servers and SoC facts every host reads, kept by boardd ----

type Kind = 'instances' | 'servers' | 'workspaces' | 'families'
interface SiteDoc { kind: Kind, id: string, file: string, layer: string, text: string, fields: Record<string, string> }
interface SiteSkill { id: string, layer: string, file: string, title: string }
interface HostSync { revision: string, at: string, ok: boolean, message: string }
interface ImagesState { at: string, ok: boolean, message: string, fetched: string[], present: string[], failed: Array<{ image: string, error: string }>, missing: string[], optional?: string[] }
interface SiteStatus {
  source: 'managed' | 'git', url: string, branch: string, ready: boolean, revision: string | null, commit?: { subject: string, at: string } | null, ahead: number
  docs: SiteDoc[], skills?: SiteSkill[], socs: Array<{ soc: string, layer: string }>, problems: string[], hosts: Record<string, HostSync>, syncing: boolean
  images: ImagesState | null
}
// The host models bsp has a header map for, as boardd's bsp tree lists them; loaded once.
let hostModels: Array<{ id: string, name: string }> = []
void call<{ boards: Array<{ id: string, name: string }> }>('GET', 'api/bsp/boards').then(got => { if (Array.isArray(got?.boards)) hostModels = got.boards }).catch(() => {})
const modelOptions = () => [{ value: 'auto', label: '自动识别（从设备树）' }, ...hostModels.map(item => ({ value: item.id, label: `${item.name}（${item.id}）` })),
  { value: 'none', label: '没有 GPIO（只靠人工复位）' }]
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
const KIND_CLI: Record<Kind, string> = { instances: 'sdk', servers: 'server', workspaces: 'workspace', families: 'family' }
const ID_PATTERN = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}'
const docs = (kind: Kind) => site?.docs.filter(doc => doc.kind === kind) ?? []
const fromPack = (doc: SiteDoc) => doc.layer !== 'site'
const saved = (doc: SiteDoc | null, id: unknown) => (out: { file?: string }) => `${doc ? '保存了' : '添加了'} ${out.file ?? String(id)}`

/** A new SDK's boot methods: both not written yet, with the usual steps to start from, commented out. */
const BOOT_EXAMPLE = `load:                        # 内存启动：加载命令不主动刷写存储、saveenv 或改启动脚本；FSBL 的 DDR training 可能写 SPI NOR，启动后的系统也可能写存储
  status: todo                 # 写好步骤后改成 ready
  notes: 启动步骤还没写
  steps: []
  # steps:
  #   - {do: enter-fdl}                     # 复位进下载模式
  #   - {do: stage, artifact: fsbl}         # 产物的角色名，见编译方式的 artifacts.roles
  #   - {do: continue}
  #   - {do: wait, serial: "SPL", fastboot: "Fastboot", timeout: 60}
  #   - {do: stage, artifact: uboot-sbi}
  #   - {do: continue}
  #   - {do: wait, serial: "U-Boot 20", fastboot: "Fastboot", timeout: 60}
  #   - {do: stage, artifact: kernel-fit}
  #   - {do: continue}
  #   - {do: wait, serial: "login:", fail: "Kernel panic", timeout: 120}
download:                      # 刷机：写进存储，再冷启动
  status: todo
  notes: 刷机步骤还没写
  steps: []
  # steps:
  #   - {do: enter-fdl}
  #   - {do: stage, artifact: fsbl}
  #   - {do: continue}
  #   - {do: wait, fastboot: "Fastboot", timeout: 60}
  #   - {do: hook, kind: flash, name: my-flash-tool, artifacts: [flash-zip], timeout: 1800}
  #   - {do: reset, when: fdl-not-strapped, why: 从刷好的存储冷启动}
  #   - {do: wait, when: fdl-not-strapped, serial: "login:", timeout: 180}
`

function sdkForm(doc: SiteDoc | null, preset: { server?: string } = {}): Element[] {
  const f = doc?.fields ?? {}
  const pick = (kind: Kind, none?: string) => [...(none ? [{ value: '', label: none }] : []), ...docs(kind).map(item => ({ value: item.id, label: fromPack(item) ? `${item.id}（bsp 自带）` : item.id }))]
  const socs = [...new Set([...(site?.socs ?? []).map(item => item.soc), ...(f.soc ? [f.soc] : [])])]
  const server = f.server ?? (doc ? '' : preset.server ?? docs('servers')[0]?.id ?? '')
  return [
    text(doc ? `改 ${doc.file}。没改的内容和注释都保留。` : `新的 SDK：一棵源码树${preset.server ? `，在 ${preset.server} 上` : ''}，怎么编，板子怎么启动和刷机。`),
    {
      kind: 'form',
      fields: [
        { kind: 'text', id: 'id', label: '名字', initial: doc?.id ?? '', required: true, pattern: ID_PATTERN, placeholder: '例如 vendor-bsp-a' },
        { kind: 'choice', id: 'family', label: '编译方式', doc: 'sdk-families', options: pick('families'), initial: f.family ?? docs('families')[0]?.id ?? '' },
        { kind: 'choice', id: 'server', label: '编译服务器', doc: 'sdk-servers', options: pick('servers', '（用源码树）'), initial: server },
        { kind: 'text', id: 'path', label: '源码路径', initial: f.path ?? '', placeholder: '编译服务器上的目录，例如 /home/dev/work/bsp-a' },
        { kind: 'choice', id: 'workspace', label: '源码树（可选）', options: pick('workspaces', '（不用，按服务器和路径）'), initial: f.workspace ?? '' },
        { kind: 'choice', id: 'soc', label: 'SoC', doc: 'soc-profiles', options: [{ value: '', label: '（不限）' }, ...socs.map(soc => ({ value: soc, label: soc }))], initial: f.soc ?? '' },
        { kind: 'text', id: 'description', label: '说明', initial: f.description ?? '', wide: true },
        { kind: 'code', id: 'boot', label: '启动和刷机步骤（YAML）', doc: 'sdk-instances', initial: doc ? f.boot ?? '' : BOOT_EXAMPLE, rows: 14,
          help: 'load 是内存启动，download 是刷机，两个都要有；还没写的用 status: todo。步骤的写法见「?」。' },
      ],
      submitLabel: doc ? '保存' : '添加',
      submit: action('save-sdk', doc ? '保存' : '添加', input => change('api/bsp/site/sdk', { ...input, original: doc?.id ?? '' }, saved(doc, input.id)), { intent: 'primary' }),
    },
  ]
}

function serverForm(doc: SiteDoc | null): Element[] {
  const f = doc?.fields ?? {}
  return [
    text(doc ? `改 ${doc.file}。表单里没有的键（home_aliases、env）和注释都保留。` : '新的编译服务器：bsp 用 ssh（user@host）到这里编 SDK。boardd 和板卡主机都要能用密钥登录它。'),
    {
      kind: 'form',
      fields: [
        { kind: 'text', id: 'id', label: '名字', initial: doc?.id ?? '', required: true, pattern: ID_PATTERN, placeholder: '例如 build-a' },
        { kind: 'text', id: 'host', label: '地址', initial: f.host ?? '', required: true, placeholder: 'IP、域名或 ssh 配置里的名字' },
        { kind: 'text', id: 'user', label: '用户', initial: f.user ?? '', required: true },
        { kind: 'text', id: 'description', label: '说明', initial: f.description ?? '', wide: true },
      ],
      submitLabel: doc ? '保存' : '添加',
      submit: action('save-server', doc ? '保存' : '添加', input => change('api/bsp/site/server', { ...input, original: doc?.id ?? '' }, saved(doc, input.id)), { intent: 'primary' }),
    },
  ]
}

/** Any catalog document as its YAML; `kind` null: chosen in the form. */
function yamlForm(kind: Kind | null, doc: SiteDoc | null): Element[] {
  return [
    text(doc ? `改 ${doc.file} 的原文。` : `新的${kind ? KIND_NAME[kind] : '文档'}，用 YAML 写（id 和名字一样）。`),
    {
      kind: 'form',
      fields: [
        ...(kind ? [] : [{ kind: 'choice' as const, id: 'kind', label: '种类', options: (Object.keys(KIND_NAME) as Kind[]).map(value => ({ value, label: KIND_NAME[value] })), initial: 'instances' }]),
        { kind: 'text', id: 'id', label: '名字', initial: doc?.id ?? '', required: true, pattern: ID_PATTERN },
        { kind: 'code', id: 'text', label: 'YAML', initial: doc?.text ?? 'id: \n', rows: 16, required: true },
      ],
      submitLabel: doc ? '保存' : '添加',
      submit: action('save-doc', doc ? '保存' : '添加', input => change('api/bsp/site/doc', { kind: kind ?? input.kind, id: input.id, text: input.text, original: doc?.id ?? '' }, saved(doc, input.id)), { intent: 'primary' }),
    },
  ]
}

function docActions(kind: Kind, doc: SiteDoc, form?: (doc: SiteDoc) => Element[]) {
  if (fromPack(doc)) return []
  return [
    // Documents with a form are edited there (their YAML under 高级 → 编辑原文); the rest as YAML.
    form ? open('edit', '编辑', `编辑${KIND_NAME[kind]} ${doc.id}`, () => form(doc)) : open('raw', '编辑', `${KIND_NAME[kind]} ${doc.id} 的原文`, () => yamlForm(kind, doc)),
    action('remove', '删除', () => change('api/bsp/site/remove', { kind, id: doc.id }, out => out.message ?? `删掉了 ${doc.id}`),
      { intent: 'danger', confirm: { title: `删除 ${doc.id}`, body: `从站点删掉 ${doc.file}。同步后主机上也没有了。`, action: '删除' } }),
  ]
}

function docList(kind: Kind, items: SiteDoc[], describe: (doc: SiteDoc) => string, form?: (doc: SiteDoc) => Element[], empty?: string): Element {
  return {
    kind: 'list', empty: empty ?? `还没有${KIND_NAME[kind]}`,
    items: items.map(doc => ({ key: `${doc.layer}/${doc.id}`, title: doc.id, description: describe(doc), tag: fromPack(doc) ? `bsp 自带（${doc.layer}）` : undefined, actions: docActions(kind, doc, form) })),
  }
}

function sourceForm(): Element[] {
  return [
    text('站点可以就在这台 boardd 里管，也可以跟着一个 git 仓库（用 boardd 的密钥、再用这台机器的 ssh 设置去取）。仓库里可以放整个实验室的配置，只有 sdk/、socs/、hooks/ 发给主机。'),
    {
      kind: 'form',
      fields: [
        { kind: 'choice', id: 'source', label: '来源', options: [{ value: 'managed', label: '这台 boardd 管理' }, { value: 'git', label: 'git 仓库' }], initial: site?.source ?? 'managed' },
        { kind: 'text', id: 'url', label: 'git 地址', initial: site?.url ?? '', placeholder: 'git@git.example.test:lab/bsp-site.git' },
        { kind: 'text', id: 'branch', label: '分支', initial: site?.branch ?? 'main' },
        { kind: 'switch', id: 'discard', label: '丢掉这里的改动', initial: false, help: '这里的站点有新来源里没有的提交或改动时，不勾就不换（它们会留在一个本地分支里）' },
      ],
      submitLabel: '换来源',
      submit: action('set-source', '换来源', input => change('api/bsp/site/source', input, out => out.message ?? '换好了'), { intent: 'primary' }),
    },
  ]
}

/** The site as text for an AI assistant: where it is from, its servers and SDKs (their YAML), what else it has. */
function siteContext(s: SiteStatus): string {
  const yaml = (kind: Kind) => docs(kind).filter(doc => !fromPack(doc)).map(doc => `# ${doc.file}\n${doc.text.trim()}`).join('\n---\n')
  const out = [
    `来源：${s.source === 'git' ? `git ${s.url} 分支 ${s.branch}` : '这台 boardd 管理'}；版本 ${s.revision ?? '还没有'}`,
    `编译方式：${docs('families').map(doc => doc.id + (fromPack(doc) ? '（bsp 自带）' : '')).join('、') || '无'}`,
    `源码树：${docs('workspaces').map(doc => doc.id).join('、') || '无'}`,
    `SoC 资料：${[...new Set(s.socs.map(item => item.soc))].join('、') || '无'}`,
    ...(s.skills?.length ? [`SDK skill：${s.skills.map(skill => skill.id).join('、')}`] : []),
    ...(s.problems.length ? [`问题：${s.problems.join('；')}`] : []),
    ...(s.images?.missing.length ? [`缺的镜像：${s.images.missing.join('、')}`] : []),
    '', '编译服务器：', yaml('servers') || '（还没有）', '', 'SDK：', yaml('instances') || '（还没有）',
  ].join('\n')
  return out.length > 16_000 ? `${out.slice(0, 16_000)}\n…（太长，后面省略了）` : out
}

function serverGroup(server: SiteDoc, sdks: SiteDoc[], sdkText: (doc: SiteDoc, server?: boolean) => string): Element {
  const mine = sdks.filter(doc => !doc.fields.workspace && doc.fields.server === server.id)
  return {
    kind: 'group', title: server.id, status: { tone: 'neutral', text: `${mine.length} 个 SDK` }, help: 'sdk-instances', body: [
      text([{ code: `${server.fields.user ?? '?'}@${server.fields.host ?? '?'}` }, ...(server.fields.description ? [` · ${server.fields.description}`] : []), ...(fromPack(server) ? [{ muted: ` · bsp 自带（${server.layer}）` }] : [])]),
      docList('instances', mine, doc => sdkText(doc, false), doc => sdkForm(doc), '这台服务器上还没有 SDK'),
      { kind: 'actions', actions: [
        open(`add-sdk-${server.id}`, '添加 SDK', `在 ${server.id} 上添加 SDK`, () => sdkForm(null, { server: server.id }), { intent: 'primary' }),
        ...docActions('servers', server, serverForm).map(op => ({ ...op, label: `${op.label}服务器` })),
      ] },
    ],
  }
}

function advanced(s: SiteStatus): Element {
  const own = s.docs.filter(doc => !fromPack(doc))
  return {
    kind: 'group', title: '高级', body: [
      { kind: 'group', title: '编译方式', help: 'sdk-families', body: [
        docList('families', docs('families'), doc => [doc.fields.runner ? `用 ${doc.fields.runner}` : '', doc.fields.description ?? ''].filter(Boolean).join(' · ')),
        { kind: 'actions', actions: [open('add-family', '添加编译方式', '添加编译方式', () => yamlForm('families', null))] },
      ] },
      { kind: 'group', title: '源码树', help: 'sdk-families', body: [
        docList('workspaces', docs('workspaces'), doc => `${doc.fields.server ?? '?'}:${doc.fields.path ?? '?'}`),
        { kind: 'actions', actions: [open('add-workspace', '添加源码树', '添加源码树', () => yamlForm('workspaces', null))] },
      ] },
      { kind: 'group', title: 'SoC 资料', help: 'soc-profiles', body: [
        text('在站点的 socs/<soc>/ 里改：站点放在 git 仓库里时，在仓库里改、提交，再拉取。'),
        { kind: 'list', empty: '没有 SoC 资料', items: s.socs.map(item => ({ key: `${item.layer}/${item.soc}`, title: item.soc, description: item.layer === 'site' ? `站点的 socs/${item.soc}` : `bsp 自带（${item.layer}）` })) },
      ] },
      { kind: 'group', title: 'SDK skill', body: [
        text('SDK 可以带自己的 SKILL.md（站点的 skills/<id>.md，或 bsp 自带平台里的 skills/<id>.md）：agent 在那个 SDK 的仓库里工作时，用 boardlab sdk skill <id> 打印，或 --install 装到 .claude/skills/<id>/SKILL.md。'),
        { kind: 'list', empty: '还没有 SDK skill', items: (s.skills ?? []).map(skill => ({ key: `${skill.layer}/${skill.id}`, title: skill.id, description: `${skill.file}${skill.title !== skill.id ? ` · ${skill.title}` : ''}`, tag: skill.layer === 'site' ? undefined : `bsp 自带（${skill.layer}）` })) },
      ] },
      { kind: 'group', title: '编辑原文', body: [
        text('站点里的每个文档都可以直接改 YAML，和 boardlab site set 一样：写进去前先检查，主机读不进去的改动不写。'),
        { kind: 'details', summary: `站点里的文档（${own.length} 个）`, load: async () => [{
          kind: 'list', empty: '站点里还没有文档', items: own.map(doc => ({
            key: `${doc.kind}/${doc.id}`, title: doc.file, tag: KIND_NAME[doc.kind], description: `boardlab site set ${KIND_CLI[doc.kind]} ${doc.id} --file <文件>`,
            actions: [open('raw', '编辑', `${KIND_NAME[doc.kind]} ${doc.id} 的原文`, () => yamlForm(doc.kind, doc))],
          })),
        }] },
        { kind: 'actions', actions: [open('add-raw', '用 YAML 添加', '用 YAML 添加文档', () => yamlForm(null, null))] },
      ] },
    ],
  }
}

function siteView(labs: LabSettings[]): View {
  if (Date.now() - loadedAt > 20_000) void loadSite()
  const s = site
  const sdkText = (doc: SiteDoc, server = true) => [
    doc.fields.workspace ? `源码树 ${doc.fields.workspace}` : server ? `${doc.fields.server ?? '?'}:${doc.fields.path ?? '?'}` : doc.fields.path ?? '?',
    doc.fields.soc ? `SoC ${doc.fields.soc}` : '', doc.fields.family ? `编译 ${doc.fields.family}` : '',
    `内存启动 ${doc.fields.load ?? '?'} / 刷机 ${doc.fields.download ?? '?'}`, doc.fields.description ?? ''].filter(Boolean).join(' · ')
  const behind = s ? labs.filter(lab => s.hosts[lab.id]?.revision !== s.revision) : []
  const servers = docs('servers'), sdks = docs('instances')
  const loose = sdks.filter(doc => doc.fields.workspace || !servers.some(server => server.id === doc.fields.server))
  const optional = s?.images?.optional ?? []
  return {
    id: 'bsp-site', slot: 'settings', title: 'SDK 与站点', help: 'site', order: 20,
    summary: 'SDK 在哪、怎么刷，同步到每台板卡主机。',
    // The guidance levels are read from this site; the help says how an agent asks for them.
    extra: { 'bsp.guidanceHelp': 'guidance' },
    hint: {
      commands: ['boardlab site show', 'boardlab site set server <id> --file <yaml>', 'boardlab site set sdk <id> --file <yaml>', 'boardlab site remove <sdk|server|family|workspace> <id>', 'boardlab site sync', 'boardlab sdk plan <sdk> --boot load|download'],
      context: () => s ? siteContext(s) : '（站点还没读到）',
      produce: '要放进站点的 YAML（编译服务器、SDK 和它的启动、刷机步骤），以及把它们放进去的 boardlab site set 命令',
    },
    status: !s ? undefined : s.problems.length ? { tone: 'warn', text: `${s.problems.length} 个问题` } : { tone: behind.length ? 'warn' : 'ok', text: s.revision ?? '空' },
    body: !s ? [siteError ? notice(`读不到站点：${siteError}`) : text('读取中…')] : [
      text('站点是每台 bsp 板卡主机都读的配置：SDK、编译服务器和 SoC 资料。在这里改，再同步到主机。'),
      {
        kind: 'facts', items: [
          { label: '来源', value: s.source === 'git' ? ['git: ', { code: s.url }, ' 分支 ', { code: s.branch }] : '这台 boardd 管理（还没连 git 仓库）' },
          { label: '版本', value: s.revision ? [{ code: s.revision }, ...(s.commit ? [` · ${s.commit.subject} · `, { time: s.commit.at }] : [])] : '还没有' },
          ...(s.source === 'git' ? [{ label: '没推送的提交', value: String(s.ahead), tone: s.ahead ? 'warn' as const : undefined }] : []),
          { label: '主机', value: labs.length ? `${labs.length - behind.length}/${labs.length} 台是这个版本` : '还没有' },
          { label: '镜像', value: s.images?.message ?? '还没取（拉取或同步时取）', tone: s.images && !s.images.ok ? 'warn' as const : undefined },
        ],
      },
      ...s.problems.map(problem => notice(problem)),
      // Images not there do not stop a sync; the hosts then lack them, so say which.
      ...(s.images?.failed ?? []).slice(0, 8).map(item => notice(`镜像 ${item.image} 没取到：${item.error}`)),
      ...(s.images?.missing ?? []).slice(0, 8).map(name => notice(`镜像 ${name} 有启动步骤要用，却哪儿都没有：放进站点的 socs/<soc>/，或在 soc.yaml 里写上 sha256 和 source`)),
      ...(optional.length ? [{
        kind: 'details' as const, summary: `可选：${optional.slice(0, 2).join('、')}${optional.length > 2 ? ` 等 ${optional.length} 个` : ''}探测用镜像没有，发现板子时就读不到型号`,
        load: async (): Promise<Element[]> => [
          text('这些镜像只在发现板子时用来读出型号和序列号，没有也能同步、启动和刷机。要补上：把文件放进站点的 socs/<soc>/（文件名照括号里的），或者在站点的 socs/<soc>/soc.yaml 里写上它的 sha256 和 source（git、url 或 file），boardd 同步前会去取。详见「SoC 资料」的帮助。'),
          { kind: 'list', items: optional.map(name => ({ key: name, title: name })) },
        ],
      }] : []),
      {
        kind: 'actions', actions: [
          job('sync', '同步到所有主机', async (_input, sink, signal) => { try { return (await stream('api/bsp/site/sync', {}, sink, signal)).message } finally { await loadSite() } }, {
            intent: 'primary', blocked: !labs.length ? '还没有 bsp 主机' : s.syncing ? '正在同步' : s.problems.length ? '站点有问题，先改好' : undefined,
          }),
          action('pull', '拉取', () => change('api/bsp/site/pull', {}, out => out.message ?? '拉好了'), { blocked: s.source !== 'git' ? '站点由这台 boardd 管理' : undefined }),
          ...(s.source === 'git' ? [action('push', '推送', () => change('api/bsp/site/push', {}, out => out.message ?? '推送了'), { blocked: s.ahead ? undefined : '没有要推送的' })] : []),
          open('source', '换来源', '站点的来源', sourceForm),
        ],
      },
      {
        kind: 'group', title: '编译服务器', help: 'sdk-servers', body: [
          ...(servers.length ? [] : [text('还没有编译服务器。先添加一台，再在它下面添加 SDK。')]),
          ...servers.map(server => serverGroup(server, sdks, sdkText)),
          ...(loose.length ? [{ kind: 'group' as const, title: '用源码树或别的服务器的 SDK', help: 'sdk-instances', body: [docList('instances', loose, doc => sdkText(doc), doc => sdkForm(doc))] }] : []),
          { kind: 'actions', actions: [open('add-server', '添加编译服务器', '添加编译服务器', () => serverForm(null)), open('add-sdk', '添加 SDK', '添加 SDK', () => sdkForm(null))] },
        ],
      },
      advanced(s),
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
      const home = bspBoard ? labs.find(lab => lab.id === board.lab!.id) : undefined
      if (!bspBoard) return []
      // A board its host can debug carries the debug block: the path is asked for once, then kept.
      if (hasDebug(board)) void readDebug(board.name)
      return [{
        id: 'bsp-board', slot: 'board', title: 'bsp 登记',
        body: [
          { kind: 'actions', actions: [openBoardForm(board.name)] },
          // The host's own page: its GPIO header, lines and events, opened on the host itself.
          ...(home?.url ? [text([{ link: 'GPIO 面板', href: gpioLink(home.url, home.id) }])] : []),
          ...debugView(board),
        ],
      }]
    }
    return [{
      id: 'bsp-hosts', slot: 'settings', title: 'bsp 板卡主机', help: 'board-hosts', order: 10,
      summary: '接着板子的机器（也可以就是这台）：给地址和登录方式，boardd 过去装好。',
      status: labs.length ? { tone: labs.every(lab => lab.enabled && lab.verifyOk !== false) ? 'ok' : 'warn', text: `${labs.length} 台` } : undefined,
      body: [
        text('接着板子的机器。每台装上 bspd，就是一个实验室：它的复位线、串口和下载口由 boardd 管，锁和排队在这里。'),
        ...(labs.length ? [{
          kind: 'list' as const,
          items: labs.map(lab => ({
            key: lab.id, title: lab.id,
            description: [[lab.url?.replace(/^bspd\+/, '') ?? '还没装', lab.verifyMessage ? ` · ${lab.verifyMessage}` : '', hostSite(lab.id)].join(''),
              // The host's own page (GPIO header, lines, events), through boardd, which adds the token.
              ...(lab.enabled && lab.url ? [' · ', { link: 'GPIO 面板', href: gpioLink(lab.url, lab.id) }] : [])],
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

// ---- debug: what can debug a board, and its session ----


interface DebugPath {
  provider: string, title?: string, about?: string, kinds: string[], running: boolean,
  endpoint?: string | null, state?: Array<{ label: string, value: string }>,
}

const paths = new Map<string, DebugPath | null>()
const asking = new Map<string, Promise<DebugPath | null>>()

/** The board's debug path as its host reported it last, or null (no path, or not asked yet). */
export function debugPath(board: string): DebugPath | null { return paths.get(board) ?? null }
export function hasDebug(board: Board): boolean { return !!board.lab?.debug }

export function readDebug(board: string, refresh = false): Promise<DebugPath | null> {
  if (!refresh && paths.has(board)) return Promise.resolve(paths.get(board) ?? null)
  const pending = asking.get(board)
  if (pending) return pending
  const ask = call<{ debug: DebugPath | null }>('POST', 'api/debug', { board, action: 'path' })
    .then(got => { const path = got?.debug ?? null; paths.set(board, path); return path })
    .catch(() => { paths.set(board, null); return null })
    .finally(() => { if (asking.get(board) === ask) asking.delete(board) })
  asking.set(board, ask)
  return ask
}

const KINDS: Record<string, { label: string, intent?: 'default' | 'danger' }> = {
  halt: { label: '暂停' }, run: { label: '继续' }, reset: { label: '复位（调试口）' }, step: { label: '单步' },
  regs: { label: '寄存器' },
}

function runAction(board: string, kind: string) {
  return action(`debug-${kind}`, KINDS[kind]?.label ?? kind, async () => {
    const got = await call<{ debug: { message?: string, data?: Array<{ label: string, value: string }> } }>('POST', 'api/debug', { board, action: kind })
    paths.delete(board)
    const data = got.debug?.data ?? []
    return { message: got.debug?.message ?? `${kind} 已完成`, data }
  }, { intent: KINDS[kind]?.intent })
}

/** A session's trace, shown as it arrives: lines are what the channel prints, in order. */
function trace(board: string): Element {
  return {
    kind: 'live',
    height: 'large',
    stream: {
      id: `bsp-debug-${board}`,
      open(sink) {
        const source = new EventSource(`api/debug/stream?board=${encodeURIComponent(board)}`)
        let pending = ''
        source.onmessage = event => {
          let bytes: Uint8Array
          try { bytes = Uint8Array.from(atob(event.data), char => char.charCodeAt(0)) } catch { return }
          pending += new TextDecoder().decode(bytes, { stream: true })
          const lines = pending.split(/\r?\n/)
          pending = lines.pop() ?? ''
          for (const line of lines) sink.line(line)
        }
        return () => { if (pending) sink.line(pending); source.close() }
      },
    },
  }
}

/** The board slot's debug block, once its path is known. */
export function debugView(board: Board): Element[] {
  const path = debugPath(board.name)
  if (!path) return []
  const kinds = path.kinds.filter(kind => kind in KINDS)
  return [
    {
      kind: 'group', title: `调试（${path.title ?? path.provider}）`, help: 'debug',
      status: path.running ? { tone: 'ok', text: '会话在跑' } : { tone: 'neutral', text: '未启动' },
      body: [
        ...(path.about ? [text(path.about, 'neutral')] : []),
        ...(path.state?.length ? [{ kind: 'facts' as const, items: path.state.map(item => ({ label: item.label, value: item.value })) }] : []),
        {
          kind: 'actions',
          actions: path.running
            ? [
                action('debug-stop', '停止调试会话', async () => {
                  const got = await call<{ debug: { message: string } }>('POST', 'api/debug', { board: board.name, action: 'stop' })
                  paths.delete(board.name)
                  return got.debug.message
                }),
                ...kinds.map(kind => runAction(board.name, kind)),
              ]
            : [job('debug-start', '启动调试会话', async (_input, sink) => {
                sink.line('让主机把调试口交给这块板子…')
                const got = await call<{ debug: DebugPath }>('POST', 'api/debug', { board: board.name, action: 'start' })
                paths.delete(board.name)
                return `调试会话起来了${got.debug?.endpoint ? `：${got.debug.endpoint}` : ''}（跟着板子的锁，板子一释放就停）`
              }, { intent: 'primary' })],
        },
        ...(path.running && path.kinds.includes('trace') ? [trace(board.name)] : []),
      ],
    },
  ]
}
