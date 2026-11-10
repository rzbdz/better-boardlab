/** Home: a one-line summary, filters, and the boards as cards, by host (with every slot), or as a dense list. */
import { useState } from 'react'
import { api, type PageState } from '../../../src/ui/api.ts'
import { prefs } from '../../../src/ui/notify.ts'
import type { Board } from 'boardlab-core/shared/types.ts'
import { age, clock, Icon, middle, model, slotOf, Ticking, upper, useUI, Who, type Model } from '../kit.tsx'
import { canRediscover, useBoardActions } from '../actions.tsx'

type Filter = 'all' | 'free' | 'mine' | 'need'
type Layout = 'cards' | 'hosts' | 'list'
const LAYOUT_KEY = 'boardlab.modern.layout'

export function HomePage({ state, watched, open }: { state: PageState, watched: string[], open: (board: string) => void }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [layout, setLayoutState] = useState<Layout>(() => { try { return (localStorage.getItem(LAYOUT_KEY) as Layout) || 'cards' } catch { return 'cards' } })
  const setLayout = (next: Layout) => { setLayoutState(next); try { localStorage.setItem(LAYOUT_KEY, next) } catch {} }
  const [query, setQuery] = useState('')
  const you = state.you
  const ms = new Map(state.boards.map(b => [b.name, model(b, you)]))
  const m = (b: Board) => ms.get(b.name)!
  const FILTERS: Record<Filter, [string, (x: Model, b: Board) => boolean]> = {
    // Empty slots show under 全部 (to discover a board into) but are not counted as boards.
    all: ['全部', () => true],
    free: ['空闲', x => x.lock === 'free' && !x.flags.gone && !x.flags.attn],
    mine: ['我的', (x, b) => x.mine || b.waiters.some(w => w.holder === you) || watched.includes(b.name)],
    need: ['需要处理', x => !!x.flags.attn || x.flags.gone],
  }
  const q = query.trim().toLowerCase()
  const match = (b: Board) => !q || [b.name, upper(b.name), b.product, b.slotRef, b.lease?.holder, b.lease?.purpose].join(' ').toLowerCase().includes(q)
  // Stable order: yours first, then by host and slot, so a card never jumps when its state changes.
  const order = (list: Board[]) => [...list].sort((a, b) => Number(m(b).mine) - Number(m(a).mine) || (a.slotRef ?? a.name).localeCompare(b.slotRef ?? b.name, 'en', { numeric: true }))
  const shown = order(state.boards.filter(b => (layout === 'hosts' || FILTERS[filter][1](m(b), b)) && match(b)))
  const real = state.boards.filter(b => !b.lab?.empty).map(m)
  const n = (f: (x: Model) => boolean) => real.filter(f).length

  return (
    <div className="page">
      <section className="hero"><h1>板子</h1>
        <p>{real.length} 块，<b>{n(x => x.lock === 'free' && !x.flags.gone && !x.flags.attn)} 块空闲</b>{n(x => x.mine) ? `，你在用 ${n(x => x.mine)} 块` : ''}
          {n(x => !!x.flags.attn) ? <>，<b className="warn-t">{n(x => !!x.flags.attn)} 块等人操作</b></> : null}{n(x => x.flags.gone) ? `，${n(x => x.flags.gone)} 块串口离线` : ''}</p></section>
      <div className="bar">
        {layout !== 'hosts' && <div className="seg">{(Object.keys(FILTERS) as Filter[]).map(k => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{FILTERS[k][0]}<em>{state.boards.filter(b => m(b).lock !== 'empty' && FILTERS[k][1](m(b), b)).length}</em></button>)}</div>}
        <div className="seg" aria-label="排列">{([['cards', 'grid', '卡片'], ['hosts', 'server', '按主机'], ['list', 'queue', '列表']] as const).map(([k, ic, l]) => <button key={k} className={layout === k ? 'on' : ''} onClick={() => setLayout(k)}><Icon name={ic} />{l}</button>)}</div>
        <label className="find"><Icon name="search" /><input id="board-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="板子、主机、持有人、目的"
          onKeyDown={e => { if (e.key === 'Enter' && shown.length === 1) open(shown[0]!.name) }} /><kbd>/</kbd></label>
      </div>
      {!shown.length ? <div className="empty-state"><Icon name="search" /><p>没有符合的板子</p><button className="pill sm" onClick={() => { setFilter('all'); setQuery('') }}>看全部</button></div>
        : layout === 'hosts' ? <Lanes state={state} boards={shown} m={m} watched={watched} open={open} />
        : layout === 'list' ? <div className="list">{shown.map(b => <Row key={b.name} board={b} m={m(b)} you={you} watched={watched} open={open} />)}</div>
        : <div className="wall">{shown.map(b => <Card key={b.name} board={b} m={m(b)} you={you} watched={watched} open={open} />)}</div>}
    </div>
  )
}

