/**
 * A board's page: the board and its controls on the left, the console on the right. The handle on the console's edge
 * (or F) gives the console the whole screen; Esc brings the side back. With the lock, R resets, D enters download
 * mode, B boots.
 */
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { api, type PageState } from '../../../src/ui/api.ts'
import { clearConsole, reconnectConsole, searchConsole, SerialConsole, STATUS_TEXT, type ConsoleStatus } from '../../../src/ui/console.tsx'
import { consoleStatusText } from '../../../src/ui/console-session.ts'
import { ACTIONS, lastRun, PURPOSES } from '../../../src/ui/format.ts'
import { prefs } from '../../../src/ui/notify.ts'
import type { Board, BoardChannels, BoardDetail } from 'boardlab-core/shared/types.ts'
import { canRediscover, useBoardActions } from '../actions.tsx'
import { FlashDialog } from '../flash.tsx'
import { age, ArtIcon, clock, copyText, hhmm, holder, Icon, model, refreshNow, slotOf, Ticking, upper, useUI, where, Who, type Model } from '../kit.tsx'
import { ViewPanel, viewsFor } from '../render.tsx'
import { usePicker } from '../../../src/ui/picker.ts'
import { LogPanel, type LogQuery } from './logs.tsx'

const LAST_BOOT = 'boardlab.modern.lastBoot'
const lastBoot = (board: string): { sdk: string, method: 'load' | 'download' } | null => { try { return JSON.parse(localStorage.getItem(LAST_BOOT) ?? '{}')[board] ?? null } catch { return null } }
const saveBoot = (board: string, value: { sdk: string, method: 'load' | 'download' }) => { try { localStorage.setItem(LAST_BOOT, JSON.stringify({ ...JSON.parse(localStorage.getItem(LAST_BOOT) ?? '{}'), [board]: value })) } catch {} }

// Break points come from a slow read of the SDK's recipe and do not change while the page lives: one read per board and
// SDK, shared by the dialog (opening it again is instant) and prefetched as soon as the board's page shows. A read for
// another board forgets the previous board's, so a dialog never shows what belonged to the board before it.
const breaksCache = new Map<string, string[]>()
const breaksReads = new Map<string, Promise<string[]>>()
let breaksBoard = ''
const breakKey = (board: string, sdk: string) => `${board}|${sdk}`
const cachedBreaks = (board: string, sdk: string) => breaksBoard === board ? breaksCache.get(breakKey(board, sdk)) ?? null : null
function readBreaks(board: string, sdk: string): Promise<string[]> {
  if (breaksBoard !== board) { breaksBoard = board; breaksCache.clear(); breaksReads.clear() }
  const key = breakKey(board, sdk), cached = breaksCache.get(key)
  if (cached) return Promise.resolve(cached)
  const reading = breaksReads.get(key)
  if (reading) return reading
  const read = api.bootBreaks(board, sdk).then(got => { const list = got?.load ?? []; if (breaksBoard === board) breaksCache.set(key, list); return list })
  breaksReads.set(key, read)
  void read.finally(() => { if (breaksReads.get(key) === read) breaksReads.delete(key) }).catch(() => {})
  return read
}
function prefetchBreaks(board: string, sdk: string) { if (sdk) void readBreaks(board, sdk).catch(() => {}) }

