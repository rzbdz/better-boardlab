/** 开发板管理平台: board cards with locks and a FIFO queue, serial console, scan wizard, settings and history. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Action, Board, Chip, LabSettings, Lease, Proposal, Scan, ScanRow, Slot, State } from '../shared/types.ts'
import { api, identity } from './api.ts'

type Tab = 'boards' | 'scan' | 'settings' | 'history'
const TABS: Array<[Tab, string]> = [['boards', '板子'], ['scan', '扫描'], ['settings', '设置'], ['history', '历史']]

const pad = (n: number) => String(n).padStart(2, '0')
/** `10/29 09:40:05`, short enough to stay on one line. */
function time(iso: string | null, withDate = true) {
  if (!iso) return '—'
  const d = new Date(iso)
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return withDate ? `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${clock}` : clock
}
/** `/dev/serial/by-path/pci-…-usb-0:6.4.2:1.0-port0` → `USB 6.4.2`. */
function shortLink(link: string) {
  const port = link.match(/-usb-\d+:([\d.]+):/)?.[1]
  return port ? `USB ${port}` : link.split('/').at(-1)!
}
const shortenLinks = (text: string) => text.replace(/\/dev\/serial\/by-path\/\S+/g, link => shortLink(link))
/** `user:troy` → `troy`; other holder kinds keep their prefix so agents stay recognisable. */
const who = (holder: string) => holder.startsWith('user:') ? holder.slice(5) : holder

const ACTIONS: Record<string, string> = {
  lock: '拿锁', unlock: '放锁', queue: '排队', unqueue: '退出排队', steal: '抢锁', reset: '复位', fastboot: '进入 fastboot',
  send: '串口输入', stage: '加载镜像', boot: '内存启动', scan: '开始扫描', 'scan-end': '扫描结束',
  'scan-cancel': '取消扫描', 'proposal-apply': '应用建议', 'proposal-reject': '拒绝建议', 'ha-config': '配置 HA', 'ha-test': '验证 HA',
  'slots-confirm': '确认槽位', 'slots-sync': '同步槽位', 'slot-save': '保存自定义槽位', 'slot-remove': '删除自定义槽位', image: '登记镜像', 'image-remove': '移除镜像', add: '登记板子', remove: '移除板子', edit: '编辑板子',
  'lab-config': '配置实验室', 'lab-test': '验证实验室', 'lab-sync': '实验室板子变动',
}
const MODE: Record<Board['mode'], string> = { unknown: '状态未知', normal: '已复位', resetting: '复位中', fastboot: 'fastboot 模式' }
const KIND: Record<Proposal['kind'], string> = { 'new-board': '新板', 'replace-board': '换板', 'serial-moved': '串口', 'download-moved': '下载口', 'product-changed': '型号', 'slot-empty': '空槽位' }
const STATUS: Record<Scan['status'], string> = { running: '进行中', done: '完成', failed: '失败', cancelled: '已取消' }
const LEASE: Record<Lease['status'], string> = { held: '使用中', released: '已释放', stolen: '被抢' }

type Run = (label: string, fn: () => Promise<unknown>) => Promise<void>
type Prompt =
  | { kind: 'lock', board: Board }
  | { kind: 'queue', board: Board }
  | { kind: 'steal', board: Board }
  | { kind: 'identity' }
  | { kind: 'confirm', title: string, body: string, action: string, danger?: boolean, run: () => Promise<unknown> }

// ---------- small pieces ----------

function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'mine' | 'err', children: ReactNode }) {
  return <span className={`pill pill-${tone}`}><i />{children}</span>
}

function Dialog(props: { title: string, children: ReactNode, onClose: () => void, actions: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') props.onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])
  return (
    <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) props.onClose() }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={props.title}>
        <h2>{props.title}</h2>
        <div className="dialog-body">{props.children}</div>
        <div className="dialog-actions">{props.actions}</div>
      </div>
    </div>
  )
}

function Section(props: { title: string, extra?: ReactNode, children: ReactNode }) {
  return (
    <section className="panel">
      <header className="panel-head"><h3>{props.title}</h3>{props.extra}</header>
      {props.children}
    </section>
  )
}

/** Segmented tabs whose dark selection slides to the chosen item. */
function Tabs<T extends string>(props: { items: Array<{ key: T, label: ReactNode }>, value: T, onChange: (key: T) => void, label: string, className?: string }) {
  const root = useRef<HTMLDivElement>(null)
  const [mark, setMark] = useState<{ left: number, width: number } | null>(null)
  useLayoutEffect(() => {
    const measure = () => {
      const active = root.current?.querySelector<HTMLElement>('[aria-selected="true"]')
      if (active) setMark({ left: active.offsetLeft, width: active.offsetWidth })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root.current!)
    return () => observer.disconnect()
  }, [props.value, props.items.length])
  return (
    <div ref={root} className={`tabs ${props.className ?? ''}`} role="tablist" aria-label={props.label}>
      {mark && <span className="tabs-mark" style={{ transform: `translateX(${mark.left}px)`, width: mark.width }} aria-hidden="true" />}
      {props.items.map(item => (
        <button key={item.key} role="tab" aria-selected={props.value === item.key} className={props.value === item.key ? 'active' : ''} onClick={() => props.onChange(item.key)}>{item.label}</button>
      ))}
    </div>
  )
}

// ---------- boards ----------

