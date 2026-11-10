/** Discover, history and settings. */
import { useEffect, useMemo, useState } from 'react'
import { api, frontends, identity, type FrontendList, type History, type PageState } from '../../../src/ui/api.ts'
import { ACTIONS } from '../../../src/ui/format.ts'
import { ask, onPrefs, permission, prefs, support, TOPICS, type Topic } from '../../../src/ui/notify.ts'
import type { Board, LabSettings, Proposal } from 'boardlab-core/shared/types.ts'
import { age, Confirm, fmtAt, Icon, model, slotOf, upper, useUI, Who } from '../kit.tsx'
import { ViewPanel, viewsFor } from '../render.tsx'

export type Theme = 'system' | 'light' | 'dark'
const KIND: Record<Proposal['kind'], string> = { 'new-board': '新板子', 'replace-board': '换了板子', 'serial-moved': '串口换了', 'download-moved': '下载口换了', 'product-changed': '型号变了', 'slot-empty': '槽位空了' }
const held = (b: Board) => !!b.lease || !!b.lab?.heldBy

// ---------- discover ----------

function Proposals({ proposals }: { proposals: Proposal[] }) {
  const ui = useUI()
  const [names, setNames] = useState<Record<string, string>>({})
  const pending = proposals.filter(p => p.status === 'pending')
  if (!pending.length) return null
  const decide = (ids: string[], decision: 'apply' | 'reject') => void api.proposals(ids, decision, decision === 'apply' ? names : undefined).then(() => ui.toast(decision === 'apply' ? '登记了' : '忽略了'), e => ui.fail(decision === 'apply' ? '登记失败' : '忽略失败', e))
  return (
    <section className="panel">
      <h2>待确认<span className="sub small">{pending.length}</span><span className="acts"><button className="pill sm" onClick={() => decide(pending.map(p => p.id), 'reject')}>全部忽略</button><button className="pill sm dark" onClick={() => decide(pending.map(p => p.id), 'apply')}>全部登记</button></span></h2>
      <p className="lead">boardd 发现了这些变化，确认后才改登记。</p>
      {pending.map(p => (
        <div key={p.id} className="prow"><span className="tag info">{KIND[p.kind]}</span><span className="grow">{p.summary}</span>
          {(p.kind === 'new-board' || !!p.change.lab) && <input className="input" placeholder={p.change.name ? String(p.change.name) : '起个名字（可选）'} value={names[p.id] ?? ''} onChange={e => setNames({ ...names, [p.id]: e.target.value })} />}
          <button className="pill sm" onClick={() => decide([p.id], 'reject')}>忽略</button><button className="pill sm dark" onClick={() => decide([p.id], 'apply')}>登记</button></div>
      ))}
    </section>
  )
}

function LabPanel({ lab, state, open }: { lab: LabSettings, state: PageState, open: (board: string) => void }) {
  const ui = useUI()
  const boards = state.boards.filter(b => b.lab?.id === lab.id), running = !!lab.discovery?.running
  const anyHeld = boards.filter(held)
  const fire = (label: string, promise: Promise<{ message?: string }>) => void promise.then(out => ui.toast(`${label}：开始了`, out?.message), e => ui.fail(`${label}失败`, e))
  const discoverAll = () => ui.layer(close => <Confirm title={`在实验室 ${lab.id} 发现新板子`} ok="开始" danger close={close} onOk={() => fire('发现', api.discoverLab(lab.id))}>在所有主机上找新接的板子：逐个拉还没用过的复位线，看哪个串口有反应、哪个下载口出现。<b>接在这些线上的板子会被复位。</b></Confirm>)
  return <>
    <section className="panel">
      <h2><Icon name="radar" />实验室 {lab.id}<span className="sub small">{lab.kind}{lab.syncedAt ? ` · ${age(lab.syncedAt)}前同步` : ''}</span>
        <span className="acts"><button className="pill sm danger-o" disabled={running || anyHeld.length > 0} title={anyHeld.length ? `${anyHeld.map(b => upper(b.name)).join('、')} 有锁` : undefined} onClick={discoverAll}><Icon name="radar" />发现新板子</button></span></h2>
      <p className="lead">{anyHeld.length ? `有 ${anyHeld.length} 块板子有锁，整个实验室的发现要等它们释放；单个空槽位和人工配对随时可以。` : '找到的板子马上登记；没能自动登记的列在「待确认」。'}</p>
      {lab.discovery && <div className={`flag${running ? ' run' : ''}`} style={{ margin: 0 }}>{running ? <span className="spin" /> : <Icon name="clock" />}<div><b>{running ? '正在发现' : '上次发现'}</b><span>{lab.discovery.line} · {age(lab.discovery.at)}前</span></div></div>}
    </section>
    <div className="panels">{lab.hosts.map(host => <HostPanel key={host} lab={lab} host={host} state={state} boards={boards.filter(b => slotOf(b).host === host)} running={running} open={open} />)}</div>
  </>
}