export function BoardPage({ state, name, dark, full, setFull, watched }: { state: PageState, name: string, dark: boolean, full: boolean, setFull: (full: boolean) => void, watched: string[] }) {
  const board = state.boards.find(b => b.name === name)
  const [tab, setTab] = useState<'tty' | 'log'>('tty')
  // A search the console handed to the log: the log opens on it.
  const [logQuery, setLogQuery] = useState<LogQuery | null>(null)
  const [status, setStatus] = useState<ConsoleStatus>('connecting')
  const [reason, setReason] = useState<string | null>(null)
  const [die, setDie] = useState<string | undefined>()
  const ui = useUI()
  if (!board) return <div className="page"><section className="hero"><h1>没有这块板子</h1><p>可能被移除了。<a href="#/">回到板子</a></p></section></div>
  const m = model(board, state.you)
  const dies = board.chips.filter(c => c.online || board.lab).map(c => c.die), chosen = die && dies.includes(die) ? die : dies[0]
  const lab = board.lab ? state.labs.find(item => item.id === board.lab!.id) : null
  return (
    <div className={`detail${full ? ' full' : ''}`}>
      <aside className="side">{full ? <Rail board={board} m={m} /> : <Side key={board.name} state={state} board={board} m={m} watched={watched} openLogs={() => setTab('log')} />}</aside>
      <section className="con">
        {lab?.discovery?.running && <div className="flag run" style={{ margin: '0 12px 8px' }}><span className="spin" /><div><b>实验室正在发现板子</b><span>{lab.discovery.line}</span></div>
          <button className="pill sm" onClick={() => void api.cancelDiscovery(lab.id).then(out => ui.toast('取消发现', out.message), error => ui.fail('取消发现失败', error))}>取消发现</button></div>}
        <button className="handle" onClick={() => setFull(!full)} title={full ? '还原（F）' : '串口占满全屏（F）'} aria-label={full ? '还原' : '串口占满'}><Icon name={full ? 'chev' : 'back'} /></button>
        <div className="ctb">
          <button className={`tab${tab === 'tty' ? ' on' : ''}`} onClick={() => setTab('tty')}>串口</button>
          <button className={`tab${tab === 'log' ? ' on' : ''}`} onClick={() => setTab('log')}>日志</button>
          {full && <span className="cname">{upper(board.name)}</span>}
          <span className="gap" />
          <span className="st"><span className={`dot ${m.flags.gone || m.flags.offline ? 'bad' : status === 'live' ? 'live' : status === 'retry' || status === 'closed' ? 'warn' : ''}`} />{m.flags.gone ? '串口离线' : consoleStatusText(status, reason, STATUS_TEXT)}</span>
          {tab === 'tty' && <button className="ib" title="在串口里搜索（Ctrl+F）" aria-label="搜索" onClick={() => searchConsole(board.name, chosen)}><Icon name="search" /></button>}
          {tab === 'tty' && <button className="ib" title="清屏（保留连接）" aria-label="清屏" onClick={() => clearConsole(board.name, chosen)}>清屏</button>}
          {tab === 'tty' && status !== 'live' && <button className="ib" title="现在重连串口" aria-label="重连" onClick={() => reconnectConsole(board.name, chosen)}>重连</button>}
          {dies.length > 1 && <span className="seg2">{dies.map(d => <button key={d} className={d === chosen ? 'on' : ''} onClick={() => setDie(d)}>{d}</button>)}</span>}
          <button className="ib" title={full ? '还原' : '占满'} aria-label={full ? '还原' : '占满'} onClick={() => setFull(!full)}><Icon name={full ? 'shrink' : 'expand'} /></button>
        </div>
        {tab === 'log' ? <LogPanel board={board.name} die={chosen} query={logQuery} />
          : dies.length || board.lab ? <>
            <SerialConsole key={`${board.name}:${chosen ?? ''}`} board={board.name} die={chosen} dark={dark} onStatus={(next, why) => { setStatus(next); setReason(why) }} className="terminal" jumpClassName="jump" searchClassName="tsearch" bootsClassName="tboots"
              onSearchHistory={(grep, regex) => { setLogQuery({ grep, regex }); setTab('log') }} />
            {!m.mine && <div className="ro"><Icon name="eye" />{m.holder ? `${holder(m.holder).name} 拿着锁，你的输入会和他们的混在一起` : '没拿锁也能输入；长时间用请拿锁'}</div>}
          </> : <div className="term-empty">这块板子没有在线的串口</div>}
      </section>
    </div>
  )
}

function Rail({ board, m }: { board: Board, m: Model }) {
  const act = useBoardActions(board)
  const off = !m.mine || m.flags.gone || !!act.busy
  return <>
    <a className="pill icon" href="#/" title="回到板子" aria-label="回到板子"><Icon name="back" /></a>
    <span className={`dot ${m.tone}`} title={m.word} />
    <span className="rail-name">{upper(board.name)}</span>
    <button className="pill icon" title="复位（R）" aria-label="复位" disabled={off} onClick={act.reset}><Icon name="power" /></button>
    <button className="pill icon" title="下载模式（D）" aria-label="下载模式" disabled={off} onClick={act.fastboot}><Icon name="zap" /></button>
  </>
}

