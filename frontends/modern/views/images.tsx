/**
 * The image markets: choose a market, browse its tree (newest first, by SoC, searchable), look at an image, and flash
 * it onto a board — yours, or a free one locked for you (the lock stays yours afterwards). Which markets there are,
 * what they hold and which boards can take an image all come from boardd; the page knows no market kind or backend.
 */
import { useEffect, useMemo, useState } from 'react'
import { api, type PageState } from '../../../src/ui/api.ts'
import type { Board, Market, MarketEntry, MarketTarget } from 'boardlab-core/shared/types.ts'
import { useBoardActions } from '../actions.tsx'
import { FlashDialog, MarketTree } from '../flash.tsx'
import { sizeText } from '../flashmap.tsx'
import { copyText, Icon, refreshNow, upper, useUI } from '../kit.tsx'

const LAST_MARKET = 'boardlab.modern.market'
const remembered = () => { try { return localStorage.getItem(LAST_MARKET) ?? '' } catch { return '' } }
const remember = (id: string) => { try { localStorage.setItem(LAST_MARKET, id) } catch {} }

export function ImagesPage({ state, initial }: { state: PageState, initial: { market: string, soc: string } }) {
  const ui = useUI()
  const [markets, setMarkets] = useState<Array<Market & { error: string | null }> | null>(null)
  const [market, setMarket] = useState(initial.market || remembered())
  const [soc, setSoc] = useState(initial.soc)
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState<MarketEntry | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [socs, setSocs] = useState<string[]>([])
  useEffect(() => {
    let live = true
    void api.markets().then(list => {
      if (!live) return
      setMarkets(list)
      setMarket(now => list.some(item => item.id === now) ? now : list.find(item => !item.error)?.id ?? list[0]?.id ?? '')
    }, error => { if (live) { setMarkets([]); ui.fail('读不到镜像市场', error) } })
    return () => { live = false }
  }, [])
  // The SoCs to filter by: what the market files its top folders under, and the boards' own.
  useEffect(() => {
    if (!market) return
    remember(market)
    let live = true
    void api.marketFolder(market, '').then(got => {
      if (!live) return
      // A market that files nothing under a SoC is filtered by the boards' SoCs instead.
      const filed = got.entries.map(entry => entry.soc).filter((item): item is string => !!item)
      const found = new Set((filed.length ? filed : state.boards.map(board => board.soc).filter((item): item is string => !!item)).map(item => item.toLowerCase()))
      setSocs([...found].sort())
    }, () => { if (live) setSocs([]) })
    setPicked(null)
    return () => { live = false }
  }, [market])
  useEffect(() => {
    const query = new URLSearchParams()
    if (market) query.set('market', market)
    if (soc) query.set('soc', soc)
    const next = `#/images${query.size ? `?${query}` : ''}`
    // The address says what is shown, so a link opens the same market and SoC; the page stays as it is.
    if (location.hash !== next) location.hash = next
  }, [market, soc])

  const current = markets?.find(item => item.id === market) ?? null
  return (
    <div className="page">
      <section className="hero"><h1>镜像</h1><p>镜像市场里的刷机包：按 SoC 找，挑一个，刷到一块板子上。</p></section>
      {markets === null ? <div className="empty-state"><span className="spin" /></div>
        : !markets.length ? <div className="empty-state"><p>还没有设好的镜像市场</p><span className="sub">市场由 boardd 的模块按它们的配置设置好，这里就会列出来。</span></div>
        : <>
          <div className="bar">
            {markets.length > 1 && <div className="seg">{markets.map(item => <button key={item.id} className={item.id === market ? 'on' : ''} title={item.error ?? item.about} onClick={() => setMarket(item.id)}>{item.title}{item.error && <span className="warn-t"> ·</span>}</button>)}</div>}
            {socs.length > 0 && <div className="seg">
              <button className={!soc ? 'on' : ''} onClick={() => setSoc('')}>全部</button>
              {socs.map(item => <button key={item} className={soc === item ? 'on' : ''} onClick={() => setSoc(item)}>{upper(item)}</button>)}
            </div>}
            <label className="find"><Icon name="search" /><input value={filter} onChange={e => setFilter(e.target.value)} placeholder="找镜像（整个市场）" aria-label="找镜像" /></label>
            {/* Reading again asks the market, not its minute's cache: the page read, then what it shows. */}
            <button className="pill sm" title="不用一分钟内读过的，重新问市场" onClick={() => { refreshNow().catch(() => {}); setRefresh(refresh + 1) }}><Icon name="rebuild" />刷新</button>
          </div>
          {current && <div className="sub small mk-about">{current.kindTitle} · {current.source} 设的{current.about ? ` · ${current.about}` : ''}</div>}
          {current?.error ? <div className="mv-note warn">{current.title} 用不了：{current.error}</div>
            : current && <div className="mk-page">
              <MarketTree key={`${market}|${soc}|${refresh}`} market={market} soc={soc || null} picked={picked?.path ?? null} onPick={setPicked} filter={filter} refresh={refresh} />
              <ImageDetail state={state} market={current} entry={picked} />
            </div>}
        </>}
    </div>
  )
}