function HostPanel({ lab, host, state, boards, running, open }: { lab: LabSettings, host: string, state: PageState, boards: Board[], running: boolean, open: (board: string) => void }) {
  const ui = useUI()
  const lockedHere = boards.filter(held)
  const fire = (label: string, promise: Promise<{ message?: string }>) => void promise.then(out => ui.toast(`${label}：开始了`, out?.message), e => ui.fail(`${label}失败`, e))
  const props = state.proposals.filter(p => p.status === 'pending' && String(p.change.host ?? '') === host)
  const slots = [...boards.map(b => ({ slot: slotOf(b).slot, b, p: null as Proposal | null })), ...props.map(p => ({ slot: String(p.change.slot ?? p.slot ?? '?'), b: null as Board | null, p }))]
    .sort((a, b) => a.slot.localeCompare(b.slot, 'en', { numeric: true }))
  const rebuild = () => ui.layer(close => <RebuildDialog host={host} boards={boards} close={close} onGo={() => fire(`重建 ${host}`, api.rebuildLab(lab.id, host))} />)
  const rediscover = () => ui.layer(close => <RediscoverDialog host={host} boards={boards} close={close} onGo={() => fire(`重新发现 ${host}`, api.rebuildLab(lab.id, host, true))} />)
  const human = () => ui.layer(close => <Confirm title={`人工配对 · ${host}`} ok="开始" close={close} onOk={() => fire('人工配对', api.discoverLab(lab.id, { human: true, host }))}>
    没有复位线的板子用这个：开始后按页面上的提示，<b>一次只让一块还没登记的板子进下载模式</b>，实验室把串口和下载口配成一对。不会复位别的板子，有人在用板子时也能用。</Confirm>)
  return (
    <section className="panel">
      <h2><Icon name="server" />{host}<span className="sub small">{boards.filter(b => !b.lab?.empty).length} 块板子{lockedHere.length ? ` · ${lockedHere.length} 块有锁` : ''}</span>
        <span className="acts">
          <button className="pill sm" disabled={running} onClick={human}><Icon name="hand" />人工配对</button>
          {lab.canRediscover && <button className="pill sm" disabled={running} title="保留在用的板子，只重做变动的" onClick={rediscover}><Icon name="radar" />重新发现</button>}
          {lab.canRebuild && <button className="pill sm danger-o" disabled={running || lockedHere.length > 0} title={lockedHere.length ? `${lockedHere.map(b => upper(b.name)).join('、')} 有锁` : '整台主机从头来过'} onClick={rebuild}><Icon name="rebuild" />重建</button>}
        </span></h2>
      <p className="lead">{lab.canRediscover ? '重新布线后：「重新发现」保留在用的板子，只去掉串口不见的、找空闲串口上的板子；「重建」整台主机从头来过。' : '重新布线后重建，按现在的接线重新对出串口、复位线和下载口。'}{lockedHere.length ? <> <Icon name="lock" /> {lockedHere.map(b => upper(b.name)).join('、')} 有锁{lab.canRebuild ? '，重建要等它们释放' : ''}。</> : null}</p>
      <div className="slots">{slots.map(({ slot, b, p }) => {
        if (p) return <div key={p.id} className="slot prop"><b>{slot}</b><span className="n">新板子 · 待确认</span><span className="sub">{String(p.change.product ?? '')}</span></div>
        const m = model(b!, state.you)
        if (m.lock === 'empty') return <button key={b!.name} className="slot empty" onClick={() => ui.layer(close => <Confirm title={`发现 ${host} / ${slot}`} ok="开始" close={close} onOk={() => fire('发现', api.discoverLab(lab.id, { slots: [`${host}/${slot}`] }))}>复位这个槽位的复位线，看串口认出插上的板子。只动这一个槽位。</Confirm>)}><b>{slot}</b><span className="sub">空 · 点这里发现</span></button>
        return <button key={b!.name} className={`slot ${m.key}`} onClick={() => open(b!.name)}><b>{slot}</b><span className="n" title={upper(b!.name)}>{upper(b!.name)}</span><span><span className={`dot ${m.tone}`} /> {m.word}</span></button>
      })}{!slots.length && <span className="sub small">这台主机上还没有槽位。</span>}</div>
    </section>
  )
}