function Actions({ board, m, watched, open }: { board: Board, m: Model, watched: string[], open: (board: string) => void }) {
  const act = useBoardActions(board)
  const ui = useUI()
  const on = watched.includes(board.name)
  const look = (icon = 'eye', title = '看串口') => <button className="pill icon" title={title} aria-label={title} onClick={() => open(board.name)}><Icon name={icon} /></button>
  const watch = <button className={`pill icon${on ? ' on' : ''}`} title={on ? '不再关注' : '空闲时通知我'} aria-label={on ? '不再关注' : '关注'} onClick={() => { prefs.watch(board.name, !on); ui.toast(on ? `不再关注 ${upper(board.name)}` : `关注了 ${upper(board.name)}`, on ? '' : '它空出来时通知你') }}><Icon name="bell" /></button>
  const confirm = m.flags.attn && m.canConfirm ? <button className="pill dark" disabled={!!act.busy} onClick={act.confirm}><Icon name="check" />我操作好了</button> : null
  if (m.lock === 'empty') return <button className="pill" onClick={act.discoverSlot}><Icon name="radar" />发现这块板</button>
  if (m.lock === 'mine') return <>{confirm ?? <button className="pill dark" disabled={!!act.busy} onClick={act.unlock}>{act.busy === 'unlock' && <span className="spin" />}释放</button>}<span className="sp" />
    {!m.flags.gone && <button className="pill icon" title="复位" aria-label="复位" disabled={!!act.busy} onClick={act.reset}>{act.busy === 'reset' ? <span className="spin" /> : <Icon name="power" />}</button>}{look('term', '串口')}</>
  if (m.flags.gone) return <><button className="pill" onClick={canRediscover(board) ? act.rediscover : act.rebuild}><Icon name="rebuild" />{canRediscover(board) ? '重新发现' : '重建'} {slotOf(board).host}</button><span className="sp" />{look()}</>
  if (m.lock === 'free') return <>{confirm ?? <button className="pill dark" onClick={act.lock}><Icon name="lock" />拿锁</button>}<span className="sp" />{watch}{look()}</>
  const queue = m.queued
    ? <span className="queued">排队第 {m.queued} 位<button title="不排了" aria-label="不排了" onClick={act.unqueue}><Icon name="x" /></button></span>
    : m.lock === 'busy' ? <button className="pill" onClick={act.queue}><Icon name="queue" />排队</button> : null
  return <>{confirm ?? queue}<span className="sp" />{watch}{look()}</>
}

function lines(board: Board, m: Model, you: string): [JSX.Element | null, JSX.Element | null] {
  const holderLine = m.holder ? <><Who id={m.holder} you={you} max={16} tag={!m.mine} />{m.since ? <><span>·</span><span className={m.mine ? 'mono' : ''}><Ticking fn={() => m.mine ? clock(m.since!) : age(m.since)} /></span></> : <span>· 实验室自己在用</span>}</> : null
  if (m.lock === 'empty') return [<span>没有板子</span>, <span>插上板子后发现一下</span>]
  const first = m.flags.attn ? <span className="ell" title={m.flags.attn}>{m.flags.attn}</span>
    : m.flags.gone ? <span>串口不见了，可能重新布线了</span>
    : holderLine ?? <span className="ell">{board.lab?.sdks?.slice(0, 3).join(' · ') || board.product || '—'}</span>
  const second = m.flags.attn || m.flags.gone ? (holderLine ?? <span>没人拿锁</span>)
    : m.flags.progress ? <span className="ell">{m.flags.progress}</span>
    : m.purpose ? <><span className="ell" title={m.purpose}>{m.purpose}</span>{board.waiters.length ? <><span>·</span><span style={{ flex: 'none' }}>{board.waiters.length} 人排队</span></> : null}</> : null
  return [first, second]
}

