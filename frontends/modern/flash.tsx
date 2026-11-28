/**
 * Flashing a board, apart from booting it: what to flash (an image of a market, a link, a file from this computer, or an
 * SDK's build), then what
 * the package would write, drawn as maps, with the whole package or chosen partitions and a reset after. The markets,
 * their folders, which images a board takes and the plan all come from boardd; nothing here knows a market's kind, a
 * backend or a format.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../src/ui/api.ts'
import { uploadFile, type Uploaded } from '../../src/ui/upload.ts'
import type { Board, FlashPlan, Market, MarketEntry, MarketSearch } from 'boardlab-core/shared/types.ts'
import type { FlashPackage } from './actions.tsx'
import { PlanMap, sizeText } from './flashmap.tsx'
import { Icon, upper, useUI } from './kit.tsx'

type Source = 'market' | 'link' | 'file' | 'sdk'
const LAST = 'boardlab.modern.lastFlash'
interface Last { source: Source, market?: string, path?: string, url?: string, flasher?: string }
const lastFlash = (board: string): Last | null => { try { return JSON.parse(localStorage.getItem(LAST) ?? '{}')[board] ?? null } catch { return null } }
const saveFlash = (board: string, value: Last) => { try { localStorage.setItem(LAST, JSON.stringify({ ...JSON.parse(localStorage.getItem(LAST) ?? '{}'), [board]: value })) } catch {} }

const when = (iso: string | null | undefined) => iso ? iso.slice(0, 16).replace('T', ' ') : ''

export interface TreeProps {
  market: string
  /** Only this SoC's entries (and those filed under none); null for all. */
  soc: string | null
  picked: string | null
  onPick: (entry: MarketEntry) => void
  filter: string
  /** The board the images are for: boardd says which of them it cannot take. */
  board?: string | null
  /** Bumped to read every open folder again (the market's minute cache skipped). */
  refresh?: number
}

/**
 * A market's tree. Typing in its search reads the whole market in boardd and shows only what leads to an image whose
 * name has the words — the folders between, expanded all the way, so every match is in view at once. Without words
 * it is browsed a folder at a time, read when opened, newest first.
 */
export function MarketTree(props: TreeProps) {
  const words = props.filter.trim()
  if (!words) return <div className='mk-tree'><Folder {...props} path='' depth={0} /></div>
  return <SearchMatches {...props} words={words} />
}

/** How long typing pauses before the market is searched: a word typed on does not start a search of its own. */
const SEARCH_AFTER_MS = 350

/**
 * The market searched: one read of the whole tree, kept while the same words are typed on (a new one when they change).
 * Typing pauses before a search starts, and one still running is stopped: the market is asked for the words on screen.
 */
function SearchMatches({ market, soc, picked, onPick, board = null, refresh = 0, words }: TreeProps & { words: string }) {
  const [found, setFound] = useState<MarketSearch | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The refresh this search was asked to read past: only the search right after a 刷新 skips the market's minute, not
  // every word typed after it.
  const read = useRef(refresh)
  useEffect(() => {
    let live = true
    const stop = new AbortController()
    const fresh = refresh !== read.current
    read.current = refresh
    setError(null); setFound(null)
    const start = window.setTimeout(() => {
      void api.marketSearch(market, words, { soc, board, refresh: fresh, signal: stop.signal }).then(got => { if (live) setFound(got) },
        e => { if (live && !stop.signal.aborted) { setFound(null); setError((e as Error).message) } })
    }, SEARCH_AFTER_MS)
    return () => { live = false; window.clearTimeout(start); stop.abort() }
  }, [market, soc, board, words, refresh])
  if (error) return <div className='mk-tree'><div className='mk-row mk-err'><Icon name='warn' />找不了：{error}</div></div>
  const depthOf = (path: string) => path.split('/').length - 1
  const folders = new Set((found?.entries ?? []).filter(entry => entry.kind === 'folder').map(entry => entry.path))
  return (
    <div className='mk-tree mk-found'>
      {!found ? <div className='mk-row sub'><span className='spin' />在整个市场里找「{words}」…</div>
        : <>
          <div className='mk-row sub mk-count'>{found.entries.some(entry => entry.kind === 'image')
            ? `找到 ${found.entries.filter(entry => entry.kind === 'image').length} 个镜像，整棵树展开`
            : `没有名字里有「${words}」的镜像`}{found.partial ? ' · 没找完整个市场（市场太大、太慢，或有目录读不了），可能有遗漏' : ''}</div>
          {found.entries.map(entry => {
            const why = entry.refused ?? null
            return entry.kind === 'folder'
              ? <div key={entry.path} className='mk-row mk-folder open' style={{ paddingLeft: 10 + depthOf(entry.path) * 16 }} title={entry.path}>
                <Icon name='chev' /><span className='mk-name'>{entry.name}</span>{entry.note && <span className='mk-note'>{entry.note}</span>}{entry.soc && <span className='tag'>{upper(entry.soc)}</span>}
              </div>
              : <button type='button' key={entry.path} className={`mk-row mk-image${picked === entry.path ? ' on' : ''}`} style={{ paddingLeft: 26 + Math.max(0, depthOf(entry.path) - (folders.has(entry.path.slice(0, entry.path.lastIndexOf('/'))) ? 0 : 1)) * 16 }} disabled={!!why}
                title={why ?? entry.path} onClick={() => onPick(entry)}>
                <Icon name='doc' /><span className='mk-name'>{entry.name}</span>{entry.note && <span className='mk-note'>{entry.note}</span>}
                <span className='mk-meta'>{[sizeText(entry.size ?? null) === '—' ? '' : sizeText(entry.size ?? null), when(entry.modified)].filter(Boolean).join(' · ')}</span>
                {picked === entry.path && <Icon name='check' />}
              </button>
          })}
        </>}
    </div>
  )
}

