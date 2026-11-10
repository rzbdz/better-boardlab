/** Discover, settings and history, in shadcn components. */
import { Bell, Monitor, Moon, Palette, RotateCw, Search, Sun, UserRound } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { api, frontends, type FrontendList, type History, type PageState } from '../../../src/ui/api.ts'
import { ACTIONS, ago, stamp, who } from '../../../src/ui/format.ts'
import { ask, onPrefs, permission, prefs, support, TOPICS, type Topic } from '../../../src/ui/notify.ts'
import type { LabSettings, Proposal } from 'boardlab-core/shared/types.ts'
import { ViewCard, viewsFor } from '../render.tsx'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Dialog, Input, Label, NativeSelect, Switch, Table, TBody, TD, TH, THead, TR, cn } from '../ui/index.tsx'

export type Mode = 'system' | 'light' | 'dark'

// ---------- discover ----------

const KIND: Record<Proposal['kind'], string> = { 'new-board': '新板', 'replace-board': '换板', 'serial-moved': '串口', 'download-moved': '下载口', 'product-changed': '型号', 'slot-empty': '空槽位' }

function Confirm({ title, body, action, danger, onConfirm, onClose }: { title: string, body: string, action: string, danger?: boolean, onConfirm: () => void, onClose: () => void }) {
  return <Dialog open onOpenChange={open => !open && onClose()} title={title} description={body}
    footer={<><Button size="sm" variant="outline" onClick={onClose}>取消</Button><Button size="sm" variant={danger ? 'destructive' : 'default'} onClick={() => { onConfirm(); onClose() }}>{action}</Button></>} />
}