function RediscoverDialog({ host, boards, close, onGo }: { host: string, boards: Board[], close: () => void, onGo: () => void }) {
  const inUse = boards.filter(held), gone = boards.filter(b => b.lab?.slotGone && !held(b))
  return <>
    <h2>重新发现 {host}</h2>
    <div className="lead">只重做变动的，别人在用的板子不受影响：
      <ul className="blist">
        <li>保留在用的板子：{inUse.length ? inUse.map(b => upper(b.name)).join('、') : '（没有）'}</li>
        <li>忘掉串口不见的板子：{gone.length ? gone.map(b => upper(b.name)).join('、') : '（没有）'}</li>
        <li>给新接上的串口建槽位，在空闲串口上找板子（会复位没人用的复位线）</li>
      </ul></div>
    <div className="foot"><button className="pill" onClick={close}>取消</button><button className="pill dark" onClick={() => { close(); onGo() }}>重新发现</button></div>
  </>
}

function RebuildDialog({ host, boards, close, onGo }: { host: string, boards: Board[], close: () => void, onGo: () => void }) {
  return <>
    <h2>重建 {host}</h2>
    <div className="lead">boardd 会<b>忘掉</b>这台主机上的板子和槽位，然后复位每条复位线，按现在的接线重新对出串口和下载口：
      <ul className="blist">{boards.map(b => <li key={b.name}>{b.lab?.empty ? `空槽位 ${slotOf(b).slot}` : `${upper(b.name)} · ${slotOf(b).slot}`}</li>)}</ul>认出来的板子沿用原名。</div>
    <div className="foot"><button className="pill" onClick={close}>取消</button><button className="pill danger" onClick={() => { close(); onGo() }}>重建</button></div>
  </>
}

export function DiscoverPage({ state, open }: { state: PageState, open: (board: string) => void }) {
  const labs = state.labs.filter(l => l.enabled && l.canDiscover)
  const scans = viewsFor(state, 'scan'), results = viewsFor(state, 'scan-result')
  return (
    <div className="page">
      <section className="hero"><h1>发现</h1><p>新接的板子、重新布线、没有复位线的板子。</p></section>
      <Proposals proposals={state.proposals} />
      {labs.map(lab => <LabPanel key={lab.id} lab={lab} state={state} open={open} />)}
      {(scans.length > 0 || results.length > 0) && <div className="panels" style={{ marginTop: 12 }}>{[...scans, ...results].map(view => <ViewPanel key={view.id} view={view} />)}</div>}
      {!labs.length && !scans.length && !state.proposals.length && <div className="empty-state"><p>没有能发现板子的实验室或模块</p></div>}
    </div>
  )
}
export const canDiscover = (state: PageState) => state.labs.some(l => l.enabled && l.canDiscover) || viewsFor(state, 'scan').length > 0 || state.proposals.some(p => p.status === 'pending')

// ---------- history ----------