function ImageDetail({ state, market, entry }: { state: PageState, market: Market, entry: MarketEntry | null }) {
  const ui = useUI()
  if (!entry) return <aside className="mk-detail empty"><Icon name="box" /><p>选一个镜像，看它的大小、时间和 sha256，再刷到板子上。</p></aside>
  const ref = `${market.id}:${entry.path}`
  const facts: Array<[string, string | null | undefined]> = [
    ['SoC', entry.soc ? upper(entry.soc) : '不限'], ['大小', entry.size != null ? sizeText(entry.size) : null],
    ['时间', entry.modified ? entry.modified.slice(0, 16).replace('T', ' ') : null], ['sha256', entry.sha256], ['说明', entry.note],
  ]
  return (
    <aside className="mk-detail">
      <h2 title={entry.path}>{entry.name}</h2>
      <div className="mono sub small mk-path">{entry.path}</div>
      <dl className="facts">{facts.filter(([, v]) => v).map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd className={k === 'sha256' ? 'mono small mk-sha' : ''}>{v}</dd></div>)}</dl>
      <div className="acts">
        <button className="pill dark" onClick={() => ui.layer(close => <PickBoard state={state} market={market.id} entry={entry} close={close} />)}><Icon name="flash" />刷机…</button>
        <button className="pill" onClick={() => void copyText(ui, `boardlab flash <board> --image ${ref}`, '复制了命令')}><Icon name="copy" />复制命令</button>
      </div>
    </aside>
  )
}

/** The boards an image can go onto, from boardd: yours, then free ones (locked for you when picked), the rest with why not. */
function PickBoard({ state, market, entry, close }: { state: PageState, market: string, entry: MarketEntry, close: () => void }) {
  const ui = useUI()
  const [targets, setTargets] = useState<MarketTarget[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [chosen, setChosen] = useState<Board | null>(null)
  useEffect(() => {
    let live = true
    void api.marketTargets(market, entry.path).then(list => { if (live) setTargets(list) }, error => { if (live) { setTargets([]); ui.fail('读不到能刷的板子', error) } })
    return () => { live = false }
  }, [market, entry.path])
  const board = (name: string) => state.boards.find(item => item.name === name) ?? null
  const pick = async (target: MarketTarget) => {
    const found = board(target.board)
    if (!found) return
    if (!target.mine) {
      setBusy(target.board)
      try {
        const got = await api.lock(target.board, `刷机 ${entry.name}`.slice(0, 120))
        if (got.queued) { ui.fail(`${upper(target.board)} 刚被人拿走了`, `已经帮你排队，第 ${got.queued.position} 位`); setBusy(null); return }
        ui.toast(`拿到了 ${upper(target.board)}`, '锁会一直是你的，刷完记得释放')
        await refreshNow().catch(() => {})
      } catch (error) { ui.fail(`拿不到 ${upper(target.board)} 的锁`, error); setBusy(null); return }
      setBusy(null)
    }
    setChosen(found)
  }
  if (chosen) return <FlashOnto board={state.boards.find(item => item.name === chosen.name) ?? chosen} market={market} entry={entry} close={close} />
  const rank = (t: MarketTarget) => t.mine ? '你拿着' : t.free ? '空闲' : t.why ?? '不能用'
  return <>
    <h2>刷到哪块板子</h2>
    <p className="lead"><b>{entry.name}</b> · 只列出后端收这种包、SoC 对得上的板子。空闲的板子会替你拿锁，刷完锁还是你的。</p>
    {targets === null ? <p className="sub"><span className="spin" /> 读取中…</p>
      : !targets.length ? <div className="mv-note">没有能刷这个镜像的板子：后端不收这种包，或者 SoC 对不上。</div>
      : <div className="mv-list">{targets.map(target => (
        <div key={target.board}>
          <div className="grow"><b>{upper(target.board)}</b> <span className="sub small">{target.soc ? upper(target.soc) : ''} · {rank(target)}</span></div>
          <button className={`pill sm${target.mine || target.free ? ' dark' : ''}`} disabled={!(target.mine || target.free) || !!busy}
            title={target.why ?? undefined} onClick={() => void pick(target)}>
            {busy === target.board ? <span className="spin" /> : <Icon name={target.mine ? 'flash' : 'lock'} />}{target.mine ? '刷这块' : target.free ? '拿锁并刷' : '不能刷'}
          </button>
        </div>
      ))}</div>}
    <div className="foot"><button className="pill" onClick={close}>取消</button></div>
  </>
}

/** The flash dialog for a chosen board, opened on the image picked. */
function FlashOnto({ board, market, entry, close }: { board: Board, market: string, entry: MarketEntry, close: () => void }) {
  const act = useBoardActions(board)
  const initial = useMemo(() => ({ market, path: entry.path }), [market, entry.path])
  return <FlashDialog board={board} close={close} initial={initial}
    onPackage={pkg => { void act.flashPackage(pkg); location.hash = `#/board/${encodeURIComponent(board.name)}` }}
    onSdk={sdk => { void act.boot(sdk, 'download'); location.hash = `#/board/${encodeURIComponent(board.name)}` }} />
}