function ChipRow({ chip, many, lab }: { chip: Chip, many: boolean, lab: boolean }) {
  // A lab board's ports are on the lab's side: the serial port its BMC reads, the download port on its jump host.
  const offline = lab ? '实验室那边的串口没有连上' : chip.alias ? '未绑定设备' : '没有登记串口'
  return (
    <li>
      {many && <b className="die">{chip.die}</b>}
      <span className="port">
        <span className={`dot ${chip.online ? 'dot-ok' : 'dot-off'}`} title={chip.online ? '串口在线' : offline} />
        <span className="label">串口</span>
        <code>{chip.serialPath ? (lab ? `BMC ${chip.serialPath}` : shortLink(chip.serialPath)) : '—'}</code>
        {chip.alias && !chip.online && <em className="warn">未绑定设备</em>}
        {chip.online && chip.gateError && <em className="warn" title={chip.gateError}>闸门未生效</em>}
      </span>
      <span className="port">
        <span className="label">下载口</span>
        <code>{chip.downloadUsbPath ? `${lab ? '跳板机 ' : ''}${chip.downloadUsbPath}` : '—'}</code>
        {chip.usbId && <small>{chip.usbId}</small>}
      </span>
    </li>
  )
}

function BoardCard(props: { board: Board, state: State, busy: boolean, onPrompt: (prompt: Prompt) => void, onRun: Run, onConsole: (board: Board) => void }) {
  const { board, state } = props
  const mine = board.lease?.holder === state.you
  const place = board.waiters.findIndex(waiter => waiter.holder === state.you)
  const slot = state.slots.find(item => item.slot === board.slot)
  const online = board.chips.some(chip => chip.online)
  const next = board.waiters[0]
  const canReset = board.lab ? true : !!slot?.canReset
  const canFastboot = board.lab ? true : !!slot?.canFastboot
  return (
    <article className={`card ${mine ? 'card-mine' : ''}`} data-board={board.name}>
      <header className="card-head">
        <div className="title">
          <span className="slot-tag">{board.lab ? `实验室 ${board.lab.id} · ${board.lab.device}` : <>槽位 {board.slot ?? '—'}{slot?.label ? ` · ${slot.label}` : ''}</>}</span>
          <h3>{board.name}</h3>
          <p className="sub">{board.product ?? '型号未知'}{board.soc ? ` · ${board.soc.toUpperCase()}` : ''} · {MODE[board.mode]}{board.lab?.online ? ` · 系统在线${board.lab.ip ? ` ${board.lab.ip}` : ''}` : ''}</p>
        </div>
        {!board.lease ? <Pill tone="ok">空闲</Pill> : mine ? <Pill tone="mine">你在使用</Pill> : <Pill tone="warn">使用中</Pill>}
      </header>

      <ul className="chips">
        {board.chips.map(chip => <ChipRow key={chip.die} chip={chip} many={board.chips.length > 1} lab={!!board.lab} />)}
        {!board.chips.length && <li className="muted">没有登记串口</li>}
      </ul>

      {board.lease && (
        <div className="holder">
          <div className="line"><span className="label">使用者</span><b>{who(board.lease.holder)}</b><span className="muted">自 {time(board.lease.startedAt)}</span></div>
          <div className="purpose">{board.lease.purpose}</div>
        </div>
      )}
      {board.waiters.length > 0 && (
        <ol className="queue" aria-label="排队">
          {board.waiters.map((waiter, index) => (
            <li key={waiter.id} className={waiter.holder === state.you ? 'yours' : ''}>
              <span className="pos">{index + 1}</span><b>{who(waiter.holder)}</b><span className="muted">{waiter.purpose}</span>
            </li>
          ))}
        </ol>
      )}

      <footer className="actions">
        {!board.lease && <button className="primary" disabled={props.busy} onClick={() => props.onPrompt({ kind: 'lock', board })}>拿锁</button>}
        {mine && <>
          <button disabled={props.busy || !canReset} onClick={() => props.onPrompt({ kind: 'confirm', title: `复位 ${board.name}`, body: '板子会立即重启。', action: '复位', run: () => api.reset(board.name) })}>复位</button>
          <button disabled={props.busy || !canFastboot} title={slot && !canFastboot ? '这个槽位只能复位' : undefined} onClick={() => props.onPrompt({ kind: 'confirm', title: `${board.name} 进入 fastboot`, body: '板子会重启进入 boot ROM 下载模式。', action: '进入 fastboot', run: () => api.fastboot(board.name) })}>fastboot</button>
          <button disabled={props.busy} onClick={() => props.onRun(next ? `已放锁，交给 ${who(next.holder)}` : '已放锁', () => api.unlock(board.name))}>{next ? `放锁并交给 ${who(next.holder)}` : '放锁'}</button>
        </>}
        {board.lease && !mine && (place >= 0
          ? <button disabled={props.busy} onClick={() => props.onRun('已退出排队', () => api.unqueue(board.name))}>退出排队 · 第 {place + 1} 位</button>
          : <button className="primary" disabled={props.busy} onClick={() => props.onPrompt({ kind: 'queue', board })}>排队</button>)}
        <button disabled={!online} title={online ? undefined : '没有在线的串口'} onClick={() => props.onConsole(board)}>控制台</button>
        {board.lease && !mine && <button className="link danger push" disabled={props.busy} onClick={() => props.onPrompt({ kind: 'steal', board })}>抢锁</button>}
      </footer>
    </article>
  )
}