export function HistoryPage({ state, refreshKey, initialBoard }: { state: PageState, refreshKey: number, initialBoard: string }) {
  const [history, setHistory] = useState<History | null>(null)
  const [tab, setTab] = useState('actions')
  const [kind, setKind] = useState<'all' | 'mine' | 'fail'>('all')
  const [board, setBoard] = useState(initialBoard)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(120)
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => { void api.history().then(setHistory).catch(() => {}) }, [refreshKey])
  const boards = useMemo(() => [...new Set((history?.actions ?? []).map(a => a.board).filter((n): n is string => !!n))].sort(), [history])
  const q = query.trim().toLowerCase()
  const moduleViews = history ? viewsFor({ ...state, history }, 'history') : []
  // Repeats of the same failure by the same actor on the same board collapse into one row (×N).
  const rows = useMemo(() => {
    const list = (history?.actions ?? []).filter(a => a.kind !== 'lab-ports' && a.kind !== 'lab-sync')
      .filter(a => kind === 'mine' ? a.actor === state.you : kind === 'fail' ? !a.ok : true).filter(a => !board || a.board === board)
      .filter(a => !q || [a.actor, a.board, a.board && upper(a.board), a.kind, ACTIONS[a.kind], a.detail, a.message].join(' ').toLowerCase().includes(q))
    const out: Array<{ a: typeof list[number], n: number }> = []
    for (const a of list) { const last = out.at(-1); if (last && last.a.kind === a.kind && last.a.board === a.board && last.a.actor === a.actor && last.a.ok === a.ok && (last.a.message ?? '').slice(0, 60) === (a.message ?? '').slice(0, 60)) last.n++; else out.push({ a, n: 1 }) }
    return out
  }, [history, kind, board, q, state.you])
  return (
    <div className="page">
      <section className="hero"><h1>历史</h1><p>谁、什么时候、对哪块板子做了什么。</p></section>
      <div className="bar">
        <div className="seg">{[['actions', '操作'], ['leases', '锁'], ...moduleViews.map(v => [v.id, v.title ?? v.id])].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k!)}>{l}</button>)}</div>
        {tab === 'actions' && <><div className="seg">{([['all', '全部'], ['mine', '我的'], ['fail', '失败']] as const).map(([k, l]) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{l}</button>)}</div>
          <select className="select" style={{ width: 'auto', height: 34 }} value={board} onChange={e => setBoard(e.target.value)} aria-label="板子"><option value="">全部板子</option>{boards.map(n => <option key={n} value={n}>{upper(n)}</option>)}</select></>}
        <label className="find"><Icon name="search" /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="人、板子、操作、消息" /></label>
      </div>
      {!history ? <div className="empty-state"><span className="spin" /></div>
        : tab === 'actions' ? <>
          <div className="hist">{rows.slice(0, limit).map(({ a, n }) => (
            <div key={a.id} className="hrow"><time>{fmtAt(a.at)}</time><div><Who id={a.actor} you={state.you} max={22} /></div>
              <div className="what">{!a.ok && <><span className="tag bad">失败</span> </>}<b>{ACTIONS[a.kind] ?? a.kind}</b>{a.board && <> <span className="bd">{upper(a.board)}</span></>}{a.detail ? ` · ${a.detail}` : ''}{n > 1 && <> <span className="tag">×{n}</span></>}
                {a.message && <div className={`m${open === a.id ? ' open' : ''}`} title="点开看全文" onClick={() => setOpen(open === a.id ? null : a.id)}>{a.message}</div>}</div></div>
          ))}{!rows.length && <div className="empty-state"><p>没有记录</p></div>}</div>
          {rows.length > limit && <div style={{ textAlign: 'center', marginTop: 10 }}><button className="pill sm" onClick={() => setLimit(limit + 200)}>显示更多（还有 {rows.length - limit} 条）</button></div>}
        </>
        : tab === 'leases' ? <div className="hist">{history.leases.filter(l => !q || [l.board, l.holder, l.purpose].join(' ').toLowerCase().includes(q)).slice(0, 200).map(l => (
          <div key={l.id} className="hrow"><time>{fmtAt(l.startedAt)}</time><div><Who id={l.holder} you={state.you} max={22} /></div>
            <div className="what"><span className={`tag ${l.status === 'held' ? 'info' : l.status === 'stolen' ? 'warn' : ''}`}>{{ held: '拿着', released: '已释放', stolen: '被抢' }[l.status]}</span> <span className="bd">{upper(l.board)}</span> · {l.purpose}
              <div className="m">{l.endedAt ? `${fmtAt(l.endedAt)} 结束${l.endReason ? ` · ${l.endReason}` : ''}` : `已用 ${age(l.startedAt)}`}</div></div></div>
        ))}</div>
        : <div className="panels">{moduleViews.filter(v => v.id === tab).map(v => <ViewPanel key={v.id} view={v} />)}</div>}
    </div>
  )
}