/**
 * The board's name, which is also the way to another board: it looks like a field on hover (always on a touch screen),
 * and opens the boards to switch to, each with where it is and its state. The page keeps its tab across the switch.
 */
function BoardSwitch({ state, board }: { state: PageState, board: Board }) {
  // Yours first, then by host and slot, as on the boards page; an empty slot only when it is the one shown.
  const boards = state.boards.filter(b => !b.lab?.empty || b.name === board.name)
    .map(b => ({ b, m: model(b, state.you) }))
    .sort((x, y) => Number(y.m.mine) - Number(x.m.mine) || (x.b.slotRef ?? x.b.name).localeCompare(y.b.slotRef ?? y.b.name, 'en', { numeric: true }))
  const p = usePicker({
    items: boards, key: x => x.b.name, current: board.name,
    text: x => [x.b.name, upper(x.b.name), where(x.b), x.b.product, x.m.word].join(' '),
    onPick: x => { location.hash = `#/board/${encodeURIComponent(x.b.name)}` },
  })
  return (
    <div className={`bswitch${p.open ? ' open' : ''}`} {...p.rootProps}>
      {/* The heading holds the button, not the other way round: a button's content is not read as a heading. */}
      <h1 className="bname">
        <span className="bswitch-t" {...p.triggerProps} title={`${upper(board.name)} · 换一块板子`} aria-label={`${upper(board.name)}，换一块板子`}>
          <ArtIcon board={board} className="bart big" />{upper(board.name)}<Icon name="chev" />
        </span>
      </h1>
      {p.open && <div className="pop">
        {p.filtering && <label className="find"><Icon name="search" /><input {...p.inputProps} placeholder="找板子" aria-label="找板子" /></label>}
        <ul {...p.listProps} aria-label="换一块板子">
          {p.shown.map((x, i) => (
            <li key={x.b.name} {...p.optionProps(x, i)}>
              <span className={`dot ${x.m.tone}`} />
              <span className="bs-name"><ArtIcon board={x.b} />{upper(x.b.name)}</span>
              <span className="bs-sub">{where(x.b)} · {x.m.word}</span>
              {x.b.name === board.name && <Icon name="check" />}
            </li>
          ))}
          {!p.shown.length && <li className="bs-none">没有匹配的板子</li>}
        </ul>
      </div>}
    </div>
  )
}