function Console({ board, state, onClose, onError }: { board: Board, state: State, onClose: () => void, onError: (text: string) => void }) {
  const dies = board.chips.filter(chip => chip.online)
  const [die, setDie] = useState(dies[0]?.die)
  const [text, setText] = useState('')
  const [status, setStatus] = useState<'connecting' | 'live' | 'closed' | 'retry'>('connecting')
  const output = useRef<HTMLPreElement>(null)
  const mine = board.lease?.holder === state.you
  useEffect(() => {
    const pre = output.current!
    pre.textContent = ''
    setStatus('connecting')
    const append = (chunk: string) => {
      const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8
      pre.textContent = (pre.textContent + chunk).slice(-200_000)
      if (stick) pre.scrollTop = pre.scrollHeight
    }
    const source = new EventSource(`/api/console?board=${encodeURIComponent(board.name)}${die ? `&die=${encodeURIComponent(die)}` : ''}`)
    source.addEventListener('history', event => { append(JSON.parse((event as MessageEvent).data).join('\n') + '\n'); setStatus('live') })
    source.addEventListener('output', event => append(JSON.parse((event as MessageEvent).data)))
    source.addEventListener('closed', () => setStatus('closed'))
    source.onerror = () => setStatus('retry')
    return () => source.close()
  }, [board.name, die])
  // The input clears at once and lines go out in the order typed; the console stream shows the board's answer.
  const sending = useRef(Promise.resolve())
  const submit = () => {
    const line = text
    setText('')
    sending.current = sending.current.then(() => api.send(board.name, die, line)).then(() => {}, error => {
      onError((error as Error).message)
      setText(current => current || line)
    })
  }
  const label = { connecting: '连接中…', live: '实时', closed: '串口已关闭', retry: '连接中断，重试中…' }[status]
  return (
    <aside className="console" aria-label="串口控制台">
      <header>
        <div className="title">
          <h3>{board.name}</h3>
          <span className="muted" data-testid="console-status"><span className={`dot ${status === 'live' ? 'dot-ok' : 'dot-off'}`} />{label}{mine ? '' : ' · 只读'}</span>
        </div>
        {dies.length > 1 && (
          <select value={die} onChange={event => setDie(event.target.value)} aria-label="芯片">
            {dies.map(chip => <option key={chip.die} value={chip.die}>{chip.die}</option>)}
          </select>
        )}
        <button className="icon" onClick={onClose} aria-label="关闭控制台">×</button>
      </header>
      <pre ref={output} className="terminal" data-testid="console-output" />
      <form onSubmit={event => { event.preventDefault(); submit() }}>
        <input value={text} onChange={event => setText(event.target.value)} disabled={!mine}
          placeholder={mine ? '输入命令，回车发送' : '拿到锁后才能输入'} aria-label="串口输入" />
        <button className="primary" disabled={!mine}>发送</button>
      </form>
    </aside>
  )
}

function BoardsTab(props: { state: State, busy: boolean, onPrompt: (prompt: Prompt) => void, onRun: Run, onConsole: (board: string) => void, onTab: (tab: Tab) => void }) {
  const { state } = props
  const [view, setView] = useState<string>('boards')
  const boards = state.boards.filter(board => !board.lab).sort((a, b) => (a.slot ?? Infinity) - (b.slot ?? Infinity))
  const labs = state.labs.filter(lab => lab.enabled || state.boards.some(board => board.lab?.id === lab.id))
  const shown = view.startsWith('lab:') ? state.boards.filter(board => board.lab?.id === view.slice(4)) : boards
  const empty = state.slots.filter(slot => !state.boards.some(board => board.slot === slot.slot))
  const using = state.boards.filter(board => board.lease?.holder === state.you).length
  const queued = state.boards.filter(board => board.waiters.some(waiter => waiter.holder === state.you)).length
  if (!state.slots.length && !state.boards.length) {
    return (
      <div className="blank">
        <p>还没有槽位和板子。</p>
        <p className="muted">先到「设置」填写 Home Assistant（槽位会自动读出），或者添加用脚本控制的自定义槽位，再到「扫描」发现板子。</p>
        <button className="primary" onClick={() => props.onTab('settings')}>去设置</button>
      </div>
    )
  }
  return (
    <>
      <div className="toolbar">
        <Tabs label="槽位" value={view} onChange={setView} items={[
          { key: 'boards', label: <>有效槽位<span className="num">{boards.length}</span></> },
          ...labs.map(lab => ({ key: `lab:${lab.id}`, label: <>实验室 {lab.id}<span className="num">{state.boards.filter(board => board.lab?.id === lab.id).length}</span></> })),
          { key: 'empty', label: <>空槽位<span className="num">{empty.length}</span></> },
        ]} />
        <div className="summary">
          <span><b>{using}</b> 块你在使用</span>
          <span><b>{queued}</b> 块你在排队</span>
          {state.proposals.length > 0 && <button className="link" onClick={() => props.onTab('scan')}>{state.proposals.length} 条扫描建议待确认</button>}
        </div>
      </div>
      <div className="view" key={view}>
        {view !== 'empty' && (shown.length
          ? <div className="grid">{shown.map(board => <BoardCard key={board.name} board={board} state={state} busy={props.busy} onPrompt={props.onPrompt} onRun={props.onRun} onConsole={board => props.onConsole(board.name)} />)}</div>
          : view === 'boards'
            ? <div className="blank"><p>还没有发现板子。</p><button className="primary" onClick={() => props.onTab('scan')}>去扫描</button></div>
            : <div className="blank"><p>这个实验室还没有列出板子。</p><button className="primary" onClick={() => props.onTab('settings')}>去设置</button></div>)}
        {view === 'empty' && (empty.length
          ? (
            <ul className="empty-list">
              {empty.map(slot => (
                <li key={slot.slot}>
                  <span className="slot-tag">槽位 {slot.slot}</span>
                  {slot.kind === 'script' && <span className="tag">{slot.label ?? '自定义'}{slot.canFastboot ? '' : ' · 只能复位'}</span>}
                  <span className="grow muted">扫描没有在这个槽位发现板子</span>
                </li>
              ))}
              <li className="empty-foot"><span className="muted grow">接上板子后重新扫描即可登记。</span><button onClick={() => props.onTab('scan')}>去扫描</button></li>
            </ul>
          )
          : <div className="blank"><p>所有槽位都有板子。</p></div>)}
      </div>
    </>
  )
}

// ---------- scan ----------