// ---------- settings ----------

function Seg<T extends string>({ value, options, onChange }: { value: T, options: Array<[T, string]>, onChange: (v: T) => void }) {
  return <div className="seg">{options.map(([v, l]) => <button key={v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>)}</div>
}

function Identity({ you, onSaved }: { you: string, onSaved: () => void }) {
  const ui = useUI()
  const [name, setName] = useState(identity.get())
  const save = () => { if (name && !/^[A-Za-z0-9_.@-]{1,40}$/.test(name)) return ui.fail('名字不对', '只能用字母、数字和 . _ - @'); identity.set(name.trim()); ui.toast(name.trim() ? `现在是 ${name.trim()}` : '用回 boardd 本机的用户'); onSaved() }
  return (
    <section className="panel"><h2><Icon name="user" />我是谁</h2>
      <p className="lead">锁和排队按名字区分。现在是 <Who id={you} you="" full />。几个人用同一个页面时，各自填自己的名字；留空用 boardd 所在机器的用户。</p>
      <div className="row-acts"><input className="input" style={{ maxWidth: 260 }} value={name} onChange={e => setName(e.target.value)} placeholder="字母、数字、. _ - @" onKeyDown={e => { if (e.key === 'Enter') save() }} /><button className="pill sm dark" onClick={save}>保存</button></div>
    </section>
  )
}

function Appearance({ theme, onTheme }: { theme: Theme, onTheme: (t: Theme) => void }) {
  const [list, setList] = useState<FrontendList | null>(null)
  useEffect(() => { void frontends.list().then(setList).catch(() => {}) }, [])
  return (
    <section className="panel"><h2>外观</h2>
      <p className="lead">主题跟随系统，或者固定一种。</p>
      <Seg value={theme} options={[['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']]} onChange={onTheme} />
      {list && list.frontends.length > 1 && <>
        <p className="lead" style={{ marginTop: 14 }}>界面：boardd 给所有人提供的界面，换一个会刷新页面。</p>
        <div className="seg">{list.frontends.map(f => <button key={f.name} className={f.name === list.current ? 'on' : ''} onClick={() => f.name !== list.current && void frontends.choose(f.name)}>{f.title}{f.name === list.default ? <em>默认</em> : null}</button>)}</div>
      </>}
    </section>
  )
}

export function NotifyPrefs() {
  const [p, setP] = useState(prefs.get())
  const [granted, setGranted] = useState(permission())
  useEffect(() => onPrefs(setP), [])
  const can = support()
  return (
    <div className="prefs-grid">
      <div className="toggle"><span><b>系统通知</b><br /><span className="sub small">{!can.ok ? can.why : granted === 'granted' ? '已允许：页面在后台也会提醒' : '还没允许；没允许时只在页面里提醒'}</span></span>
        {can.ok && granted !== 'granted' && <button className="pill sm dark" onClick={async () => setGranted(await ask())}>允许</button>}</div>
      {(Object.keys(TOPICS) as Topic[]).map(t => <div key={t} className="toggle"><span>{TOPICS[t]}</span><button className={`sw${p.enabled[t] ? ' on' : ''}`} aria-label={TOPICS[t]} onClick={() => prefs.topic(t, !p.enabled[t])} /></div>)}
      <div className="sub small">关注的板子：{p.watched.length ? <span className="chips" style={{ display: 'inline-flex', marginLeft: 4 }}>{p.watched.map(n => <span key={n} className="chip">{upper(n)}<button aria-label="不再关注" onClick={() => prefs.watch(n, false)}><Icon name="x" /></button></span>)}</span> : '还没有。在板子卡片上点铃铛。'}</div>
    </div>
  )
}

function LabSettingsPanel({ lab }: { lab: LabSettings }) {
  const ui = useUI()
  const [form, setForm] = useState({ enabled: lab.enabled, url: lab.url ?? '', username: lab.username ?? '', password: '', jump: lab.jump ?? '', devices: lab.devices ?? '' })
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try { const next = await api.configureLab({ id: lab.id, ...form, password: form.password || undefined }); setForm({ ...form, password: '' }); next.verifyOk === false ? ui.fail('保存了，但连不上', next.verifyMessage ?? '') : ui.toast('保存了', next.verifyMessage ?? undefined) }
    catch (e) { ui.fail('保存失败', e) } finally { setSaving(false) }
  }
  const field = (key: 'url' | 'username' | 'password' | 'jump', type = 'text') => lab.fields[key] && (
    <label className="field" key={key}>{lab.fields[key]!.label}<input className="input" type={type} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })}
      placeholder={key === 'password' && lab.hasPassword ? '已保存，留空不改' : key === 'jump' ? lab.defaultJump ?? lab.fields.jump?.placeholder ?? undefined : lab.fields[key]!.placeholder ?? undefined} /></label>
  )
  return (
    <section className="panel">
      <h2><Icon name="server" />{lab.kind}<span className="sub small">{lab.verifiedAt && <><span className={`dot ${lab.verifyOk ? 'ok' : 'bad'}`} /> {lab.verifyMessage} · {age(lab.verifiedAt)}前</>}</span>
        <span className="acts"><button className={`sw${form.enabled ? ' on' : ''}`} aria-label="使用这个实验室" onClick={() => setForm({ ...form, enabled: !form.enabled })} /></span></h2>
      <p className="lead">{lab.about}</p>
      <div className="form">{field('url')}{field('username')}{field('password', 'password')}{field('jump')}
        <label className="field wide">只列这些板子<input className="input" value={form.devices} onChange={e => setForm({ ...form, devices: e.target.value })} placeholder="设备名或带 * 的模式，空格分开；留空列出全部" /></label>
        <div className="row-acts"><button className="pill sm dark" disabled={saving} onClick={() => void save()}>{saving && <span className="spin" />}保存并验证</button>
          <button className="pill sm" onClick={() => void api.testLab(lab.id).then(n => n.verifyOk ? ui.toast('连上了', n.verifyMessage ?? undefined) : ui.fail('连不上', n.verifyMessage ?? ''), e => ui.fail('验证失败', e))}>重新验证</button></div>
      </div>
    </section>
  )
}