function Card({ board, m, you, watched, open }: { board: Board, m: Model, you: string, watched: string[], open: (board: string) => void }) {
  const { host, slot } = slotOf(board), [l1, l2] = lines(board, m, you)
  const name = m.lock === 'empty' ? `${host} / ${slot}`.toUpperCase() : upper(board.name)
  const product = board.product && !name.includes(board.product.toUpperCase().replace(/_/g, '-')) ? ` · ${board.product}` : ''
  return (
    <article className={`card ${m.key}${m.mine ? ' is-mine' : ''}`} tabIndex={0} data-board={board.name} aria-label={`${name}，${m.word}`}
      onClick={e => { if (!(e.target as HTMLElement).closest('button')) open(board.name) }} onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) open(board.name) }}>
      <div className="hd"><div><div className={`nm${name.length > 18 ? ' long' : ''}`} title={name}>{middle(name, 22)}</div><div className="wh">{host} · {slot}{product}</div></div>
        {board.soc && <span className="soc">{board.soc.toUpperCase()}</span>}</div>
      <div className="mid"><div className="st">{m.word}{m.flags.pct != null && <span className="pct">{m.flags.pct}%</span>}</div><div className="ln">{l1}</div><div className="ln">{l2}</div></div>
      <div className="ft"><Actions board={board} m={m} watched={watched} open={open} /></div>
      {m.flags.pct != null && <div className="meter"><i style={{ width: `${m.flags.pct}%` }} /></div>}
    </article>
  )
}

function Row({ board, m, you, watched, open }: { board: Board, m: Model, you: string, watched: string[], open: (board: string) => void }) {
  const { host, slot } = slotOf(board)
  return (
    <div className={`lrow ${m.key}`} tabIndex={0} data-board={board.name} onClick={e => { if (!(e.target as HTMLElement).closest('button')) open(board.name) }} onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) open(board.name) }}>
      <span className={`dot ${m.tone}`} /><span className="nm" title={upper(board.name)}>{m.lock === 'empty' ? `${host} / ${slot}`.toUpperCase() : upper(board.name)}</span>
      <span className="mono sub">{host} · {slot}</span><span>{m.word}{m.flags.pct != null ? ` ${m.flags.pct}%` : ''}</span>
      <span>{m.holder ? <Who id={m.holder} you={you} max={18} /> : <span className="faint">—</span>}</span>
      <span className="sub">{m.since ? <Ticking fn={() => age(m.since)} /> : ''}</span><span className="sub">{m.flags.attn ?? m.purpose ?? ''}</span>
      <span className="ft"><Actions board={board} m={m} watched={watched} open={open} /></span>
    </div>
  )
}

/** Hosts with their slots: every board's slot, plus slots a pending proposal points at. */
function Lanes({ state, boards, m, watched, open }: { state: PageState, boards: Board[], m: (b: Board) => Model, watched: string[], open: (board: string) => void }) {
  const ui = useUI()
  const hosts = new Map<string, Board[]>()
  for (const b of boards) { const { host } = slotOf(b); hosts.set(host, [...(hosts.get(host) ?? []), b]) }
  return (
    <div className="lanes">{[...hosts].map(([host, list]) => {
      const held = list.filter(b => b.lease).length
      const props = state.proposals.filter(p => p.status === 'pending' && String(p.change.host ?? '') === host)
      return (
        <section className="lane" key={host}>
          <h3><Icon name="server" />{host}<span className="sub">{list.length + props.length} 个槽位 · {list.filter(b => !b.lab?.empty).length} 块板子{held ? ` · ${held} 块有锁` : ''}</span></h3>
          <div className="wall">
            {list.map(b => <Card key={b.name} board={b} m={m(b)} you={state.you} watched={watched} open={open} />)}
            {props.map(p => (
              <article key={p.id} className="card proposal">
                <div className="hd"><div><div className="nm">{`${host} / ${String(p.change.slot ?? p.slot ?? '')}`.toUpperCase()}</div><div className="wh">待确认</div></div></div>
                <div className="mid"><div className="st">新板子</div><div className="ln"><span className="ell" title={p.summary}>{p.summary}</span></div><div className="ln" /></div>
                <div className="ft"><button className="pill dark" onClick={() => void api.proposals([p.id], 'apply').then(() => ui.toast('登记了'), e => ui.fail('登记失败', e))}>登记</button>
                  <button className="pill" onClick={() => void api.proposals([p.id], 'reject').catch(e => ui.fail('忽略失败', e))}>忽略</button></div>
              </article>
            ))}
          </div>
        </section>
      )
    })}</div>
  )
}