function ScanResult({ rows }: { rows: ScanRow[] }) {
  if (!rows.length) return null
  return (
    <ul className="result">
      {rows.map(row => (
        <li key={row.slot}>
          <div className="result-head">
            <span className="slot-tag">槽位 {row.slot}</span>
            <b>{row.chips.find(chip => chip.product)?.product ?? (row.chips.length ? '型号未知' : '没有发现板子')}</b>
            {row.board && <span className="muted">已登记为 {row.board}</span>}
          </div>
          {row.chips.map(chip => (
            <div key={chip.die} className="result-chip">
              <span className="die">{chip.die}{chip.pending ? '（待确认）' : ''}</span>
              <span><span className="label">串口</span><code>{chip.serialPath ? shortLink(chip.serialPath) : '—'}</code></span>
              <span><span className="label">下载口</span><code>{chip.downloadUsbPath ?? '—'}</code>{chip.usbId && <small>{chip.usbId}</small>}</span>
            </div>
          ))}
          {row.flags.map((flag, index) => <p key={index} className="flag">{flag}</p>)}
        </li>
      ))}
    </ul>
  )
}

function ScanTab(props: { state: State, onPrompt: (prompt: Prompt) => void, onRun: Run }) {
  const { state } = props
  const [selected, setSelected] = useState<number[]>(() => state.slots.map(slot => slot.slot))
  const [evidence, setEvidence] = useState<Array<{ slot: number | null, label: string, body: string }> | null>(null)
  const scan = state.scan
  const running = scan?.status === 'running'
  const boardIn = (slot: number) => state.boards.find(board => board.slot === slot)
  // boardd refuses a scan while any board is held, whoever holds it and whichever slot it is in.
  const blocked = state.boards.filter(board => !!board.lease)
  const toggle = (slot: number) => setSelected(selected.includes(slot) ? selected.filter(item => item !== slot) : [...selected, slot].sort())
  const minor = state.firmware.find(item => item.soc === 'k3' && item.purpose === 'minor-board-info')
  useEffect(() => setEvidence(null), [scan?.id])
  return (
    <div className="columns">
      <div className="stack">
        <Section title="一键扫描">
          <p className="muted">逐个槽位按 fastboot，记录响应的串口和新出现的下载口；K3 板子往内存加载 minor-board-info 读型号，最后复位恢复正常启动。只能复位的槽位改按复位，靠启动输出认串口，读不到型号，应用建议时要填板名。扫描前会停掉所有 serial-mux 守护进程重新监听。不烧录、不擦除、不改板上配置。</p>
          <fieldset className="toggles" disabled={running} aria-label="扫描范围">
            {state.slots.map(slot => (
              <label key={slot.slot} className={selected.includes(slot.slot) ? 'on' : ''}>
                <input type="checkbox" checked={selected.includes(slot.slot)} onChange={() => toggle(slot.slot)} />
                <span>槽位 {slot.slot}</span>
                <small>{boardIn(slot.slot)?.name ?? '空'}{slot.canFastboot ? '' : ' · 只能复位'}</small>
              </label>
            ))}
          </fieldset>
          {!state.slots.length && <p className="warn">还没有槽位：请先在「设置」里填写 Home Assistant（槽位会自动读出），或添加自定义槽位。</p>}
          {!minor && <p className="warn">boardd 没有自带 K3 的 minor-board-info 固件，只能对应串口和下载口，读不到型号。</p>}
          {blocked.length > 0 && <p className="warn">{blocked.map(board => board.lease!.holder === state.you ? `${board.name} 被你拿着锁` : `${board.name} 正被 ${who(board.lease!.holder)} 使用`).join('；')}。有板子被拿着锁时不能扫描，先放锁或等别人用完。</p>}
          <div className="actions">
            {running
              ? <button className="danger" onClick={() => props.onRun('已请求取消', () => api.cancelScan(scan!.id))}>取消扫描</button>
              : <button className="primary" disabled={!selected.length || blocked.length > 0} onClick={() => props.onPrompt({
                  kind: 'confirm', title: '开始扫描', action: '开始扫描',
                  body: `将锁住槽位 ${selected.join('、')}，停掉所有 serial-mux 守护进程，逐个切换到 fastboot、加载诊断镜像，结束后复位；只能复位的槽位会被复位两次。扫描期间别人不能使用这些板子。`,
                  run: () => api.scan(selected),
                })}>开始扫描</button>}
          </div>
        </Section>
        <ProposalList proposals={state.proposals} onRun={props.onRun} />
      </div>
      <div className="stack">
        {scan ? (
          <Section title={`扫描 · ${time(scan.startedAt)}`} extra={<Pill tone={scan.status === 'done' ? 'ok' : scan.status === 'running' ? 'mine' : 'err'}>{STATUS[scan.status]}</Pill>}>
            {scan.message && <p className="warn">{scan.message}</p>}
            <ol className="steps" aria-live="polite">
              {scan.steps.map(step => (
                <li key={step.seq}>
                  <time>{time(step.at, false)}</time>
                  <span className={`slot-tag ${step.slot === null ? 'ghost' : ''}`}>{step.slot ?? '·'}</span>
                  <span>{shortenLinks(step.summary)}</span>
                </li>
              ))}
            </ol>
            <ScanResult rows={scan.result} />
            {!running && !evidence && <button className="link" onClick={async () => setEvidence(await api.evidence(scan.id))}>查看原始证据</button>}
            {evidence && (
              <div className="evidence">
                {evidence.map((item, index) => <details key={index}><summary>{item.slot !== null ? `槽位 ${item.slot} · ` : ''}{shortenLinks(item.label)}</summary><pre>{item.body || '（空）'}</pre></details>)}
              </div>
            )}
          </Section>
        ) : <Section title="扫描结果"><p className="muted">还没有扫描过。</p></Section>}
      </div>
    </div>
  )
}