function Side({ state, board, m, watched, openLogs }: { state: PageState, board: Board, m: Model, watched: string[], openLogs: () => void }) {
  const act = useBoardActions(board)
  const ui = useUI()
  const [detail, setDetail] = useState<BoardDetail | null>(null)
  const [menu, setMenu] = useState(false)
  useEffect(() => { void api.board(board.name).then(setDetail).catch(() => {}) }, [board.name, board.lease?.id, board.mode, board.lab?.progress])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, .xterm, [role=dialog]') || e.metaKey || e.ctrlKey || e.altKey || act.busy) return
      const k = e.key.toLowerCase()
      if (m.mine && !m.flags.gone && k === 'r') act.reset()
      else if (m.mine && !m.flags.gone && k === 'd') act.fastboot()
      else if (m.mine && !m.flags.gone && k === 'b') bootDialog()
      else if (m.mine && !m.flags.gone && k === 'w' && canFlash) flashDialog()
      else if (k === 'l' && m.lock === 'free') act.lock()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  useEffect(() => { if (!menu) return; const off = () => setMenu(false); window.addEventListener('click', off); return () => window.removeEventListener('click', off) }, [menu])
  const watchedOn = watched.includes(board.name), last = lastBoot(board.name)
  // The dialog opens on this SDK, so read its break points now: by the time the person opens it, they are there.
  const sdks = board.lab?.sdks ?? []
  const bootSdk = last && sdks.includes(last.sdk) ? last.sdk : sdks[0] ?? ''
  useEffect(() => { prefetchBreaks(board.name, bootSdk) }, [board.name, bootSdk])
  const bootDialog = () => ui.layer(close => <BootDialog board={board} close={close} onStart={(sdk, brk) => { saveBoot(board.name, { sdk, method: 'load' }); void act.boot(sdk, 'load', brk) }} />)
  // Flashing is its own action: an image of a market, a link, or an SDK's build, with what it would write shown first.
  const canFlash = !!board.lab?.canFlashPackage || sdks.length > 0
  const flashDialog = () => ui.layer(close => <FlashDialog board={board} close={close} onPackage={pkg => void act.flashPackage(pkg)}
    onSdk={sdk => { saveBoot(board.name, { sdk, method: 'download' }); void act.boot(sdk, 'download') }} />, 'wide')
  const renameDialog = () => ui.layer(close => <RenameDialog board={board} close={close} />)
  const relay = () => ui.layer(close => <RelayDialog board={board} close={close} />, 'wide')
  const extra = viewsFor(state, 'board', { board: board.name })
  const lab = state.labs.find(l => l.id === board.lab?.id)
  // A busy board, or one someone else holds, cannot be renamed: say why on the disabled item.
  const canRename = (m.lock === 'free' || m.mine) && !m.flags.busy
  const renameWhy = canRename ? undefined
    : m.flags.busy ? `${board.name} 正在${m.flags.busy.label.replace(/中$/, '')}，等它完成`
    : m.holder ? `${holder(m.holder).name} 拿着锁，名字要由 TA 改；或者等它空闲`
    : '实验室占用时不能改名，等它空闲'

  const tiles: Array<[string, string, string, string, () => void, boolean]> = [
    ['reset', 'power', '复位', 'R', act.reset, true], ['fastboot', 'zap', '下载模式', 'D', act.fastboot, true], ['boot', 'rocket', '启动', 'B', bootDialog, true],
    ...(canFlash ? [['flash', 'flash', '刷机', 'W', flashDialog, true] as [string, string, string, string, () => void, boolean]] : []),
    ...(lab?.canRelay ? [['relay', 'plug', '继电器', '', relay, true] as [string, string, string, string, () => void, boolean]] : []),
    ['logs', 'dl', '日志', '', openLogs, false],
  ]
  const sub: Record<string, string> = { reset: '约 3 秒', fastboot: '停在 boot ROM 等文件', boot: last?.method === 'load' ? `上次：${last.sdk}` : '内存启动，不动存储', flash: board.lab?.canFlashPackage ? '镜像市场、链接或 SDK' : '用 SDK 的产物', relay: '电源、复位、BOOT 键', logs: '搜索、下载、wget' }

  return <>
    <div className="side-top"><a className="back" href="#/"><Icon name="back" />板子</a>
      <div className="menu" onClick={e => e.stopPropagation()}>
        <button className="pill sm icon" aria-label="更多" onClick={() => setMenu(!menu)}><Icon name="more" /></button>
        {menu && <div className="pop" onClick={() => setMenu(false)}>
          {board.lab?.canRefresh && <button disabled={!m.mine} title={m.mine ? undefined : '先拿锁'} onClick={act.refresh}><Icon name="rebuild" />重新读取型号</button>}
          <button disabled={!canRename} title={renameWhy} onClick={renameDialog}><Icon name="doc" />给板子改名…</button>
          <button onClick={() => prefs.watch(board.name, !watchedOn)}><Icon name="bell" />{watchedOn ? '不再关注' : '空闲时通知我'}</button>
          <button onClick={() => void copyText(ui, `boardlab lock ${board.name} && boardlab console ${board.name}`, '复制了命令')}><Icon name="copy" />复制 boardlab 命令</button>
          {board.lease && !m.mine && <button className="danger" onClick={act.steal}><Icon name="warn" />抢锁…</button>}
          {lab?.canRemove && <><hr /><button className="danger" disabled={!!board.lease} title={board.lease ? '有人拿着锁时不能移除' : undefined} onClick={act.remove}><Icon name="x" />移除这块板子</button></>}
        </div>}
      </div>
    </div>
    <BoardSwitch state={state} board={board} />
    <div className="bwhere">{where(board)}{board.product ? ` · ${board.product}` : ''}</div>
    <Flags board={board} m={m} act={act} />
    <LockBox state={state} board={board} m={m} act={act} />
    {m.lock !== 'empty' && <>
      <div className="controls">{tiles.map(([key, icon, label, kbd, go, needsLock]) => {
        // Booting and flashing are both a `boot` run on the board: the run's own label says which tile started it, and both wait for it.
        const starts = key === 'boot' || key === 'flash'
        const run = act.busy === 'boot' || (!!m.flags.booting && m.mine) ? (board.busy?.label === '刷机中' ? 'flash' : 'boot') : null
        const locked = needsLock && !m.mine, spinning = starts ? run === key : act.busy === key
        const off = locked || (needsLock && m.flags.gone) || (needsLock && !!act.busy && !(starts && act.busy === 'boot') && act.busy !== key) || (starts && (!!m.flags.booting || act.busy === 'boot'))
        return (
          <button key={key} className={`ctl${spinning ? ' busy' : ''}`} disabled={off || spinning} onClick={go}>
            <Icon name={icon} /><div><b>{label}{kbd && m.mine && <kbd>{kbd}</kbd>}</b><span>{spinning ? '进行中…' : locked ? '先拿锁' : sub[key]}</span></div>
            {spinning ? <i className="corner"><span className="spin" /></i> : locked ? <i className="corner"><Icon name="lock" /></i> : null}
          </button>
        )
      })}</div>
      {m.mine && last?.method === 'load' && sdks.includes(last.sdk) && !m.flags.booting && <button className="pill sm" style={{ marginTop: 8, width: '100%' }} disabled={!!act.busy} onClick={() => void act.boot(last.sdk, 'load')}><Icon name="rebuild" />再来一次：{last.sdk} · 内存启动</button>}
    </>}
    {extra.map(view => <div key={view.id} style={{ marginTop: 10 }}><ViewPanel view={view} /></div>)}
    <div className="sect">这块板子</div><Facts board={board} />
    <div className="sect">最近</div>
    {!detail?.actions.length ? <div className="sub small">还没有记录。</div> : <div>{detail.actions.slice(0, 6).map(a => (
      <div key={a.id} className="act"><time>{hhmm(a.at)}</time><div><Who id={a.actor} you={state.you} max={18} tag={false} /> <span>{ACTIONS[a.kind] ?? a.kind}{a.detail ? ` · ${a.detail}` : ''}</span>{!a.ok && <> <span className="tag bad">失败</span></>}{a.message && <div className="m" title={a.message}>{a.message}</div>}</div></div>
    ))}<a className="more" href={`#/history?board=${encodeURIComponent(board.name)}`}>全部历史<Icon name="chev" /></a></div>}
  </>
}