export function SettingsPage({ state, theme, onTheme, onIdentity }: { state: PageState, theme: Theme, onTheme: (t: Theme) => void, onIdentity: () => void }) {
  return (
    <div className="page">
      <section className="hero"><h1>设置</h1><p>你是谁、外观、通知，以及这台 boardd 接的实验室和模块。</p></section>
      <div className="panels">
        <Identity you={state.you} onSaved={onIdentity} />
        <Appearance theme={theme} onTheme={onTheme} />
        <section className="panel"><h2><Icon name="bell" />通知</h2><p className="lead">锁拿到了、轮到你了、板子等人操作、锁被抢、关注的板子空了。</p><NotifyPrefs /></section>
        {viewsFor(state, 'settings').map(view => <ViewPanel key={view.id} view={view} />)}
        {state.labs.map(lab => <LabSettingsPanel key={lab.id} lab={lab} />)}
        <section className="panel"><h2><Icon name="dl" />自带固件</h2><p className="lead">boardd 自带的固件，用的时候核对 sha256。</p>
          {state.firmware.length ? state.firmware.map(f => <div key={`${f.soc}/${f.purpose}`} className="fw"><b>{f.soc.toUpperCase()} · {f.purpose}</b><span className="sub">{f.note ?? '—'}</span><code title={f.sha256}>{f.sha256.slice(0, 12)}…</code></div>) : <p className="sub small">这个 boardlab 没有自带固件。</p>}</section>
      </div>
    </div>
  )
}