/** One folder of a market, read when opened; its folders open in place. */
function Folder({ market, soc, path, depth, picked, onPick, filter, board = null, refresh = 0 }: TreeProps & { path: string, depth: number }) {
  const [entries, setEntries] = useState<MarketEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  // A folder is read past the market's minute once per 刷新, not on every read after one.
  const read = useRef(refresh)
  useEffect(() => {
    let live = true
    const fresh = refresh !== read.current
    read.current = refresh
    setEntries(null); setError(null)
    void api.marketFolder(market, path, { soc, refresh: fresh, board }).then(got => { if (live) setEntries(got.entries) }, e => { if (live) setError((e as Error).message) })
    return () => { live = false }
  }, [market, path, soc, refresh, board])
  if (error) return <div className='mk-row mk-err' style={{ paddingLeft: 10 + depth * 16 }}><Icon name='warn' />{error}</div>
  if (!entries) return <div className='mk-row sub' style={{ paddingLeft: 10 + depth * 16 }}><span className='spin' />读取中…</div>
  if (!entries.length) return <div className='mk-row sub' style={{ paddingLeft: 10 + depth * 16 }}>（空）</div>
  return <>{entries.map(entry => {
    if (entry.kind === 'folder') {
      const on = open.has(entry.path)
      return <div key={entry.path}>
        <button type='button' className={`mk-row mk-folder${on ? ' open' : ''}`} style={{ paddingLeft: 10 + depth * 16 }} aria-expanded={on}
          onClick={() => setOpen(now => { const next = new Set(now); if (on) next.delete(entry.path); else next.add(entry.path); return next })}>
          <Icon name='chev' /><span className='mk-name'>{entry.name}</span>{entry.note && <span className='mk-note'>{entry.note}</span>}{entry.soc && <span className='tag'>{upper(entry.soc)}</span>}
        </button>
        {on && <Folder market={market} soc={soc} path={entry.path} depth={depth + 1} picked={picked} onPick={onPick} filter={filter} board={board} refresh={refresh} />}
      </div>
    }
    const why = entry.refused ?? null
    return <button type='button' key={entry.path} className={`mk-row mk-image${picked === entry.path ? ' on' : ''}`} style={{ paddingLeft: 26 + depth * 16 }} disabled={!!why}
      title={why ?? entry.path} onClick={() => onPick(entry)}>
      <Icon name='doc' /><span className='mk-name'>{entry.name}</span>
      <span className='mk-meta'>{[sizeText(entry.size ?? null) === '—' ? '' : sizeText(entry.size ?? null), when(entry.modified)].filter(Boolean).join(' · ')}</span>
      {picked === entry.path && <Icon name='check' />}
    </button>
  })}</>
}