/**
 * Whatever boardd is doing to the board can be stopped when it says so (`busy.cancellable`), by the lock's holder, or
 * by anyone while nobody holds the board (a lab's search, a load whose lock was given back).
 */
export const canStop = (board: Board, m: Model) => !!m.flags.busy?.cancellable && (m.mine || !board.lease)

function Flags({ board, m, act }: { board: Board, m: Model, act: ReturnType<typeof useBoardActions> }) {
  const ended = lastRun(board)
  return <>
    {ended && <div className={`flag ${ended.tone === 'bad' ? 'bad' : 'attn'} last-run`}><Icon name="warn" /><div><b>{ended.title}</b><span>{ended.text}</span></div></div>}
    {m.flags.attn && <div className="flag attn"><Icon name="hand" /><div><b>等人操作 · {where(board)}</b><span>{m.flags.attn}</span></div>{m.canConfirm && <button className="pill sm dark" disabled={act.has('confirm')} onClick={act.confirm}>{act.has('confirm') ? <span className="spin" /> : <Icon name="check" />}我操作好了</button>}</div>}
    {m.flags.gone && <div className="flag bad"><Icon name="warn" /><div><b>串口离线</b><span>{slotOf(board).host} 上找不到这块板子的串口。最近重新布线过的话，重新发现这台主机（在用的板子不受影响）。</span></div><button className="pill sm" onClick={canRediscover(board) ? act.rediscover : act.rebuild}><Icon name="rebuild" />{canRediscover(board) ? '重新发现' : '重建'}</button></div>}
    {m.flags.progress && <div className="flag run"><span className="spin" /><div><b>{m.flags.progress}</b>{m.flags.pct != null && <div className="bar2"><i style={{ width: `${m.flags.pct}%` }} /></div>}</div>
      {canStop(board, m) && <button className="pill sm" disabled={act.has('cancel')} onClick={act.cancel}>{act.has('cancel') ? <span className="spin" /> : <Icon name="x" />}取消</button>}</div>}
    {m.flags.offline && <div className="flag"><Icon name="plug" /><div><b>串口不在线</b><span>板子可能没上电，或者串口线松了。</span></div></div>}
    {m.flags.error && <div className="flag bad"><Icon name="warn" /><div><b>锁和实验室对不上</b><span>{m.flags.error}</span></div></div>}
  </>
}

