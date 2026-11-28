/**
 * What a person can do to a board, the same from a card, a list row and the board page: every call goes to boardd,
 * spins its button, and shows boardd's own message when it fails. Hardware-touching actions ask first and say what
 * will happen.
 */
import { useState, type ReactNode } from 'react'
import { api, isCancelled } from '../../src/ui/api.ts'
import { PURPOSES } from '../../src/ui/format.ts'
import type { Board, LabSettings } from 'boardlab-core/shared/types.ts'
import { Confirm, Icon, holder, refreshNow, setAsked, slotOf, upper, useAsked, useUI, Who } from './kit.tsx'
import { DiscoverBoardDialog } from './discover.tsx'

let current: { boards: Board[], you: string, rediscover: Set<string>, labs: LabSettings[] } = { boards: [], you: '', rediscover: new Set(), labs: [] }
/** The page tells the actions the latest state (who you are, every board, which labs can rediscover). */
export function setActionState(boards: Board[], you: string, rediscover: string[] = [], labs: LabSettings[] = []) { current = { boards, you, rediscover: new Set(rediscover), labs } }
export const canRediscover = (board: Board) => !!board.lab && current.rediscover.has(board.lab.id)

function PurposeDialog({ board, queue, close, onDone }: { board: Board, queue: boolean, close: () => void, onDone: (purpose: string) => Promise<void> }) {
  const [purpose, setPurpose] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => { if (!purpose.trim()) return; setBusy(true); try { await onDone(purpose.trim()); close() } finally { setBusy(false) } }
  return (
    <form onSubmit={e => { e.preventDefault(); void submit() }}>
      <h2>{queue ? '排队' : '拿锁'}</h2>
      <p className="lead"><b>{upper(board.name)}</b> · {queue ? <>现在由 <Who id={board.lease?.holder ?? board.lab?.heldBy ?? ''} you={current.you} full /> 使用。轮到你时 boardd 把锁交给你并通知你。</> : '说一下用来做什么，别人看得到。用完请释放，有人排队时自动交给下一位。'}</p>
      <div className="chips">{PURPOSES.map(p => <button type="button" key={p} className={`chip${purpose === p ? ' on' : ''}`} onClick={() => setPurpose(p)}>{p}</button>)}</div>
      <label className="field">目的<input className="input" autoFocus value={purpose} onChange={e => setPurpose(e.target.value)} placeholder="例如：调 PCIe 枚举" /></label>
      <div className="foot"><button type="button" className="pill" onClick={close}>取消</button>
        <button className="pill dark" disabled={busy || !purpose.trim()}>{busy ? <span className="spin" /> : <Icon name={queue ? 'queue' : 'lock'} />}{queue ? '排队' : '拿锁'}</button></div>
    </form>
  )
}

/**
 * A flash package: a link the board's backend downloads itself, a file sent to boardd first (its sha256), or an image
 * of a market by its place there. Only the
 * chosen partitions are written when some are given, and the board is reset after when asked.
 */
export interface FlashPackage { url?: string, sha256?: string, image?: { market: string, path: string }, flasher?: string, partitions?: string[], layout?: string, reset?: boolean }

/** boardd's operations (`Board.busy.kind`) as the buttons that start them. */
const SERVER: Record<string, string> = { reset: 'reset', fastboot: 'fastboot', boot: 'boot', stage: 'boot', refresh: 'refresh', remove: 'remove', discover: 'discover', rebuild: 'rebuild', lock: 'lock' }

/**
 * A person stepping in on a board someone else holds: the panel's operations are theirs for one action, and then boardd
 * gives the board back to nobody. Whoever holds it loses it — a run of theirs stops — so the dialog says what it costs
 * in the holder's own terms and makes the person confirm it twice: the danger button, then the same warning again.
 */