/** A new board on a slot that can only reset has no product to be named after, so the person names it. */
const needsName = (item: Proposal) => item.kind === 'new-board' && !item.change.name

function ProposalList({ proposals, onRun }: { proposals: Proposal[], onRun: Run }) {
  const [names, setNames] = useState<Record<string, string>>({})
  if (!proposals.length) return null
  const unnamed = proposals.filter(item => needsName(item) && !names[item.id]?.trim())
  return (
    <Section title={`清单改动建议 · ${proposals.length}`} extra={
      <div className="actions">
        <button onClick={() => onRun('已全部拒绝', () => api.proposals(proposals.map(item => item.id), 'reject'))}>全部拒绝</button>
        <button className="primary" disabled={unnamed.length > 0} title={unnamed.length ? '先给新板子填板名' : undefined}
          onClick={() => onRun('已全部应用', () => api.proposals(proposals.map(item => item.id), 'apply', names))}>全部应用</button>
      </div>
    }>
      <ul className="proposals">
        {proposals.map(item => (
          <li key={item.id}>
            <span className="kind">{KIND[item.kind]}</span>
            <span className="grow">{shortenLinks(item.summary)}</span>
            {needsName(item) && (
              <input className="board-name" value={names[item.id] ?? ''} onChange={event => setNames({ ...names, [item.id]: event.target.value })}
                placeholder="板名，例如 mijia-dev" aria-label={`槽位 ${item.slot} 的板名`} />
            )}
            <span className="actions">
              <button onClick={() => onRun('已拒绝', () => api.proposals([item.id], 'reject'))}>拒绝</button>
              <button className="primary" disabled={needsName(item) && !names[item.id]?.trim()}
                onClick={() => onRun('已应用', () => api.proposals([item.id], 'apply', needsName(item) ? { [item.id]: names[item.id]!.trim() } : undefined))}>应用</button>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  )
}

// ---------- settings ----------

function SettingsTab(props: { state: State, onPrompt: (prompt: Prompt) => void, onRun: Run, onError: (text: string) => void }) {
  const { state } = props
  const [url, setUrl] = useState(state.ha.url ?? '')
  const [token, setToken] = useState('')
  return (
    <div className="stack narrow">
      <Section title="Home Assistant" extra={state.ha.verifiedAt && <Pill tone={state.ha.verifyOk ? 'ok' : 'err'}>{state.ha.verifyOk ? '连接正常' : '连接失败'}</Pill>}>
        <form className="form-grid" onSubmit={event => { event.preventDefault(); void props.onRun('已保存', async () => { await api.configureHa(url, token); setToken('') }) }}>
          <label>地址<input value={url} onChange={event => setUrl(event.target.value)} placeholder="http://homeassistant.local:8123" required /></label>
          <label>长期访问令牌
            <input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off"
              placeholder={state.ha.hasToken ? '已保存（不显示，留空则不修改）' : '粘贴令牌'} />
          </label>
          <div className="actions span">
            <button className="primary">保存并验证</button>
            <button type="button" disabled={!state.ha.hasToken} onClick={() => props.onRun('验证完成', () => api.testHa())}>重新验证</button>
            {state.ha.verifiedAt && <span className={state.ha.verifyOk ? 'muted' : 'warn'} data-testid="ha-status">{state.ha.verifyOk ? '连接正常' : '连接失败'}：{state.ha.verifyMessage} · {time(state.ha.verifiedAt)}{state.ha.verifyOk ? ` · 控制器 ${state.slots.filter(slot => slot.kind === 'ha').length} 个槽位` : ''}</span>}
          </div>
        </form>
      </Section>

      {state.labs.map(lab => <LabSection key={lab.id} lab={lab} onRun={props.onRun} />)}

      <ScriptSlots state={state} onPrompt={props.onPrompt} onRun={props.onRun} />

      <Section title="自带固件">
        <p className="muted">boardd 只加载仓库 <code>firmware/</code> 里 <code>firmware.json</code> 列出、且 sha256 仍然一致的固件；要换就改那里再提交。扫描固定用 minor-board-info，只改内核时 <code>boards boot</code> 用 fsbl 和 u-boot-opensbi。</p>
        <ul className="images">
          {state.firmware.map(item => (
            <li key={`${item.soc}/${item.purpose}`}>
              <span className="kind">{item.soc.toUpperCase()}</span>
              <div className="grow"><b>{item.purpose}</b><code className="path">{item.path}</code><small>sha256 {item.sha256.slice(0, 16)}…{item.note ? ` · ${item.note}` : ''}</small></div>
            </li>
          ))}
        </ul>
        {!state.firmware.length && <p className="warn">没有找到 firmware.json。</p>}
      </Section>
    </div>
  )
}

/** A remote lab: whether boardd uses it, and the access its boards are reached with. */
function LabSection({ lab, onRun }: { lab: LabSettings, onRun: Run }) {
  const [enabled, setEnabled] = useState(lab.enabled)
  const [url, setUrl] = useState(lab.url ?? '')
  const [username, setUsername] = useState(lab.username ?? '')
  const [password, setPassword] = useState('')
  const [jump, setJump] = useState(lab.jump ?? '')
  const [devices, setDevices] = useState(lab.devices ?? '')
  const save = () => onRun(enabled ? '已保存，实验室的板子已列出' : lab.enabled ? '已关闭实验室' : '已保存', async () => {
    await api.configureLab({ id: lab.id, enabled, url, username, password, jump, devices })
    setPassword('')
  })
  const status = !lab.enabled ? <Pill tone="warn">未开启</Pill> : lab.verifiedAt ? <Pill tone={lab.verifyOk ? 'ok' : 'err'}>{lab.verifyOk ? '连接正常' : '连接失败'}</Pill> : null
  return (
    <Section title={`实验室 ${lab.id}`} extra={status}>
      <p className="muted">{lab.kind}。开启后 boardd 从实验室后台列出板子，每分钟刷新一次。复位、fastboot 和串口走后台接口，boot、stage 在跳板机上跑 fastboot，命令和本地板子一样。</p>
      <form className="form-grid" onSubmit={event => { event.preventDefault(); void save() }}>
        <label className="switch span"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />开启 {lab.id} 实验室</label>
        <label>后台地址<input value={url} onChange={event => setUrl(event.target.value)} placeholder="http://bmc.example:8080" required={enabled} /></label>
        <label>账号<input value={username} onChange={event => setUsername(event.target.value)} autoComplete="off" required={enabled} /></label>
        <label>密码
          <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password"
            placeholder={lab.hasPassword ? '已保存（不显示，留空则不修改）' : '后台密码'} required={enabled && !lab.hasPassword} />
        </label>
        <label>跳板机<input value={jump} onChange={event => setJump(event.target.value)} placeholder={lab.defaultJump ? `留空用 ${lab.defaultJump}` : 'user@host'} /></label>
        <label className="span">只用这些板子<input value={devices} onChange={event => setDevices(event.target.value)} placeholder="留空列出全部；例如 sub0-* sub1-*" /></label>
        <div className="actions span">
          <button className="primary">{enabled ? '保存并列出板子' : '保存'}</button>
          <button type="button" disabled={!lab.enabled} onClick={() => onRun('已重新验证', () => api.testLab(lab.id))}>重新验证并刷新</button>
        </div>
        {lab.enabled && lab.verifiedAt && <p className={`span ${lab.verifyOk ? 'muted' : 'warn'}`} data-testid={`lab-${lab.id}-verify`}>{lab.verifyMessage} · {time(lab.verifiedAt)}</p>}
        {lab.enabled && lab.syncedAt && <p className={`span ${lab.syncOk ? 'muted' : 'warn'}`} data-testid={`lab-${lab.id}-sync`}>{lab.syncMessage} · {time(lab.syncedAt)}</p>}
      </form>
    </Section>
  )
}

const BLANK_SLOT = { slot: '', label: '', resetScript: '', fastbootScript: '' }

/** Slots outside the Home Assistant controller, driven by scripts people paste here. */
function ScriptSlots(props: { state: State, onPrompt: (prompt: Prompt) => void, onRun: Run }) {
  const { state } = props
  const [form, setForm] = useState(BLANK_SLOT)
  const [editing, setEditing] = useState<number | null>(null)
  const scripted = state.slots.filter(slot => slot.kind === 'script')
  const boardIn = (slot: number) => state.boards.find(board => board.slot === slot)
  const number = Number(form.slot)
  const clash = editing === null && form.slot !== '' && state.slots.find(slot => slot.slot === number)
  const edit = (slot: Slot) => {
    setEditing(slot.slot)
    setForm({ slot: String(slot.slot), label: slot.label ?? '', resetScript: slot.resetScript ?? '', fastbootScript: slot.fastbootScript ?? '' })
  }
  const reset = () => { setEditing(null); setForm(BLANK_SLOT) }
  return (
    <Section title="自定义槽位">
      <p className="muted">
        控制器以外的板子，用脚本复位，例如让米家插座断电再上电。脚本在 boardd 所在的机器上以它的用户身份运行：首行有 <code>#!</code> 就用指定的解释器，否则用 bash；
        超过 2 分钟会被终止，退出码不是 0 算失败。脚本能读到 <code>BOARDS_SLOT</code>、<code>BOARDS_ACTION</code>（reset 或 fastboot）和 <code>BOARDS_BOARD</code>。fastboot 脚本留空，这个槽位就只能复位。
      </p>
      {scripted.length > 0 && (
        <ul className="images script-slots">
          {scripted.map(slot => (
            <li key={slot.slot}>
              <span className="slot-tag">槽位 {slot.slot}</span>
              <div className="grow"><b>{slot.label ?? '自定义槽位'}</b><small>{slot.canFastboot ? '复位 · fastboot' : '只能复位'}{boardIn(slot.slot) ? ` · ${boardIn(slot.slot)!.name}` : ''}</small></div>
              <button onClick={() => edit(slot)}>编辑</button>
              <button disabled={!!boardIn(slot.slot)} title={boardIn(slot.slot) ? '槽位上还有板子' : undefined}
                onClick={() => props.onPrompt({ kind: 'confirm', title: `删除槽位 ${slot.slot}`, body: '脚本会一起删除。', action: '删除', danger: true, run: async () => { await api.removeScriptSlot(slot.slot); if (editing === slot.slot) reset() } })}>删除</button>
            </li>
          ))}
        </ul>
      )}
      <form className="form-grid image-form" onSubmit={event => {
        event.preventDefault()
        void props.onRun(editing === null ? '已添加槽位' : '已保存', async () => { await api.saveScriptSlot({ slot: number, label: form.label, resetScript: form.resetScript, fastbootScript: form.fastbootScript }); reset() })
      }}>
        <label>槽位号<input type="number" min={0} max={9999} step={1} required value={form.slot} disabled={editing !== null} onChange={event => setForm({ ...form, slot: event.target.value })} /></label>
        <label>名称<input value={form.label} maxLength={60} placeholder="米家插座 · 工位 3" onChange={event => setForm({ ...form, label: event.target.value })} /></label>
        <label className="span">复位脚本
          <textarea required rows={6} spellCheck={false} value={form.resetScript} onChange={event => setForm({ ...form, resetScript: event.target.value })}
            placeholder={'#!/bin/bash\n# 断电 3 秒再上电\nmiiocli plug --ip 192.168.1.50 --token "$TOKEN" off\nsleep 3\nmiiocli plug --ip 192.168.1.50 --token "$TOKEN" on'} />
        </label>
        <label className="span">fastboot 脚本
          <textarea rows={3} spellCheck={false} value={form.fastbootScript} onChange={event => setForm({ ...form, fastbootScript: event.target.value })} placeholder="留空表示这个槽位只能复位" />
        </label>
        <div className="actions span">
          <button className="primary" disabled={!!clash}>{editing === null ? '添加槽位' : `保存槽位 ${editing}`}</button>
          {editing !== null && <button type="button" onClick={reset}>取消</button>}
          {clash && <span className="warn">槽位 {number} 已存在{clash.kind === 'ha' ? '（属于 Home Assistant 控制器）' : '，点它的「编辑」修改'}</span>}
        </div>
      </form>
    </Section>
  )
}

// ---------- history ----------

function HistoryTab({ refreshKey }: { refreshKey: number }) {
  const [history, setHistory] = useState<{ actions: Action[], leases: Lease[], scans: Scan[] } | null>(null)
  const [board, setBoard] = useState('')
  const [limit, setLimit] = useState(40)
  useEffect(() => { void api.history().then(setHistory) }, [refreshKey])
  if (!history) return <p className="muted">加载中…</p>
  const boards = [...new Set(history.actions.map(action => action.board).filter((name): name is string => !!name))].sort()
  const actions = history.actions.filter(action => !board || action.board === board)
  return (
    <div className="stack narrow">
      <Section title="操作记录" extra={
        <select value={board} onChange={event => { setBoard(event.target.value); setLimit(40) }} aria-label="按板子筛选">
          <option value="">全部板子</option>
          {boards.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      }>
        <ul className="log">
          {actions.slice(0, limit).map(action => (
            <li key={action.id} className={action.ok ? '' : 'failed'}>
              <time>{time(action.at)}</time>
              <span className="actor">{who(action.actor)}</span>
              <span className="what">
                <b>{ACTIONS[action.kind] ?? action.kind}</b>
                {action.board && <span className="tag">{action.board}</span>}
                {action.detail && <span className="muted detail">{shortenLinks(action.detail)}</span>}
                {!action.ok && <span className="warn detail">失败：{action.message}</span>}
              </span>
            </li>
          ))}
        </ul>
        {actions.length > limit && <button className="link" onClick={() => setLimit(limit + 80)}>显示更多（还有 {actions.length - limit} 条）</button>}
      </Section>
      <Section title="锁记录">
        <ul className="log">
          {history.leases.slice(0, 40).map(lease => (
            <li key={lease.id}>
              <time>{time(lease.startedAt)}</time>
              <span className="actor">{who(lease.holder)}</span>
              <span className="what">
                <span className="tag">{lease.board}</span>
                <span className="muted detail">{lease.purpose}</span>
                <span className={lease.status === 'stolen' ? 'warn detail' : 'detail'}>{LEASE[lease.status]}{lease.status !== 'held' ? ` · ${time(lease.endedAt)}` : ''}{lease.status === 'stolen' && lease.endReason ? ` · ${lease.endReason}` : ''}</span>
              </span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="扫描记录">
        {history.scans.map(scan => (
          <details key={scan.id} className="scan-record">
            <summary><time>{time(scan.startedAt)}</time><span>{who(scan.holder)}</span><span className="muted">槽位 {scan.scope.join('、')}</span><Pill tone={scan.status === 'done' ? 'ok' : 'err'}>{STATUS[scan.status]}</Pill></summary>
            <ScanResult rows={scan.result} />
          </details>
        ))}
        {!history.scans.length && <p className="muted">还没有扫描过。</p>}
      </Section>
    </div>
  )
}

// ---------- shell ----------

function useToasts() {
  const [toasts, setToasts] = useState<Array<{ id: number, text: string, error: boolean }>>([])
  const show = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random()
    setToasts(list => [...list.slice(-2), { id, text, error }])
    window.setTimeout(() => setToasts(list => list.filter(item => item.id !== id)), error ? 6000 : 3000)
  }, [])
  return { toasts, show }
}

function App() {
  const [state, setState] = useState<State | null>(null)
  const [tab, setTab] = useState<Tab>(() => (TABS.find(([key]) => `#${key}` === location.hash)?.[0]) ?? 'boards')
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [connected, setConnected] = useState(true)
  const { toasts, show } = useToasts()
  const you = useRef('')
  const [consoleBoard, setConsoleBoard] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try { const next = await api.state(); you.current = next.you; setState(next); setConnected(true) } catch { setConnected(false) }
    setRefreshKey(key => key + 1)
  }, [])

  useEffect(() => {
    void refresh()
    const source = new EventSource('/api/events')
    let timer: number | undefined
    const soon = () => { window.clearTimeout(timer); timer = window.setTimeout(refresh, 150) }
    source.addEventListener('changed', soon)
    source.addEventListener('scan', soon)
    source.addEventListener('lease-stolen', event => {
      const data = JSON.parse((event as MessageEvent).data)
      if (data.from === you.current) show(`${data.board} 的锁被 ${who(data.by)} 抢走：${data.reason}`, true)
      soon()
    })
    source.addEventListener('lease-granted', event => {
      const data = JSON.parse((event as MessageEvent).data)
      if (data.holder === you.current) show(`轮到你了：已拿到 ${data.board} 的锁`)
      soon()
    })
    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)
    const tick = window.setInterval(refresh, 30_000)
    return () => { source.close(); window.clearInterval(tick) }
  }, [refresh, show])

  useEffect(() => { history.replaceState(null, '', `#${tab}`) }, [tab])

  const run = useCallback<Run>(async (label, fn) => {
    setBusy(true)
    try { await fn(); show(label) } catch (error) { show((error as Error).message, true) }
    finally { setBusy(false); void refresh() }
  }, [refresh, show])

  const current = state?.boards.find(board => board.name === consoleBoard)
  const consoleOpen = !!current
  return (
    <div className="app">
      <header className="top">
        <div className="brand"><span className="logo" aria-hidden="true" /><h1>开发板管理平台</h1></div>
        <Tabs label="页面" className="nav" value={tab} onChange={setTab} items={TABS.map(([key, label]) => ({
          key, label: <>{label}{key === 'scan' && state?.proposals.length ? <span className="count">{state.proposals.length}</span> : null}</>,
        }))} />
        <button className="me" onClick={() => setPrompt({ kind: 'identity' })} title="修改我的名字" data-testid="identity">
          <span className="avatar">{(state ? who(state.you) : '?').slice(0, 1).toUpperCase()}</span><span>{state ? who(state.you) : ''}</span>
        </button>
      </header>
      {!connected && <p className="banner">与 boardd 的连接中断，正在重试…</p>}
      <main className={consoleOpen ? 'with-console' : ''}>
        <div className="view" key={tab}>
          {!state ? <p className="muted">加载中…</p>
            : tab === 'boards' ? <BoardsTab state={state} busy={busy} onPrompt={setPrompt} onRun={run} onConsole={setConsoleBoard} onTab={setTab} />
            : tab === 'scan' ? <ScanTab state={state} onPrompt={setPrompt} onRun={run} />
            : tab === 'settings' ? <SettingsTab state={state} onPrompt={setPrompt} onRun={run} onError={text => show(text, true)} />
            : <HistoryTab refreshKey={refreshKey} />}
        </div>
      </main>
      {state && current && <Console key={current.name} board={current} state={state} onClose={() => setConsoleBoard(null)} onError={text => show(text, true)} />}
      {prompt && <PromptDialog prompt={prompt} onClose={() => setPrompt(null)} onRun={run} onIdentity={() => void refresh()} />}
      <div className="toasts" role="status">{toasts.map(toast => <div key={toast.id} className={`toast ${toast.error ? 'error' : ''}`}>{toast.text}</div>)}</div>
    </div>
  )
}

function PromptDialog({ prompt, onClose, onRun, onIdentity }: { prompt: Prompt, onClose: () => void, onRun: Run, onIdentity: () => void }) {
  const [text, setText] = useState(prompt.kind === 'identity' ? identity.get() : '')
  const value = text.trim()
  const submit = async () => {
    onClose()
    switch (prompt.kind) {
      case 'lock': return onRun(`已拿到 ${prompt.board.name} 的锁`, () => api.lock(prompt.board.name, value))
      case 'queue': return onRun(`已排队 ${prompt.board.name}`, () => api.queue(prompt.board.name, value))
      case 'steal': return onRun(`已抢到 ${prompt.board.name} 的锁`, () => api.steal(prompt.board.name, value))
      case 'identity': identity.set(value); return onIdentity()
      case 'confirm': return onRun(`${prompt.title}：完成`, prompt.run)
    }
  }
  const valid = prompt.kind === 'confirm' || (prompt.kind === 'identity' ? value === '' || /^[A-Za-z0-9_.@-]{1,40}$/.test(value) : !!value)
  const board = 'board' in prompt ? prompt.board : null
  const title = { lock: `拿 ${board?.name} 的锁`, queue: `排队 ${board?.name}`, steal: `抢 ${board?.name} 的锁`, identity: '我是谁', confirm: prompt.kind === 'confirm' ? prompt.title : '' }[prompt.kind]
  const action = prompt.kind === 'confirm' ? prompt.action : { lock: '拿锁', queue: '排队', steal: '抢锁', identity: '保存' }[prompt.kind]
  const danger = prompt.kind === 'steal' || (prompt.kind === 'confirm' && prompt.danger)
  return (
    <Dialog title={title} onClose={onClose} actions={<>
      <button onClick={onClose}>取消</button>
      <button className={danger ? 'danger solid' : 'primary'} disabled={!valid} onClick={() => void submit()}>{action}</button>
    </>}>
      <form onSubmit={event => { event.preventDefault(); if (valid) void submit() }} className="form">
        {prompt.kind === 'lock' && <>
          <p className="muted">锁没有时间限制，用完请放锁；有人排队时会自动交给排在第一位的人。</p>
          <label>用途<input autoFocus value={text} onChange={event => setText(event.target.value)} placeholder="例如：调试 U-Boot 网络" /></label>
        </>}
        {prompt.kind === 'queue' && <>
          <p>现在由 <b>{who(prompt.board.lease?.holder ?? '')}</b> 使用（{prompt.board.lease?.purpose}）{prompt.board.waiters.length ? `，前面还有 ${prompt.board.waiters.length} 人` : ''}。轮到你时会自动把锁交给你。</p>
          <label>用途<input autoFocus value={text} onChange={event => setText(event.target.value)} placeholder="例如：跑一遍启动回归" /></label>
        </>}
        {prompt.kind === 'steal' && <>
          <p>当前由 <b>{who(prompt.board.lease?.holder ?? '')}</b> 使用（{prompt.board.lease?.purpose}）。抢锁会记录下来，原使用者会收到通知；排队顺序不变。</p>
          <label>原因<input autoFocus value={text} onChange={event => setText(event.target.value)} placeholder="写明为什么要抢" /></label>
        </>}
        {prompt.kind === 'identity' && <>
          <p className="muted">几个人用同一个页面时，各自填自己的名字，排队和锁才分得清。留空则使用 boardd 所在机器的用户。</p>
          <label>名字<input autoFocus value={text} onChange={event => setText(event.target.value)} placeholder="字母、数字、. _ - @" /></label>
        </>}
        {prompt.kind === 'confirm' && <p>{prompt.body}</p>}
      </form>
    </Dialog>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