function LockBox({ state, board, m, act }: { state: PageState, board: Board, m: Model, act: ReturnType<typeof useBoardActions> }) {
  const [purpose, setPurpose] = useState('')
  const waiters = board.waiters.length ? <div className="waiters"><div className="sub">{board.waiters.length} 人在排队</div>{board.waiters.map((w, i) => <div key={w.holder}><span className="n">{i + 1}</span><Who id={w.holder} you={state.you} max={20} /><span className="sub ell">{w.purpose}</span></div>)}</div> : null
  if (m.lock === 'mine') return (
    <div className="tilebox dark"><div className="lbl"><span className="dot yours" />你持有锁</div><div className="big"><Ticking fn={() => clock(m.since!)} /></div>
      <div className="sub">{m.purpose || '没写目的'} · {hhmm(m.since!)} 拿的</div>{waiters}
      <div className="acts"><button className="pill dark" disabled={!!act.busy} onClick={act.unlock}>{act.busy === 'unlock' ? <span className="spin" /> : <Icon name="unlock" />}{board.waiters[0] ? `释放，交给 ${holder(board.waiters[0].holder).name}` : '释放锁'}</button></div></div>
  )
  if (m.lock === 'busy' || m.lock === 'lab') return (
    <div className="tilebox"><div className="lbl"><span className="dot" />{m.lock === 'lab' ? '实验室占用' : '使用中'}</div>
      {m.holder && <div className="holder"><Who id={m.holder} you={state.you} full /></div>}{m.purpose && <div className="purpose">{m.purpose}</div>}
      {m.since && <div className="sub small">已用 <Ticking fn={() => age(m.since)} /> · {hhmm(m.since)} 起</div>}{waiters}
      {m.lock === 'busy' && <div className="acts">{m.queued ? <button className="pill" onClick={act.unqueue}><Icon name="x" />不排了（第 {m.queued} 位）</button> : <button className="pill dark" onClick={act.queue}><Icon name="queue" />排队</button>}
        <button className="pill ghost" onClick={act.steal}>抢锁…</button></div>}</div>
  )
  if (m.lock === 'empty') return <div className="tilebox"><div className="lbl">{m.flags.busy ? <><span className="spin" />{m.flags.busy.label}</> : '空槽位'}</div>
    <p>{m.flags.busy ? <>{holder(m.flags.busy.by).name} {hhmm(m.flags.busy.since)} 开始{m.flags.busy.line ? <>：<span className="mono">{m.flags.busy.line}</span></> : '，等第一条进展'}</> : '这个槽位现在没有板子。插上板子后，让 boardd 在这个槽位上找一下。'}</p>
    <div className="acts"><button className="pill dark" disabled={!!act.busy} onClick={act.discoverSlot}>{act.busy === 'discover' ? <span className="spin" /> : <Icon name="radar" />}{act.busy === 'discover' ? '发现中…' : '发现这块板'}</button></div></div>
  return (
    <div className="tilebox"><div className="lbl"><span className="dot ok" />空闲</div><p>拿锁时说一下用来做什么，别人看得到：</p>
      <div className="chips">{PURPOSES.map(p => <button key={p} className={`chip${purpose === p ? ' on' : ''}`} onClick={() => setPurpose(p)}>{p}</button>)}</div>
      <input className="input" value={purpose} onChange={e => setPurpose(e.target.value)} placeholder="或者自己写一句" onKeyDown={e => { if (e.key === 'Enter' && purpose.trim()) void act.lockWith(purpose.trim()) }} />
      <div className="acts"><button className="pill dark" disabled={!purpose.trim() || !!act.busy} onClick={() => void act.lockWith(purpose.trim())}>{act.busy === 'lock' ? <span className="spin" /> : <Icon name="lock" />}拿锁</button></div></div>
  )
}