function ForceTake({ board, close, onTake }: { board: Board, close: () => void, onTake: () => void }) {
  const [sure, setSure] = useState(false)
  const who = <Who id={board.lease?.holder ?? ''} you={current.you} full />
  return (
    <div className="force-take">
      <h2 className="danger-t"><Icon name="warn" />强制解锁？</h2>
      <div className={`force-warn${sure ? ' sure' : ''}`}>
        <p><b>{upper(board.name)}</b> 现在由 {who} 使用，正在做：{board.lease?.purpose || '（没写）'}。</p>
        <p>强制解锁会<b>马上夺走它的锁</b>：它正在做的操作会停下，它会在命令行里看到锁被拿走。<b>后果由你负责。</b></p>
        <p>解开后你能操作这块板子的整个面板——可以复位、刷机、往串口打字——<b>只限一个动作</b>；这个动作一结束，锁自动放回空着，谁也不持有。</p>
      </div>
      {!sure
        ? <div className="foot"><button type="button" className="pill" onClick={close}>取消</button>
            <button type="button" className="pill danger" onClick={() => setSure(true)}><Icon name="warn" />强制解锁</button></div>
        : <>
            <p className="force-again"><Icon name="warn" /><b>真的确定？</b>按下去，{who} 现在做的事就被打断了，没有撤销。</p>
            <div className="foot"><button type="button" className="pill" onClick={() => { setSure(false); close() }}>算了</button>
              <button type="button" className="pill danger" onClick={() => { close(); onTake() }}><Icon name="warn" />确定，夺走它的锁</button></div>
          </>}
    </div>
  )
}

