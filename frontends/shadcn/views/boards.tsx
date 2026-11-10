/**
 * The boards page: the list and the chosen board's workspace side by side, with the console, the log (search,
 * download, wget) and the board's history in tabs. ↑↓ or j/k move through the list; / searches.
 */
import { Code2, Eye, EyeOff, FileText, History, Lock, MoreHorizontal, Power, RotateCw, Search, Unlock, Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { api, type PageState } from '../../../src/ui/api.ts'
import { SerialConsole, STATUS_TEXT, type ConsoleStatus } from '../../../src/ui/console.tsx'
import { ACTIONS, ago, MODE, PURPOSES, stamp, who } from '../../../src/ui/format.ts'
import { onPrefs, prefs } from '../../../src/ui/notify.ts'
import type { Board, BoardDetail } from 'boardlab-core/shared/types.ts'
import { Badge, Button, Dialog, Input, Kbd, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, NativeSelect, Status, Table, Tabs, TabsContent, TabsList, TabsTrigger, TBody, TD, TH, THead, TR, Tip, cn } from '../ui/index.tsx'
import { LogPanel } from './logs.tsx'

type Filter = 'all' | 'free' | 'mine' | 'busy'
type Tone = 'ok' | 'warn' | 'info' | 'destructive' | 'muted'

export function boardState(board: Board, you: string): { tone: Tone, text: string } {
  if (board.lab?.empty) return { tone: 'muted', text: '空槽位' }
  if (board.lab?.slotGone) return { tone: 'destructive', text: '串口不见了' }
  if (board.lab?.attention) return { tone: 'warn', text: '等人操作' }
  if (board.lease?.holder === you) return { tone: 'info', text: '你在使用' }
  if (board.lease) return { tone: 'warn', text: `${who(board.lease.holder)} 在用` }
  if (board.lab?.heldBy) return { tone: 'warn', text: '实验室占用' }
  return { tone: 'ok', text: '空闲' }
}
const where = (board: Board) => board.lab ? (board.slotRef?.split('/').slice(1).join('/') ?? board.lab.device) : board.slot !== null ? `槽位 ${board.slot}` : '—'

/** Board actions: each runs with a toast, the board's own button spinning while it waits. */
function useActions() {
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (key: string, label: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    const id = toast.loading(`${label}…`)
    try { await fn(); toast.success(`${label}：完成`, { id }) } catch (error) { toast.error((error as Error).message, { id }) } finally { setBusy(null) }
  }
  return { busy, run }
}

function LockDialog({ board, queue, onClose }: { board: Board, queue: boolean, onClose: () => void }) {
  const [purpose, setPurpose] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!purpose.trim()) return
    setBusy(true)
    try {
      if (queue) { await api.queue(board.name, purpose.trim()); toast.success(`已排队 ${board.name}`) } else { await api.lock(board.name, purpose.trim()); toast.success(`已拿到 ${board.name} 的锁`) }
      onClose()
    } catch (error) { toast.error((error as Error).message) } finally { setBusy(false) }
  }
  return (
    <Dialog open onOpenChange={open => !open && onClose()} title={queue ? `排队 ${board.name}` : `拿 ${board.name} 的锁`}
      description={queue && board.lease ? `现在由 ${who(board.lease.holder)} 使用（${board.lease.purpose}）。轮到你时会自动把锁交给你。` : '锁没有时间限制，用完请放锁；有人排队时会自动交给排在第一位的人。'}
      footer={<><Button variant="outline" size="sm" onClick={onClose}>取消</Button><Button size="sm" loading={busy} disabled={!purpose.trim()} onClick={() => void submit()}>{queue ? '排队' : '拿锁'}</Button></>}>
      <form className="grid gap-2" onSubmit={event => { event.preventDefault(); void submit() }}>
        <Input autoFocus placeholder="用途，例如：调试 U-Boot 网络" value={purpose} onChange={event => setPurpose(event.target.value)} />
        <div className="flex flex-wrap gap-1.5">{PURPOSES.map(item => (
          <button key={item} type="button" onClick={() => setPurpose(item)} className={cn('rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-accent', purpose === item && 'border-foreground bg-foreground text-background hover:bg-foreground')}>{item}</button>
        ))}</div>
      </form>
    </Dialog>
  )
}