function Facts({ board }: { board: Board }) {
  const { host, slot } = slotOf(board), mb = board.lab?.mediaBoot
  const after = !mb ? null : mb.method === 'reset' ? '从介质启动' : mb.available ? `经 ${mb.method} 从介质启动` : `停在下载模式（${mb.why}）`
  const rows: Array<[string, ReactNode]> = [
    ['主机', host], ['槽位', slot.toUpperCase()], ['SoC', board.soc?.toUpperCase()], ['型号', <ModelEditor board={board} />],
    ['串口', board.chips.map(c => `${c.die}${c.serialPath ? ` ${c.serialPath}` : ''} · ${c.baud}${c.online ? '' : '（不在线）'}`).join('\n') || null],
    ['下载口', board.chips.map(c => c.downloadUsbPath).filter(Boolean).map(p => `usb:${p}`).join('、') || null],
    ['SDK', board.lab?.sdks?.join('、')], ['复位后', after], ['登记名', board.name],
  ]
  return <dl className="facts">{rows.filter(([, v]) => v).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
}

/** The model, editable where the facts show it: saved on Enter or 保存, remembered for the datalist, empty clears it. */
function ModelEditor({ board }: { board: Board }) {
  const ui = useUI()
  const [models, setModels] = useState<string[]>([])
  const [value, setValue] = useState(board.product ?? '')
  const [busy, setBusy] = useState(false)
  const list = `models-${board.name}`
  useEffect(() => { setValue(board.product ?? '') }, [board.product])
  useEffect(() => { let live = true; void api.models().then(got => { if (live) setModels(got) }).catch(() => {}); return () => { live = false } }, [])
  const save = async () => {
    const product = value.trim() || null
    if (busy || product === (board.product ?? null)) return
    setBusy(true)
    try {
      await api.setModel(board.name, product)
      ui.toast(product ? `型号：${product}` : `清掉了 ${upper(board.name)} 的型号`, board.name)
      setModels(await api.models().catch(() => models))
    } catch (error) { ui.fail('型号没存上', error) } finally { setBusy(false) }
  }
  const unchanged = value.trim() === (board.product ?? '')
  return (
    <span className="model-edit">
      <input className="input" list={list} value={value} placeholder="型号，例如 k1-x_deb1" onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void save() } }} />
      <datalist id={list}>{models.map(m => <option key={m} value={m} />)}</datalist>
      <button className="pill sm" disabled={busy || unchanged} title="保存型号（会记下来，下次可以选）" onClick={() => void save()}>{busy ? <span className="spin" /> : <Icon name="check" />}保存</button>
    </span>
  )
}

function RenameDialog({ board, close }: { board: Board, close: () => void }) {
  const ui = useUI()
  const [to, setTo] = useState(board.name)
  const [busy, setBusy] = useState(false)
  // The brief hint under the field: a lab board keeps its device name at the lab, and the name here is what a person sees.
  const prefix = board.lab ? `${board.lab.id}-` : ''
  const wanted = to.trim()
  const submit = async () => {
    if (!wanted || busy) return
    setBusy(true)
    try {
      const out = await api.renameBoard(board.name, wanted)
      close()
      ui.toast('改名好了', out?.message)
      const after = out?.board || wanted
      if (after !== board.name) location.hash = `#/board/${encodeURIComponent(after)}`
      await refreshNow().catch(() => {})
    } catch (error) { ui.fail('改名失败', error); setBusy(false) }
  }
  return <form onSubmit={event => { event.preventDefault(); void submit() }}>
    <h2>给板子改名</h2>
    <p className="lead"><b>{upper(board.name)}</b> · 板子的名字、串口名、锁、队列和历史会一起改，别人的页面也会跟着变。</p>
    <label className="field">新名字<input className="input" autoFocus value={to} onChange={event => setTo(event.target.value)} /></label>
    {prefix && <span className="sub small" style={{ display: 'block', marginTop: 6 }}>改成什么就叫什么，不会自动加 {prefix} 前缀；实验室那边仍记它自己的名字。</span>}
    <div className="foot"><button type="button" className="pill" onClick={close}>取消</button>
      <button className="pill dark" disabled={busy || !wanted || wanted === board.name}>{busy ? <span className="spin" /> : <Icon name="check" />}改名</button></div>
  </form>
}