export function useBoardActions(board: Board) {
  const ui = useUI()
  // Busy while this page waits on boardd, or while boardd runs something on the board for anyone: every button that
  // would start another operation is off until it ends. Confirming a person's step stays open (a running reset may be
  // waiting for exactly that), and the operation it confirms stays the one shown.
  const pending = useAsked(board.name)
  const has = (key: string) => pending.includes(key)
  const busy = pending.find(key => key !== 'confirm') ?? pending[0] ?? (board.busy ? SERVER[board.busy.kind] ?? board.busy.kind : null)
  const name = upper(board.name), host = slotOf(board).host, labId = board.lab?.id ?? ''
  const run = async (key: string, label: string, fn: () => Promise<unknown>, done?: string) => {
    setAsked(board.name, key, true)
    try { const out = await fn() as { message?: string } | undefined; ui.toast(done ?? `${name} · ${label}好了`, out && typeof out === 'object' && out.message ? out.message : undefined) }
    // A cancelled operation is neither done nor failed: boardd says it was stopped.
    catch (error) { if (isCancelled(error)) ui.toast(`${name} · ${label}已取消`, (error as Error).message); else ui.fail(`${name} · ${label}失败`, error) }
    finally { await refreshNow().catch(() => {}); setAsked(board.name, key, false) }
  }
  const ask = (title: string, body: ReactNode, ok: string, go: (reason: string) => void, opts: { danger?: boolean, reason?: string } = {}) =>
    ui.layer(close => <Confirm title={title} ok={ok} danger={opts.danger} reason={opts.reason} close={close} onOk={go}>{body}</Confirm>)
  const mb = board.lab?.mediaBoot

  return {
    busy, has,
    lock: () => ui.layer(close => <PurposeDialog board={board} queue={false} close={close} onDone={async purpose => {
      setAsked(board.name, 'lock', true)
      try { const out = await api.lock(board.name, purpose); ui.toast(out.queued ? `${name} 刚被人拿走了` : `拿到了 ${name}`, out.queued ? `已经帮你排队，第 ${out.queued.position} 位` : purpose) } catch (e) { ui.fail(`拿不到 ${name} 的锁`, e) }
      finally { await refreshNow().catch(() => {}); setAsked(board.name, 'lock', false) }
    }} />),
    lockWith: (purpose: string) => run('lock', '拿锁', () => api.lock(board.name, purpose), `拿到了 ${name}`),
    queue: () => ui.layer(close => <PurposeDialog board={board} queue close={close} onDone={async purpose => {
      try { const out = await api.queue(board.name, purpose); ui.toast(`排上了 ${name}`, out.queued ? `第 ${out.queued.position} 位，轮到你时通知你` : undefined) } catch (e) { ui.fail(`排不上 ${name}`, e) }
    }} />),
    unqueue: () => run('unqueue', '退出排队', () => api.unqueue(board.name), `不排 ${name} 了`),
    unlock: () => run('unlock', '释放', () => api.unlock(board.name), board.waiters[0] ? `释放了 ${name}，锁交给了 ${holder(board.waiters[0].holder).name}` : `释放了 ${name}`),
    steal: () => ask(`抢 ${name} 的锁`, <>现在由 <Who id={board.lease?.holder ?? ''} you={current.you} full /> 使用（{board.lease?.purpose}）。对方会收到通知，Claude 会在命令行里看到理由。只在对方确实不用了的时候抢。</>,
      '抢锁', reason => void run('steal', '抢锁', () => api.steal(board.name, reason), `抢到了 ${name}`), { danger: true, reason: '理由（对方会看到）' }),
    forceTake: () => ui.layer(close => <ForceTake board={board} close={close} onTake={() => {
      setAsked(board.name, 'force-take', true)
      api.forceTake(board.name)
        .then(() => ui.toast(`${name} 是你的了`, '现在可以操作面板。这一动作结束，锁自动放回空着。'))
        .catch(error => ui.fail(`没能接管 ${name}`, error))
        .finally(() => { void refreshNow().catch(() => {}); setAsked(board.name, 'force-take', false) })
    }} />),
    reset: () => ask('复位', <>复位 <b>{name}</b>，板子会立即重启。{mb && !mb.available && <><br /><span className="warn-t">复位后它会停在下载模式：{mb.why}</span></>}</>, '复位', () => void run('reset', '复位', () => api.reset(board.name))),
    fastboot: () => ask('进下载模式', <>让 <b>{name}</b> 重启进 boot ROM，停在那里等下载文件。</>, '进下载模式', () => void run('fastboot', '进下载模式', () => api.fastboot(board.name))),
    // The lab's id for this ask goes with it: a click after it already saw the board arrive is answered, not an error.
    confirm: () => void run('confirm', '确认', () => api.confirm(board.name, board.lab?.attentionRequest ?? null), `${name} 继续了`),
    boot: (sdk: string, method: 'load' | 'download', brk?: string) => run('boot', method === 'load' ? '内存启动' : '刷机', () => api.bootSdk(board.name, sdk, method, brk)),
    cancel: () => run('cancel', '取消', () => api.cancel(board.name), `${name} 正在停下`),
    flashPackage: (pkg: FlashPackage) => run('boot', '刷机', () => api.flashPackage(board.name, {
      ...(pkg.image ? { image: pkg.image } : pkg.sha256 ? { sha256: pkg.sha256 } : { url: pkg.url }), flasher: pkg.flasher || undefined,
      ...(pkg.partitions?.length ? { partitions: pkg.partitions } : {}), ...(pkg.layout ? { layout: pkg.layout } : {}), ...(pkg.reset ? { reset: true } : {}),
    })),
    refresh: () => ask(`重新读取 ${name}`, '复位板子，从 EEPROM 读型号；换了板子时用。', '读取', () => void run('refresh', '重新读取', () => api.refresh(board.name, {}))),
    remove: () => ask(`移除 ${name}`, '只删登记，不碰板子。以后可以重新发现。', '移除', () => void run('remove', '移除', () => api.removeBoard(board.name), `移除了 ${name}`), { danger: true }),
    discoverSlot: () => {
      const lab = current.labs.find(item => item.id === labId)
      if (!lab) return ui.fail('不能发现', '这块板子的实验室不在了', true)
      ui.layer(close => <DiscoverBoardDialog lab={lab} host={host} slot={`${host}/${slotOf(board).slot}`} close={close} />)
    },
    rediscover: () => ask(`重新发现 ${host}`, <>保留在用的板子，忘掉串口不见的（比如 <b>{name}</b>），给新接上的串口建槽位并在空闲串口上找板子。只会复位没人用的复位线。</>,
      '重新发现', () => void run('rebuild', '重新发现', () => api.rebuildLab(labId, host, true), `${host} 重新发现好了`)),
    rebuild: () => {
      const on = current.boards.filter(b => b.lab?.id === labId && slotOf(b).host === host), held = on.filter(b => b.lease || b.lab?.heldBy)
      if (held.length) return ui.fail(`现在不能重建 ${host}`, `${held.map(b => upper(b.name)).join('、')} 有锁，要等释放`)
      ask(`重建 ${host}`, <>boardd 会<b>忘掉</b>这台主机上的板子和槽位，然后复位每条复位线，按现在的接线重新对出串口和下载口：
        <ul className="blist">{on.map(b => <li key={b.name}>{b.lab?.empty ? `空槽位 ${slotOf(b).slot}` : `${upper(b.name)} · ${slotOf(b).slot}`}</li>)}</ul>认出来的板子沿用原名。</>,
        '重建', () => void run('rebuild', '重建', () => api.rebuildLab(labId, host), `${host} 重建好了`), { danger: true })
    },
  }
}