function LabCard({ lab, state }: { lab: LabSettings, state: PageState }) {
  const [host, setHost] = useState(lab.hosts[0] ?? '')
  const [asking, setAsking] = useState<null | 'discover' | 'rebuild' | 'human'>(null)
  const running = !!lab.discovery?.running
  const held = state.boards.filter(board => board.lab?.id === lab.id && (board.lease || board.lab.heldBy))
  const onHost = state.boards.filter(board => board.lab?.id === lab.id && board.slotRef?.startsWith(`${lab.id}/${host}/`))
  const heldOnHost = onHost.filter(board => board.lease || board.lab?.heldBy)
  const fire = (promise: Promise<unknown>) => void promise.catch(error => toast.error((error as Error).message))
  const modes = [
    { key: 'discover' as const, icon: <Search />, title: '发现新板子', body: '逐个拉还没用过的复位线，看哪个串口有反应、哪个下载口出现。会复位接在这些线上的板子。', host: false, blocked: held.length > 0 },
    ...(lab.canRebuild ? [{ key: 'rebuild' as const, icon: <RotateCw />, title: '重新布线以后：重建主机', body: '忘掉这台主机发现过的板子和槽位，按现在的接线重新发现。以前用过的复位线先试，找到的板子沿用原名。', host: true, blocked: heldOnHost.length > 0 }] : []),
    { key: 'human' as const, icon: <UserRound />, title: '人工复位的板子', body: '没接复位线的板子：开始后按提示一次让一块进下载模式，实验室把串口和下载口配成一对。不会复位别的板子，有人在用板子时也能用。', host: true, blocked: false },
  ]
  return (
    <Card>
      <CardHeader><CardTitle>实验室 {lab.id}</CardTitle>{running ? <Badge variant="info">进行中</Badge> : null}</CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-[13px] text-muted-foreground">{lab.kind}。找到的板子马上登记；没能自动登记的列为改动建议。</p>
        {lab.discovery && <div className="rounded-md bg-muted px-3 py-2 text-[13px]"><span className="text-muted-foreground">{running ? '进行中 · ' : '上次 · '}</span>{lab.discovery.line} <span className="text-muted-foreground">· {ago(lab.discovery.at)}</span></div>}
        <div className="grid gap-3 md:grid-cols-3">
          {modes.map(mode => (
            <div key={mode.key} className="flex flex-col gap-2 rounded-md border p-3">
              <div className="flex items-center gap-2 text-[13px] font-medium [&_svg]:size-3.5">{mode.icon}{mode.title}</div>
              <p className="flex-1 text-xs leading-relaxed text-muted-foreground">{mode.body}</p>
              <div className="flex gap-2">
                {mode.host && <NativeSelect value={host} onChange={event => setHost(event.target.value)} className="h-7 flex-1 text-xs" aria-label="主机">{lab.hosts.map(item => <option key={item}>{item}</option>)}</NativeSelect>}
                <Button size="sm" variant={mode.key === 'rebuild' ? 'destructive' : mode.key === 'discover' ? 'default' : 'outline'} className={mode.host ? '' : 'w-full'} disabled={running || mode.blocked || (mode.host && !host)} onClick={() => setAsking(mode.key)}>
                  {mode.key === 'rebuild' ? '重建' : '开始'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
      {asking === 'discover' && <Confirm title={`在实验室 ${lab.id} 发现板子`} body="逐个拉还没用过的复位线、看串口和 USB，会复位接在这些线上的板子。" action="开始发现" danger onConfirm={() => fire(api.discoverLab(lab.id))} onClose={() => setAsking(null)} />}
      {asking === 'rebuild' && <Confirm title={`重建 ${host}`} body={`会忘掉 ${host} 上的 ${onHost.filter(board => !board.lab?.empty).map(board => board.name).join('、') || '（没有登记的板子）'} 和它的所有槽位，按现在的接线重新发现，会复位接在复位线上的所有板子。`} action="重建" danger onConfirm={() => fire(api.rebuildLab(lab.id, host))} onClose={() => setAsking(null)} />}
      {asking === 'human' && <Confirm title={`在 ${host} 上人工发现板子`} body="按页面上的提示，一次只让一块还没登记的板子进下载模式。" action="开始" onConfirm={() => fire(api.discoverLab(lab.id, { human: true, host }))} onClose={() => setAsking(null)} />}
    </Card>
  )
}

function Proposals({ proposals }: { proposals: Proposal[] }) {
  const [names, setNames] = useState<Record<string, string>>({})
  if (!proposals.length) return null
  const decide = (ids: string[], decision: 'apply' | 'reject') => void api.proposals(ids, decision, decision === 'apply' ? names : undefined).then(() => toast.success(decision === 'apply' ? '已应用' : '已拒绝'), error => toast.error((error as Error).message))
  return (
    <Card>
      <CardHeader><CardTitle>改动建议 · {proposals.length}</CardTitle><div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => decide(proposals.map(item => item.id), 'reject')}>全部拒绝</Button><Button size="sm" onClick={() => decide(proposals.map(item => item.id), 'apply')}>全部应用</Button></div></CardHeader>
      <ul className="divide-y">{proposals.map(item => (
        <li key={item.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
          <Badge variant="info">{KIND[item.kind]}</Badge>
          <span className="min-w-0 flex-1 text-[13px]">{item.summary}</span>
          {(item.kind === 'new-board' || !!item.change.lab) && <Input className="h-7 w-48 text-xs" placeholder={item.change.name ? String(item.change.name) : '板名'} value={names[item.id] ?? ''} onChange={event => setNames({ ...names, [item.id]: event.target.value })} />}
          <Button size="sm" variant="outline" onClick={() => decide([item.id], 'reject')}>拒绝</Button><Button size="sm" onClick={() => decide([item.id], 'apply')}>应用</Button>
        </li>
      ))}</ul>
    </Card>
  )
}

export function DiscoverPage({ state }: { state: PageState }) {
  const labs = state.labs.filter(lab => lab.enabled && lab.canDiscover)
  const scans = viewsFor(state, 'scan'), results = viewsFor(state, 'scan-result')
  return (
    <div className="grid gap-4">
      <Proposals proposals={state.proposals} />
      {labs.map(lab => <LabCard key={lab.id} lab={lab} state={state} />)}
      {(scans.length > 0 || results.length > 0) && <div className="grid gap-4 xl:grid-cols-2"><div className="grid content-start gap-4">{scans.map(view => <ViewCard key={view.id} view={view} />)}</div><div className="grid content-start gap-4">{results.map(view => <ViewCard key={view.id} view={view} />)}</div></div>}
      {!labs.length && !scans.length && !state.proposals.length && <p className="py-16 text-center text-[13px] text-muted-foreground">没有能发现板子的实验室或模块</p>}
    </div>
  )
}
export const canDiscover = (state: PageState) => state.labs.some(lab => lab.enabled && lab.canDiscover) || viewsFor(state, 'scan').length > 0 || state.proposals.length > 0

// ---------- settings ----------

function Appearance({ mode, onMode }: { mode: Mode, onMode: (mode: Mode) => void }) {
  const [list, setList] = useState<FrontendList | null>(null)
  useEffect(() => { void frontends.list().then(setList).catch(() => {}) }, [])
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Palette className="size-3.5" />外观</CardTitle></CardHeader>
      <CardContent className="grid gap-5">
        <div className="grid gap-2"><Label>主题</Label>
          <div className="inline-flex w-fit rounded-md bg-muted p-0.5">{([['system', '跟随系统', <Monitor key="m" />], ['light', '浅色', <Sun key="s" />], ['dark', '深色', <Moon key="d" />]] as const).map(([value, label, icon]) => (
            <button key={value} onClick={() => onMode(value)} className={cn('flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium text-muted-foreground [&_svg]:size-3.5', mode === value && 'bg-background text-foreground shadow-sm')}>{icon}{label}</button>
          ))}</div>
        </div>
        {list && list.frontends.length > 1 && (
          <div className="grid gap-2"><Label>界面</Label>
            <p className="text-xs text-muted-foreground">这个 boardd 给所有人提供的界面。换一个会刷新页面。</p>
            <div className="grid gap-2 sm:grid-cols-3">{list.frontends.map(item => (
              <button key={item.name} onClick={() => item.name !== list.current && void frontends.choose(item.name)}
                className={cn('flex items-center justify-between rounded-md border px-3 py-2 text-left text-[13px] transition-colors hover:bg-accent', item.name === list.current && 'border-foreground')}>
                <span className="font-medium">{item.title}</span>{item.name === list.current ? <Badge variant="default">当前</Badge> : item.name === list.default ? <Badge variant="outline">默认</Badge> : null}
              </button>
            ))}</div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Notifications() {
  const [p, setP] = useState(prefs.get())
  const [granted, setGranted] = useState(permission())
  useEffect(() => onPrefs(setP), [])
  const can = support()
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Bell className="size-3.5" />通知</CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-[13px] text-muted-foreground">打开后，这些事会出现在操作系统的通知中心；没打开时只在页面里提示。</p>
        {!can.ok ? <div className="rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-[13px]">这个页面不能发系统通知：{can.why}</div>
          : granted === 'granted' ? <div className="rounded-md bg-ok/10 px-3 py-2 text-[13px] text-ok">已开启系统通知</div>
          : <Button size="sm" className="w-fit" onClick={async () => setGranted(await ask())}>开启系统通知</Button>}
        <div className="grid gap-2">{(Object.keys(TOPICS) as Topic[]).map(topic => <label key={topic} className="flex items-center gap-2 text-[13px]"><Checkbox checked={p.enabled[topic]} onCheckedChange={on => prefs.topic(topic, on)} />{TOPICS[topic]}</label>)}</div>
        <p className="text-xs text-muted-foreground">关注的板子：{p.watched.length ? p.watched.join('、') : '还没有。在板子的「更多」里选「关注」。'}</p>
      </CardContent>
    </Card>
  )
}

function LabSettingsCard({ lab }: { lab: LabSettings }) {
  const [form, setForm] = useState({ enabled: lab.enabled, url: lab.url ?? '', username: lab.username ?? '', password: '', jump: lab.jump ?? '', devices: lab.devices ?? '' })
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try { const next = await api.configureLab({ id: lab.id, ...form, password: form.password || undefined }); setForm({ ...form, password: '' }); next.verifyOk === false ? toast.error(next.verifyMessage ?? '验证失败') : toast.success('已保存') }
    catch (error) { toast.error((error as Error).message) } finally { setSaving(false) }
  }
  const field = (key: 'url' | 'username' | 'password' | 'jump', type = 'text') => lab.fields[key] && (
    <div className="grid gap-1.5"><Label>{lab.fields[key]!.label}</Label><Input type={type} value={form[key]} placeholder={key === 'password' && lab.hasPassword ? '已保存（留空则不修改）' : key === 'jump' ? lab.defaultJump ?? lab.fields.jump?.placeholder ?? undefined : lab.fields[key]!.placeholder ?? undefined} onChange={event => setForm({ ...form, [key]: event.target.value })} /></div>
  )
  return (
    <Card>
      <CardHeader><CardTitle>实验室 {lab.id}</CardTitle>{lab.verifiedAt && <Badge variant={lab.verifyOk ? 'ok' : 'destructive'}>{lab.verifyOk ? '连接正常' : '连接失败'} · {ago(lab.verifiedAt)}</Badge>}</CardHeader>
      <CardContent className="grid max-w-2xl gap-3">
        <p className="text-[13px] text-muted-foreground">{lab.about || lab.kind}</p>
        <label className="flex items-center gap-2 text-[13px]"><Switch checked={form.enabled} onCheckedChange={enabled => setForm({ ...form, enabled })} />使用这个实验室</label>
        <div className="grid gap-3 sm:grid-cols-2">{field('url')}{field('username')}{field('password', 'password')}{field('jump')}</div>
        <div className="grid gap-1.5"><Label>只用这些板子</Label><Input value={form.devices} placeholder="设备名或带 * 的模式，空格分开；留空列出全部" onChange={event => setForm({ ...form, devices: event.target.value })} /></div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" loading={saving} onClick={() => void save()}>保存并验证</Button>
          <Button size="sm" variant="outline" onClick={() => void api.testLab(lab.id).then(next => next.verifyOk ? toast.success(next.verifyMessage ?? '连接正常') : toast.error(next.verifyMessage ?? '连接失败'), error => toast.error((error as Error).message))}>重新验证</Button>
          {lab.verifyMessage && <span className="text-xs text-muted-foreground">{lab.verifyMessage}</span>}
        </div>
      </CardContent>
    </Card>
  )
}

export function SettingsPage({ state, mode, onMode }: { state: PageState, mode: Mode, onMode: (mode: Mode) => void }) {
  return (
    <div className="grid max-w-5xl gap-4">
      <Appearance mode={mode} onMode={onMode} />
      <Notifications />
      {viewsFor(state, 'settings').map(view => <ViewCard key={view.id} view={view} />)}
      {state.labs.map(lab => <LabSettingsCard key={lab.id} lab={lab} />)}
      <Card>
        <CardHeader><CardTitle>自带固件</CardTitle></CardHeader>
        {state.firmware.length ? <Table><THead><TR><TH>SoC</TH><TH>名字</TH><TH>sha256</TH><TH>说明</TH></TR></THead><TBody>{state.firmware.map(item => (
          <TR key={`${item.soc}/${item.purpose}`}><TD><Badge variant="outline">{item.soc.toUpperCase()}</Badge></TD><TD>{item.purpose}</TD><TD className="font-mono text-xs text-muted-foreground">{item.sha256.slice(0, 16)}…</TD><TD className="text-muted-foreground">{item.note ?? '—'}</TD></TR>
        ))}</TBody></Table> : <CardContent><p className="text-[13px] text-muted-foreground">这个 boardlab 没有自带固件</p></CardContent>}
      </Card>
    </div>
  )
}

// ---------- history ----------

export function HistoryPage({ state, refreshKey }: { state: PageState, refreshKey: number }) {
  const [history, setHistory] = useState<History | null>(null)
  const [board, setBoard] = useState('')
  const [tab, setTab] = useState<'actions' | 'leases' | string>('actions')
  const [limit, setLimit] = useState(60)
  useEffect(() => { void api.history().then(setHistory).catch(() => {}) }, [refreshKey])
  const boards = useMemo(() => [...new Set((history?.actions ?? []).map(action => action.board).filter((name): name is string => !!name))].sort(), [history])
  const actions = (history?.actions ?? []).filter(action => !board || action.board === board)
  const moduleViews = history ? viewsFor({ ...state, history }, 'history') : []
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-4 border-b px-4">
        {[['actions', '操作记录'], ['leases', '锁记录'], ...moduleViews.map(view => [view.id, view.title ?? view.id])].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key!)} className={cn('-mb-px border-b-2 border-transparent py-2.5 text-[13px] font-medium text-muted-foreground', tab === key && 'border-foreground text-foreground')}>{label}</button>
        ))}
        <div className="flex-1" />
        {tab === 'actions' && <NativeSelect value={board} onChange={event => { setBoard(event.target.value); setLimit(60) }} className="h-7 text-xs"><option value="">全部板子</option>{boards.map(name => <option key={name}>{name}</option>)}</NativeSelect>}
      </div>
      {!history ? <p className="p-8 text-center text-[13px] text-muted-foreground">加载中…</p>
        : tab === 'actions' ? <>
          <Table><THead><TR><TH className="w-36">时间</TH><TH className="w-36">谁</TH><TH className="w-32">操作</TH><TH className="w-48">板子</TH><TH>详情</TH></TR></THead>
            <TBody>{actions.slice(0, limit).map(action => (
              <TR key={action.id}>
                <TD className="whitespace-nowrap font-mono text-[11px] tabular-nums text-muted-foreground">{stamp(action.at)}</TD><TD>{who(action.actor)}</TD>
                <TD><Badge variant={action.ok ? 'secondary' : 'destructive'}>{ACTIONS[action.kind] ?? action.kind}</Badge></TD><TD className="font-mono text-xs">{action.board ?? '—'}</TD>
                <TD className={action.ok ? 'text-muted-foreground' : 'text-destructive'}>{action.ok ? action.detail : `失败：${action.message}`}</TD>
              </TR>
            ))}</TBody></Table>
          {actions.length > limit && <div className="p-3 text-center"><Button size="sm" variant="ghost" onClick={() => setLimit(limit + 100)}>显示更多（还有 {actions.length - limit} 条）</Button></div>}
        </>
        : tab === 'leases' ? <Table><THead><TR><TH className="w-36">开始</TH><TH className="w-36">谁</TH><TH className="w-48">板子</TH><TH>用途</TH><TH className="w-40">状态</TH></TR></THead>
          <TBody>{history.leases.slice(0, 100).map(lease => (
            <TR key={lease.id}><TD className="font-mono text-[11px] tabular-nums text-muted-foreground">{stamp(lease.startedAt)}</TD><TD>{who(lease.holder)}</TD><TD className="font-mono text-xs">{lease.board}</TD><TD className="text-muted-foreground">{lease.purpose}</TD>
              <TD><Badge variant={lease.status === 'held' ? 'info' : lease.status === 'stolen' ? 'warn' : 'secondary'}>{{ held: '使用中', released: '已释放', stolen: '被抢' }[lease.status]}</Badge></TD></TR>
          ))}</TBody></Table>
        : <div className="p-4">{moduleViews.filter(view => view.id === tab).map(view => <ViewCard key={view.id} view={view} />)}</div>}
    </Card>
  )
}