function BootDialog({ board, close, onStart }: { board: Board, close: () => void, onStart: (sdk: string, brk?: string) => void }) {
  const sdks = board.lab?.sdks ?? [], last = lastBoot(board.name)
  const [sdk, setSdk] = useState(last?.sdk && sdks.includes(last.sdk) ? last.sdk : sdks[0] ?? '')
  // Break points of the SDK's recipe (`breaker:` steps): boot U-Boot alone, say.
  // The state starts from what the page already read (or null, still reading) so opening the dialog again is instant.
  const [breaks, setBreaks] = useState<string[] | null>(() => sdk ? cachedBreaks(board.name, sdk) : null)
  const [brk, setBrk] = useState('')
  useEffect(() => {
    setBrk('')
    if (!sdk) { setBreaks([]); return }
    setBreaks(cachedBreaks(board.name, sdk))
    let live = true
    void readBreaks(board.name, sdk).then(list => { if (live) setBreaks(list) }).catch(() => { if (live) setBreaks([]) })
    return () => { live = false }
  }, [board.name, sdk])
  const start = () => { close(); onStart(sdk, brk || undefined) }
  return <>
    <h2>启动</h2><p className="lead"><b>{upper(board.name)}</b> · 用一个 SDK 编好的产物经下载口加载到内存启动，不动存储；复位就没了。要写进存储，用「刷机」。</p>
    {sdks.length ? <label className="field">SDK<select className="select" value={sdk} onChange={e => setSdk(e.target.value)}>{sdks.map(s => <option key={s}>{s}</option>)}</select></label>
      : <div className="mv-note warn">这块板子没有登记可用的 SDK：先在它的登记里选好 SoC 或 SDK。</div>}
    {(breaks === null || breaks.length > 0) && <label className="field">停在哪
      {breaks === null ? <span className="sub small">读取中…</span> : <>
        <div className="chips">
          <button className={`chip${brk === '' ? ' on' : ''}`} onClick={() => setBrk('')}>完整启动</button>
          {breaks.map(name => <button key={name} className={`chip${brk === name ? ' on' : ''}`} onClick={() => setBrk(name)}>停在 {name}</button>)}
        </div>
        <span className="sub small">只启动到这一步，之后自己在串口里操作（调 U-Boot 或内核时用）。</span>
      </>}
    </label>}
    <div className="foot"><button className="pill" onClick={close}>取消</button><button className="pill dark" disabled={!sdk} onClick={start}><Icon name="rocket" />开始</button></div>
  </>
}

const RELAY: Record<string, string> = { on: '通', off: '断', toggle: '切换', pulse: '断一下', press: '按住', release: '松开', click: '按一下' }
function RelayDialog({ board, close }: { board: Board, close: () => void }) {
  const ui = useUI()
  const [channels, setChannels] = useState<BoardChannels | null>(null)
  const [ms, setMs] = useState('300')
  const load = () => void api.channels(board.name).then(setChannels).catch(e => ui.fail('读不到继电器', e))
  useEffect(load, [board.name])
  const fire = (channel: string, action: string) => void api.setChannel(board.name, channel, action, action === 'pulse' || action === 'click' ? Number(ms) || null : null)
    .then(out => { ui.toast(`${channel}：${RELAY[action] ?? action}`, out.message); load() }, e => ui.fail(`${channel}：${RELAY[action] ?? action}失败`, e))
  return <>
    <h2>继电器</h2><p className="lead"><b>{upper(board.name)}</b> · 直接拨这块板子的电源和按键。</p>
    {!channels ? <p className="sub">读取中…</p> : !channels.supported || !channels.channels.length ? <div className="mv-note">这块板子没有可以拨的通道。</div>
      : <div className="mv-list">{channels.channels.map(c => (
        <div key={c.id}><div className="grow"><b style={{ textTransform: 'uppercase', letterSpacing: '.05em' }}>{c.label}</b> <span className="sub small">{c.kind}{c.state ? ` · ${c.state}` : ''}</span></div>
          <div className="chips">{c.actions.map(a => <button key={a} className="chip" onClick={() => fire(c.id, a)}>{RELAY[a] ?? a}</button>)}</div></div>
      ))}</div>}
    <label className="field">「断一下」「按一下」的时长（毫秒）<input className="input" inputMode="numeric" value={ms} onChange={e => setMs(e.target.value)} /></label>
    <div className="foot"><button className="pill" onClick={close}>关闭</button></div>
  </>
}