export function FlashDialog({ board, close, onPackage, onSdk, initial }: { board: Board, close: () => void, onPackage: (pkg: FlashPackage) => void, onSdk: (sdk: string) => void, initial?: { market: string, path: string } }) {
  const ui = useUI()
  const sdks = board.lab?.sdks ?? [], canPackage = !!board.lab?.canFlashPackage, last = lastFlash(board.name)
  const [markets, setMarkets] = useState<Array<Market & { error: string | null }> | null>(null)
  const [source, setSource] = useState<Source>(initial ? 'market' : last?.source ?? (canPackage ? 'market' : 'sdk'))
  const [market, setMarket] = useState(initial?.market ?? last?.market ?? '')
  const [image, setImage] = useState<string | null>(initial?.path ?? null)
  const [url, setUrl] = useState(last?.url ?? '')
  const [flasher, setFlasher] = useState(last?.flasher ?? '')
  const [sdk, setSdk] = useState(sdks[0] ?? '')
  const [filter, setFilter] = useState('')
  // A file from this computer: sent to boardd in pieces before anything else, then flashed by its sha256.
  const [file, setFile] = useState<File | null>(null)
  const [sent, setSent] = useState<Uploaded | null>(null)
  const [sending, setSending] = useState<{ sent: number, size: number } | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  // The upload now being sent, and the plan now being read: stopped when replaced or when the dialog closes.
  const sendStop = useRef<AbortController | null>(null)
  const planStop = useRef<AbortController | null>(null)
  const [plan, setPlan] = useState<FlashPlan | null>(null)
  const [planLine, setPlanLine] = useState<string | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [whole, setWhole] = useState(true)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [reset, setReset] = useState(true)
  useEffect(() => {
    if (!canPackage) { setMarkets([]); return }
    let live = true
    void api.markets().then(list => {
      if (!live) return
      setMarkets(list)
      setMarket(now => list.some(item => item.id === now && !item.error) ? now : list.find(item => !item.error)?.id ?? '')
    }, () => { if (live) setMarkets([]) })
    return () => { live = false }
  }, [canPackage])

  const link = url.trim()
  const pkg = useMemo<FlashPackage | null>(() => source === 'market' && market && image ? { image: { market, path: image } }
    : source === 'link' && /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(link) ? { url: link }
    : source === 'file' && sent ? { sha256: sent.sha256 } : null, [source, market, image, link, sent])
  const send = async (picked: File) => {
    sendStop.current?.abort()
    const stop = new AbortController()
    sendStop.current = stop
    setFile(picked); setSent(null); setSendError(null); setSending({ sent: 0, size: picked.size })
    // An upload a newer one replaced says nothing more: only the newest one's progress and result are shown.
    const current = () => sendStop.current === stop
    try { const got = await uploadFile(picked, progress => { if (current()) setSending(progress) }, stop.signal); if (current()) setSent(got) }
    catch (error) { if (current() && !stop.signal.aborted) setSendError((error as Error).message) }
    finally { if (current()) { setSending(null); sendStop.current = null } }
  }
  // Closing the dialog stops a file still being sent, and a plan still being read on the board host.
  useEffect(() => () => { sendStop.current?.abort(); planStop.current?.abort() }, [])
  // The package the plan shown belongs to, and the partitions chosen from it.
  // `preset`: the plan's named selection (its medium) chosen instead of partitions one by one; `null` is the package
  // whole, and a set of names is a choice of partitions.
  const [preset, setPreset] = useState<string | null>(null)
  const plannedKey = useRef('')
  const tool = flasher.trim()
  // What the plan shown is of: the package, and the tool it would be written with (another tool writes other media). A
  // link is not read until asked for, so it keys nothing.
  const planOf = pkg?.image ? `image:${pkg.image.market}\0${pkg.image.path}` : pkg?.sha256 ? `file:${pkg.sha256}` : ''
  const pkgKey = planOf ? `${planOf}\0${tool}` : ''
  // A package changes: forget its plan and the partitions chosen from it, and read the new one at once, so what it
  // would write (its partitions, its map) is there before anything is chosen.
  useEffect(() => {
    // No package to plan (another tab, a link still being typed): what was read stays, and comes back with its package.
    if (!pkgKey) return
    // The same package again, with its plan read already: nothing to ask the board host for a second time.
    if (pkgKey === plannedKey.current && plan) return
    planStop.current?.abort(); planStop.current = null; plannedKey.current = pkgKey
    setPlan(null); setPlanError(null); setPlanLine(null); setWhole(true); setChosen(new Set()); setPreset(null)
    // A picked package is read at once; a link is read when asked (the host downloads it, and a link being typed is
    // not one yet). The tool goes with the read: typing it re-plans the package, not only the next one.
    if (board.lab?.canPlan) void readPlan()
  }, [pkgKey])

  const readPlan = async () => {
    if (!pkg) return
    planStop.current?.abort()
    const stop = new AbortController()
    planStop.current = stop
    setPlan(null); setPlanError(null); setPlanLine('读取刷机包…')
    try { const got = await api.flashPlan(board.name, { ...pkg, ...(flasher.trim() ? { flasher: flasher.trim() } : {}) }, text => { if (!stop.signal.aborted) setPlanLine(text.trim() || null) }, stop.signal); if (!stop.signal.aborted) { setPlan(got); setPlanLine(null) } }
    catch (error) { if (!stop.signal.aborted) { setPlanError((error as Error).message); setPlanLine(null) } }
    finally { if (planStop.current === stop) planStop.current = null }
  }
  const selectable = plan ? plan.media.flatMap(medium => medium.partitions.filter(part => part.selectable && part.image).map(part => part.name)) : []
  const partial = !!plan?.partial && selectable.length > 0
  // The presets a plan names: a package whose layouts are for different media (a NOR flash and a disk) is chosen by
  // which one the board boots from, not by reading two layouts' worth of names.
  const presets = plan?.presets ?? []
  const which = presets.find(item => item.id === preset) ?? null
  const ready = source === 'sdk' ? !!sdk : !!pkg && (whole || !!which || chosen.size > 0)
  const start = () => {
    if (source === 'sdk') { close(); return onSdk(sdk) }
    if (!pkg) return
    saveFlash(board.name, { source: source === 'file' ? 'market' : source, market, path: image ?? undefined, url: link || undefined, flasher: flasher.trim() || undefined })
    close()
    onPackage({ ...pkg, flasher: flasher.trim() || undefined,
      ...(which ? { partitions: which.partitions, layout: which.layout } : !whole && chosen.size ? { partitions: [...chosen] } : {}),
      ...(reset ? { reset: true } : {}) })
  }
  const usable = (markets ?? []).filter(item => !item.error)
  const tabs: Array<[Source, string, string]> = [
    ...(canPackage ? [['market', 'box', '镜像市场'] as [Source, string, string], ['link', 'link', '链接'] as [Source, string, string], ['file', 'dl', '上传文件'] as [Source, string, string]] : []),
    ...(sdks.length ? [['sdk', 'dl', '用 SDK 刷机'] as [Source, string, string]] : []),
  ]

  return <>
    <h2>刷机</h2>
    <p className='lead'><b>{upper(board.name)}</b>{board.soc ? ` · ${upper(board.soc)}` : ''} · 写进板子的存储，要几分钟。开始后可以关掉这个窗口，进度在板子上显示。</p>
    {!tabs.length ? <div className='mv-note warn'>这块板子的后端不能刷机：没有可用的 SDK，也不收刷机包。</div> : <>
      <div className='seg2 fl-src' role='tablist'>{tabs.map(([key, icon, label]) => (
        <button key={key} type='button' role='tab' aria-selected={source === key} className={source === key ? 'on' : ''} onClick={() => setSource(key)}><Icon name={icon} />{label}</button>
      ))}</div>

      {source === 'market' && (markets === null ? <p className='sub'><span className='spin' /> 读取镜像市场…</p>
        : !markets.length ? <div className='mv-note'>还没有设好的镜像市场，用链接或上传文件。</div>
        : <>
          <div className='fl-row'>
            {usable.length > 1 && <select className='select' value={market} onChange={e => { setMarket(e.target.value); setImage(null) }} aria-label='镜像市场'>{usable.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>}
            {usable.length === 1 && <span className='tag'>{usable[0]!.title}</span>}
            <label className='find grow'><Icon name='search' /><input value={filter} onChange={e => setFilter(e.target.value)} placeholder='找镜像（整个市场）' aria-label='找镜像' /></label>
            {board.soc && <span className='sub small'>只看 {upper(board.soc)} 的</span>}
          </div>
          {markets.filter(item => item.error).map(item => <div key={item.id} className='mv-note warn'>{item.title} 用不了：{item.error}</div>)}
          {image && <div className='fl-picked'><Icon name='doc' /><span className='mono ell' title={image}>{image}</span>
            <button type='button' className='pill sm' onClick={() => setImage(null)}>换一个</button></div>}
          {market && <MarketTree market={market} soc={board.soc} picked={image} onPick={entry => setImage(entry.path)} filter={filter}
            board={board.name} />}
        </>)}

      {source === 'link' && <label className='field'>链接<input className='input' type='url' value={url} onChange={e => setUrl(e.target.value)} placeholder='https://…/package.zip' />
        <span className='sub small'>板子所在的主机自己下载{board.lab?.packages?.schemes.length ? `（${board.lab.packages.schemes.join('、')}）` : ''}。</span></label>}

      {source === 'file' && <div className='field'>文件
        <label className={`fl-drop${file ? ' has' : ''}`} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const dropped = e.dataTransfer.files[0]; if (dropped) void send(dropped) }}>
          <input type='file' onChange={e => { const picked = e.target.files?.[0]; if (picked) void send(picked) }} />
          <Icon name='dl' /><span>{file ? <><b className='mono'>{file.name}</b> · {sizeText(file.size)}</> : '选一个刷机包，或拖到这里'}</span>
        </label>
        {sending && <div className='fl-send'><div className='bar2'><i style={{ width: `${sending.size ? Math.floor(100 * sending.sent / sending.size) : 0}%` }} /></div>
          <span className='sub small'>传给 boardd：{sizeText(sending.sent)} / {sizeText(sending.size)}</span>
          <button type='button' className='pill sm' onClick={() => { sendStop.current?.abort(); sendStop.current = null; setSending(null); setFile(null) }}>停止</button></div>}
        {sent && <span className='sub small'><Icon name='check' /> 传好了 · sha256 <span className='mono'>{sent.sha256.slice(0, 12)}…</span>（boardd 留三天；同一个文件不会传第二次）</span>}
        {sendError && <div className='mv-note warn'>没传上去：{sendError}{file && <button type='button' className='pill sm' style={{ marginLeft: 8 }} onClick={() => void send(file)}>再传</button>}</div>}
      </div>}

      {source === 'sdk' && <label className='field'>SDK<select className='select' value={sdk} onChange={e => setSdk(e.target.value)}>{sdks.map(s => <option key={s}>{s}</option>)}</select>
        <span className='sub small'>用这个 SDK 编好的产物整包写进 eMMC / SD；之后复位从存储启动。</span></label>}

      {source !== 'sdk' && <>
        <label className='field'>刷机工具（可选）<input className='input' value={flasher} onChange={e => setFlasher(e.target.value)} placeholder='留空由后端按刷机包选' /></label>
        {pkg && board.lab?.canPlan && <div className='fl-plan' data-plan>
          {!plan && !planLine && !planError && <button type='button' className='pill sm' onClick={() => void readPlan()}><Icon name='eye' />看看会写什么</button>}
          {planLine && <div className='sub small'><span className='spin' /> {planLine}</div>}
          {plan && <div className='sub small fl-plan-head'>这个包会写这些分区（按介质画出来{partial ? '；选「指定分区」后点分区名只刷它那一片' : ''}）</div>}
          {planError && <div className='mv-note warn'>看不了这个包会写什么：{planError}<button type='button' className='pill sm' style={{ marginLeft: 8 }} onClick={() => void readPlan()}>再试</button></div>}
          {plan && <>
            <PlanMap plan={plan} chosen={whole ? null : which ? new Set(which.partitions) : chosen} />
            {plan.notes.map(note => <div key={note} className='mv-note'>{note}</div>)}
            {(presets.length > 0 || partial) && <div className='field'>写哪些
              <div className='chips' data-choices>
                <button type='button' className={`chip${whole ? ' on' : ''}`} onClick={() => { setWhole(true); setPreset(null); setChosen(new Set()) }}>整包</button>
                {presets.map(item => (
                  <button type='button' key={item.id} className={`chip${preset === item.id ? ' on' : ''}`} aria-pressed={preset === item.id}
                    title={item.about ?? undefined}
                    onClick={() => { setWhole(false); setPreset(item.id); setChosen(new Set()) }}>{item.label}</button>
                ))}
                {partial && presets.length === 0 && <button type='button' className={`chip${!whole ? ' on' : ''}`} onClick={() => setWhole(false)}>指定分区</button>}
              </div>
              {which && <span className='sub small'>{which.about ?? `写 ${which.layout} 上的 ${which.partitions.length} 个分区`}</span>}
              {/* The partitions one by one, as well as a preset: a package that names presets still lets a person
                  choose single partitions, and a preset is only the starting point of that choice. */}
              {!whole && (!which || preset === null) && <div className='chips'>{selectable.map(name => (
                <button type='button' key={name} className={`chip${chosen.has(name) ? ' on' : ''}`} aria-pressed={chosen.has(name)}
                  onClick={() => setChosen(now => { const next = new Set(now); if (next.has(name)) next.delete(name); else next.add(name); return next })}>{name}</button>
              ))}</div>}
            </div>}
          </>}
        </div>}
        <label className='check'><input type='checkbox' checked={reset} onChange={e => setReset(e.target.checked)} />刷完复位，从刚写的系统启动</label>
      </>}
    </>}
    <div className='foot'><button type='button' className='pill' onClick={close}>取消</button>
      <button type='button' className='pill dark' disabled={!ready} onClick={() => { try { start() } catch (error) { ui.fail('开始不了', error) } }}><Icon name='flash' />开始刷机</button></div>
  </>
}