function Workspace({ state, board, dark }: { state: PageState, board: Board, dark: boolean }) {
  const actions = useActions()
  const [detail, setDetail] = useState<BoardDetail | null>(null)
  const [status, setStatus] = useState<ConsoleStatus>('connecting')
  const [die, setDie] = useState<string | undefined>()
  const [dialog, setDialog] = useState<'lock' | 'queue' | 'steal' | 'reset' | 'fastboot' | null>(null)
  const [reason, setReason] = useState('')
  const [watched, setWatched] = useState(prefs.get().watched.includes(board.name))
  useEffect(() => onPrefs(next => setWatched(next.watched.includes(board.name))), [board.name])
  useEffect(() => { void api.board(board.name).then(setDetail).catch(() => {}) }, [board.name, board.lease?.id, board.mode])
  const you = state.you, mine = board.lease?.holder === you, s = boardState(board, you), vacant = !!board.lab?.empty
  const dies = board.chips.filter(chip => chip.online || board.lab)
  const chosen = die ?? dies[0]?.die
  const place = board.waiters.findIndex(waiter => waiter.holder === you)
  const facts: Array<[string, string]> = [
    ['型号', vacant ? '—' : board.product ?? '未知'], ['SoC', board.soc?.toUpperCase() ?? '—'], ['模式', MODE[board.mode]],
    ['使用者', board.lease ? `${who(board.lease.holder)} · ${board.lease.purpose}` : '—'], ['排队', board.waiters.length ? board.waiters.map(waiter => who(waiter.holder)).join('、') : '—'],
    ['复位', board.lab?.mediaBoot ? (board.lab.mediaBoot.method === 'reset' ? '从介质启动' : board.lab.mediaBoot.available ? `经 ${board.lab.mediaBoot.method} 从介质启动` : '停在下载模式') : '—'],
    ['下载口', board.chips.map(chip => chip.downloadUsbPath).filter(Boolean).join('、') || '—'], ['自', board.lease ? ago(board.lease.startedAt) : '—'],
  ]
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{board.lab ? `实验室 ${board.lab.id}` : '本机'} · {board.slotRef ?? where(board)}</div>
          <div className="mt-0.5 flex items-center gap-2.5"><h2 className="truncate text-base font-semibold tracking-tight">{vacant ? `空槽位 ${where(board)}` : board.name}</h2><Status tone={s.tone}>{s.text}</Status></div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {mine ? <>
            <Button size="sm" variant="outline" loading={actions.busy === 'reset'} onClick={() => setDialog('reset')}><Power />复位</Button>
            <Button size="sm" variant="outline" loading={actions.busy === 'fastboot'} onClick={() => setDialog('fastboot')}><Zap />fastboot</Button>
            <Button size="sm" variant="secondary" onClick={() => void actions.run('unlock', board.waiters[0] ? `放锁并交给 ${who(board.waiters[0].holder)}` : '放锁', () => api.unlock(board.name))}><Unlock />{board.waiters[0] ? `放锁 → ${who(board.waiters[0].holder)}` : '放锁'}</Button>
          </> : !board.lease && !board.lab?.heldBy && !vacant ? <Button size="sm" onClick={() => setDialog('lock')}><Lock />拿锁</Button>
            : board.lease || board.lab?.heldBy ? (place >= 0
              ? <Button size="sm" variant="outline" onClick={() => void api.unqueue(board.name).then(() => toast.success('已退出排队'))}>排第 {place + 1} 位 · 退出</Button>
              : <Button size="sm" variant="outline" onClick={() => setDialog('queue')}>排队</Button>) : null}
          <Menu>
            <MenuTrigger asChild><Button size="icon" variant="ghost" aria-label="更多" className="h-7 w-7"><MoreHorizontal /></Button></MenuTrigger>
            <MenuContent>
              {mine && board.lab?.canRefresh && <MenuItem onSelect={() => void actions.run('refresh', '重新读取', () => api.refresh(board.name, {}))}><RotateCw />重新读取（换了板子）</MenuItem>}
              <MenuItem onSelect={() => prefs.watch(board.name, !watched)}>{watched ? <><EyeOff />不再关注</> : <><Eye />关注：空闲时通知我</>}</MenuItem>
              {board.lease && !mine && <><MenuSeparator /><MenuItem destructive onSelect={() => setDialog('steal')}>抢锁…</MenuItem></>}
            </MenuContent>
          </Menu>
        </div>
      </div>
      {(board.lab?.slotGone || board.lab?.attention || board.lab?.progress) && (
        <div className="grid gap-2 px-4 pt-3 text-[13px]">
          {board.lab?.slotGone && <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive">这块板的槽位串口不见了：串口线拔掉或换了口。最近重新布线过的话，到「发现」里重建主机 {board.slotRef?.split('/')[1]}。</div>}
          {board.lab?.attention && <div className="flex items-center justify-between gap-3 rounded-md border border-warn/40 bg-warn/5 px-3 py-2"><span>{board.lab.attention}</span>{board.lab.canConfirm && <Button size="sm" onClick={() => void api.confirm(board.name).then(() => toast.success('已告诉实验室'))}>我已完成</Button>}</div>}
          {board.lab?.progress && <div className="rounded-md bg-muted px-3 py-2">{board.lab.progress}</div>}
        </div>
      )}
      <dl className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-x-4 gap-y-2 border-b px-4 py-3">
        {facts.map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-[11px] text-muted-foreground">{label}</dt><dd className="truncate text-[13px]" title={value}>{value}</dd></div>)}
      </dl>
      <Tabs defaultValue="console" className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b pr-3">
          <TabsList className="border-b-0"><TabsTrigger value="console"><Code2 />串口</TabsTrigger><TabsTrigger value="logs"><FileText />日志</TabsTrigger><TabsTrigger value="history"><History />记录</TabsTrigger></TabsList>
          <div className="flex items-center gap-2.5">
            {board.lease && !mine && <Badge variant="warn">锁在 {who(board.lease.holder)} 手里</Badge>}
            <Status tone={status === 'live' ? 'ok' : status === 'retry' ? 'warn' : 'muted'}>{STATUS_TEXT[status]}</Status>
            {dies.length > 1 && <NativeSelect value={chosen} onChange={event => setDie(event.target.value)} className="h-7 text-xs">{dies.map(chip => <option key={chip.die} value={chip.die}>{chip.die}</option>)}</NativeSelect>}
          </div>
        </div>
        <TabsContent value="console" forceMount className="data-[state=inactive]:hidden">
          {dies.length || board.lab ? <SerialConsole key={`${board.name}:${chosen ?? ''}`} board={board.name} die={chosen} dark={dark} onStatus={setStatus} className="terminal" /> : <p className="p-8 text-center text-[13px] text-muted-foreground">没有在线的串口</p>}
        </TabsContent>
        <TabsContent value="logs"><LogPanel board={board.name} die={chosen} /></TabsContent>
        <TabsContent value="history" className="overflow-auto">
          {!detail?.actions.length ? <p className="p-8 text-center text-[13px] text-muted-foreground">还没有操作记录</p> : (
            <Table><TBody>{detail.actions.slice(0, 60).map(action => (
              <TR key={action.id}>
                <TD className="whitespace-nowrap font-mono text-[11px] tabular-nums text-muted-foreground">{stamp(action.at)}</TD>
                <TD><Badge variant={action.ok ? 'secondary' : 'destructive'}>{ACTIONS[action.kind] ?? action.kind}</Badge></TD>
                <TD className="whitespace-nowrap">{who(action.actor)}</TD>
                <TD className={action.ok ? 'text-muted-foreground' : 'text-destructive'}>{action.ok ? action.detail : action.message}</TD>
              </TR>
            ))}</TBody></Table>
          )}
        </TabsContent>
      </Tabs>
      {(dialog === 'lock' || dialog === 'queue') && <LockDialog board={board} queue={dialog === 'queue'} onClose={() => setDialog(null)} />}
      {(dialog === 'reset' || dialog === 'fastboot') && (
        <Dialog open onOpenChange={open => !open && setDialog(null)} title={dialog === 'reset' ? `复位 ${board.name}` : `${board.name} 进入 fastboot`}
          description={dialog === 'reset' ? '板子会立即重启。' : '板子会重启进入 boot ROM 下载模式。'}
          footer={<><Button variant="outline" size="sm" onClick={() => setDialog(null)}>取消</Button><Button size="sm" onClick={() => { const kind = dialog; setDialog(null); void actions.run(kind, kind === 'reset' ? `复位 ${board.name}` : `${board.name} 进入 fastboot`, () => kind === 'reset' ? api.reset(board.name) : api.fastboot(board.name)) }}>{dialog === 'reset' ? '复位' : '进入 fastboot'}</Button></>} />
      )}
      {dialog === 'steal' && (
        <Dialog open onOpenChange={open => !open && setDialog(null)} title={`抢 ${board.name} 的锁`} description={`当前由 ${who(board.lease?.holder ?? '')} 使用（${board.lease?.purpose}）。抢锁会记录下来，原使用者会收到通知。`}
          footer={<><Button variant="outline" size="sm" onClick={() => setDialog(null)}>取消</Button><Button size="sm" variant="destructive" disabled={!reason.trim()} onClick={() => { setDialog(null); void actions.run('steal', `抢锁 ${board.name}`, () => api.steal(board.name, reason.trim())) }}>抢锁</Button></>}>
          <Input autoFocus placeholder="写明为什么要抢" value={reason} onChange={event => setReason(event.target.value)} />
        </Dialog>
      )}
    </div>
  )
}

export function BoardsPage({ state, dark, selected, onSelect }: { state: PageState, dark: boolean, selected: string | null, onSelect: (board: string) => void }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const you = state.you
  const real = state.boards.filter(board => !board.lab?.empty)
  const counts = { all: real.length, free: real.filter(board => !board.lease && !board.lab?.heldBy).length, mine: real.filter(board => board.lease?.holder === you).length, busy: real.filter(board => board.lease && board.lease.holder !== you).length }
  const shown = useMemo(() => state.boards.filter(board => {
    if (filter === 'free' && (board.lease || board.lab?.heldBy || board.lab?.empty)) return false
    if (filter === 'mine' && board.lease?.holder !== you) return false
    if (filter === 'busy' && !(board.lease && board.lease.holder !== you)) return false
    const q = query.trim().toLowerCase()
    return !q || [board.name, board.product, board.soc, board.slotRef, board.lease?.holder, board.lab?.id].some(value => value?.toLowerCase().includes(q))
  }).sort((a, b) => Number(!!a.lab?.empty) - Number(!!b.lab?.empty) || a.name.localeCompare(b.name)), [state.boards, filter, query, you])
  const current = state.boards.find(board => board.name === selected) ?? shown[0] ?? null
  useEffect(() => { if (!selected && shown[0]) onSelect(shown[0].name) }, [selected, shown[0]?.name])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input, textarea, .xterm, [contenteditable]')) return
      const at = shown.findIndex(board => board.name === current?.name)
      if ((event.key === 'ArrowDown' || event.key === 'j') && at < shown.length - 1) { onSelect(shown[at + 1]!.name); event.preventDefault() }
      if ((event.key === 'ArrowUp' || event.key === 'k') && at > 0) { onSelect(shown[at - 1]!.name); event.preventDefault() }
      if (event.key === '/') { document.getElementById('board-search')?.focus(); event.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shown, current?.name])
  return (
    <div className="grid h-[calc(100vh-3rem-1.5rem)] min-h-[520px] grid-cols-1 gap-3 lg:grid-cols-[minmax(400px,1fr)_minmax(460px,1.15fr)]">
      <div className="flex min-h-0 flex-col gap-3">
        <div className="grid grid-cols-4 divide-x rounded-lg border bg-card">
          {([['板子', counts.all, ''], ['空闲', counts.free, 'text-ok'], ['我的', counts.mine, 'text-info'], ['别人在用', counts.busy, 'text-warn']] as const).map(([label, value, color]) => (
            <div key={label} className="px-4 py-2.5"><div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div><div className={cn('text-xl font-semibold tabular-nums tracking-tight', color)}>{value}</div></div>
          ))}
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card">
          <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
            <div className="inline-flex rounded-md bg-muted p-0.5">{([['all', '全部'], ['free', '空闲'], ['mine', '我的'], ['busy', '在用']] as const).map(([value, label]) => (
              <button key={value} onClick={() => setFilter(value)} className={cn('rounded px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors', filter === value && 'bg-background text-foreground shadow-sm')}>{label}</button>
            ))}</div>
            <div className="flex-1" />
            <div className="relative"><Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input id="board-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索" className="h-7 w-48 pl-8 pr-8 text-xs" />
              <span className="absolute right-1.5 top-1/2 -translate-y-1/2"><Kbd>/</Kbd></span></div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <THead><TR><TH>板子</TH><TH className="w-32">位置</TH><TH className="w-36">状态</TH><TH className="w-12 text-center">串口</TH></TR></THead>
              <TBody>{shown.map(board => {
                const st = boardState(board, you)
                return (
                  <TR key={board.name} data-state={board.name === current?.name ? 'selected' : undefined} onClick={() => onSelect(board.name)}
                    className={cn('cursor-pointer', board.name === current?.name && 'shadow-[inset_2px_0_0_hsl(var(--foreground))]', board.lab?.slotGone && 'opacity-50')}>
                    <TD className="max-w-0"><div className="truncate font-medium">{board.lab?.empty ? `空槽位 ${where(board)}` : board.name}</div><div className="truncate text-xs text-muted-foreground">{board.lab?.empty ? '只有串口' : [board.product ?? '型号未知', board.soc?.toUpperCase()].filter(Boolean).join(' · ')}</div></TD>
                    <TD className="truncate font-mono text-xs">{where(board)}</TD>
                    <TD><Status tone={st.tone}>{st.text}</Status>{board.lease && <div className="text-[11px] tabular-nums text-muted-foreground">{ago(board.lease.startedAt)}{board.waiters.length ? ` · 排队 ${board.waiters.length}` : ''}</div>}</TD>
                    <TD className="text-center"><Tip text={board.chips.some(chip => chip.online) ? '串口在线' : '串口离线'}><span className={cn('inline-block size-1.5 rounded-full', board.chips.some(chip => chip.online) ? 'bg-ok' : 'bg-muted-foreground/40')} /></Tip></TD>
                  </TR>
                )
              })}</TBody>
            </Table>
          </div>
        </div>
      </div>
      <div className="flex min-h-0 flex-col">{current ? <Workspace key={current.name} state={state} board={current} dark={dark} /> : <div className="grid flex-1 place-items-center rounded-lg border text-[13px] text-muted-foreground">选一块板子</div>}</div>
    </div>
  )
}
