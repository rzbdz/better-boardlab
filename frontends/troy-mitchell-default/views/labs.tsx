/** Labs on the page: their settings, their free ports, and finding new boards in them. */
import { useCallback, useEffect, useState } from 'react'
import type { DiscoveryMethod, DiscoveryValues, LabPorts as LabPortsView, LabSettings } from 'boardlab-core/shared/types.ts'
import { api, type PageState } from '../../../src/ui/api.ts'
import { Pill, Dialog, Section, time, who, type Prompt, type Run } from '../kit.tsx'

/**
 * A lab's free ports: serial consoles and download ports no board uses yet, as a new cable shows up. Registering a
 * board is the lab's own discovery method, offered on its empty slot's card; this view only shows what is free.
 */
export function LabPorts({ lab }: { lab: string }) {
  const [ports, setPorts] = useState<LabPortsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  // What boardd heard last shows at once; it asks the lab again in the background and says so when the answer is in.
  const load = useCallback((fresh = false) => api.labPorts(lab, fresh).then(next => { setPorts(next); setError(null) }, failure => setError((failure as Error).message)), [lab])
  useEffect(() => {
    void load()
    const changed = (event: Event) => { if ((event as CustomEvent).detail?.lab === lab) void load() }
    window.addEventListener('boardlab:lab-ports', changed)
    return () => window.removeEventListener('boardlab:lab-ports', changed)
  }, [load, lab])
  if (!ports) return error ? <div className="blank"><p className="warn">{error}</p><button onClick={() => void load()}>重试</button></div> : <p className="muted">正在读取空闲端口…</p>
  return (
    <div className="stack">
      <p className="muted">还没有板子用的串口和下载口（新接上的线会出现在这里）。到空槽位的板子卡片上点「发现这块板」，按实验室上报的方式登记。</p>
      <div className="actions">
        <span className="muted">{ports.at ? `更新于 ${time(ports.at)}` : '还没有问过实验室'}{ports.refreshing ? ' · 正在刷新…' : ''}</span>
        {ports.error && <span className="warn">上次没问到：{ports.error}</span>}
        <button className="push" disabled={ports.refreshing} onClick={() => void load(true)}>刷新</button>
      </div>
      {!ports.hosts.length && !ports.refreshing && <p className="muted">实验室没有报告主机。</p>}
      {ports.hosts.map(host => (
        <Section key={host.host} title={host.host} extra={<span className="muted">{host.consoles.length} 个串口 · {host.usb.length} 个下载口</span>}>
          {!host.consoles.length && !host.usb.length ? <p className="muted">没有空闲端口。</p> : <ul className="muted">
            {host.consoles.map(item => <li key={`c-${item.id}`}>串口 {item.label}</li>)}
            {host.usb.map(item => <li key={`u-${item.id}`}>下载口 {item.label}</li>)}
          </ul>}
        </Section>
      ))}
    </div>
  )
}

/**
 * Find one board: the ways this lab can do it are its backend's own (its methods, titles, explanations and fields),
 * rendered here as they come.
 */
export function DiscoverBoardDialog({ lab, host, slot, onClose, onRun }: { lab: string, host?: string, slot?: string, onClose: () => void, onRun: Run }) {
  const [methods, setMethods] = useState<DiscoveryMethod[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<DiscoveryMethod | null>(null)
  useEffect(() => {
    let live = true
    setMethods(null); setError(null)
    api.discoverMethods(lab, { host: host ?? null, slot: slot ?? null }).then(list => { if (live) setMethods(list) }, failure => { if (live) setError((failure as Error).message) })
    return () => { live = false }
  }, [lab, host, slot])
  if (chosen) return <MethodForm lab={lab} method={chosen} host={host} slot={slot} onRun={onRun} onBack={() => setChosen(null)} onClose={onClose} />
  return (
    <Dialog title={`发现这块板${host ? ` · ${host}${slot ? ` / ${slot.split('/').at(-1)}` : ''}` : ''}`} onClose={onClose} actions={<button onClick={onClose}>取消</button>}>
      <p className="muted">选一种实验室上报的方式：</p>
      {error && <p className="warn">{error}</p>}
      {!methods && !error && <p className="muted">正在问实验室有哪些发现方式…</p>}
      {methods && !methods.some(method => !method.compose) && <p className="muted">实验室现在没有可用的发现方式。</p>}
      {!!methods?.length && <div className="stack">
        {methods.filter(method => !method.compose).map(method => <button key={method.id} onClick={() => setChosen(method)}><b>{method.title}</b><span className="muted">{method.about}</span></button>)}
      </div>}
    </Dialog>
  )
}

/** Initial values: the backend's own choice, or (for a required field) the only option there is. */
function startValues(method: DiscoveryMethod, prior: DiscoveryValues = {}): DiscoveryValues {
  const values: DiscoveryValues = {}
  for (const field of method.fields ?? []) {
    const kept = prior[field.id] ?? ''
    const options = field.options ?? []
    const allowed = kept && (field.kind !== 'choice' || options.some(option => option.value === kept))
    values[field.id] = allowed ? kept : field.initial ?? ''
  }
  return values
}

/** One method's form: the fields the backend named, then the run. */
function MethodForm({ lab, method, host, slot, onRun, onBack, onClose }: { lab: string, method: DiscoveryMethod, host?: string, slot?: string, onRun: Run, onBack: () => void, onClose: () => void }) {
  const [fresh, setFresh] = useState(method)
  const [values, setValues] = useState<DiscoveryValues>(() => startValues(method))
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const fields = fresh.fields ?? []
  const ready = fields.every(field => !field.required || values[field.id]?.trim())
  // Free ports change while a person plugs a board in: ask for the choices again without leaving the form.
  const refresh = async () => {
    setLoading(true)
    try {
      const list = await api.discoverMethods(lab, { host: host ?? null, slot: slot ?? null })
      const again = list.find(item => item.id === method.id)
      if (!again) { throw new Error('实验室不再提供这个方式') }
      setFresh(again)
      setValues(prior => startValues(again, prior))
    } catch (failure) { onRun('刷新失败', () => Promise.reject(failure)) }
    finally { setLoading(false) }
  }
  const start = () => {
    if (!ready) return
    setBusy(true)
    onClose()
    // What is left empty is not sent: the backend treats an absent optional field the same, and the run stays clear.
    const sent = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim()))
    // A method that describes a board rather than finding one registers it by what was entered; it is not a scan.
    if (method.compose) {
      void onRun('登记', () => api.composeBoard(lab, { method: method.id, values: sent, ...(host ? { host } : {}), ...(slot ? { slot } : {}) }))
      return
    }
    void onRun('开始发现', () => api.discoverLab(lab, { method: method.id, values: sent, ...(host ? { host } : {}), ...(slot ? { slot } : {}) }))
  }
  return (
    <Dialog title={`${method.title}${host ? ` · ${host}` : ''}${slot ? ` / ${slot.split('/').at(-1)}` : ''}`} onClose={onClose} actions={<>
      <button onClick={() => void refresh()} disabled={busy || loading}>刷新</button>
      <button onClick={onBack} disabled={busy}>返回</button>
      <button className="primary" disabled={busy || loading || !ready} onClick={start}>{busy ? '开始中…' : '开始'}</button>
    </>}>
      <p className="muted">{method.about}</p>
      <div className="form-grid">
        {fields.map(field => <label key={field.id} className="span">
          {field.label}{field.required ? '' : '（可选）'}
          {field.kind === 'choice'
            ? <select value={values[field.id] ?? ''} onChange={event => setValues(prior => ({ ...prior, [field.id]: event.target.value }))} disabled={busy || loading}>
                <option value="">{field.options?.length ? '选一个' : '没有可选项'}</option>
                {(field.options ?? []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            : <input value={values[field.id] ?? ''} placeholder={field.placeholder ?? ''} onChange={event => setValues(prior => ({ ...prior, [field.id]: event.target.value }))} disabled={busy || loading} />}
          {field.note && <span className="muted">{field.note}</span>}
        </label>)}
      </div>
    </Dialog>
  )
}

/**
 * A lab that finds boards itself . What it finds joins the proposals below; nothing is registered
 * until a person applies it.
 */
export function LabScan({ lab, state, onPrompt, onRun }: { lab: LabSettings, state: PageState, onPrompt: (prompt: Prompt) => void, onRun: Run }) {
  const [picked, setHost] = useState<string | null>(null)
  // The lab's hosts can arrive after the page first draws; until one is picked, the first is the choice.
  const host = picked ?? lab.hosts[0] ?? ''
  const held = state.boards.filter(board => board.lab?.id === lab.id && (board.lease || board.lab.heldBy))
  // The ways this lab finds boards are its backend's own: asked for the chosen host, rendered as they come.
  const [methods, setMethods] = useState<DiscoveryMethod[] | null>(null)
  const [methodError, setMethodError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<DiscoveryMethod | null>(null)
  useEffect(() => {
    let live = true
    setMethods(null); setMethodError(null); setChosen(null)
    api.discoverMethods(lab.id, { host: host.trim() || null }).then(list => { if (live) setMethods(list) }, failure => { if (live) setMethodError((failure as Error).message) })
    return () => { live = false }
  }, [lab.id, host])
  const rebuild = (target: string) => { void api.rebuildLab(lab.id, target).catch(() => {}); return Promise.resolve() }
  // What a rebuild of the chosen host forgets: the boards registered there (empty slots are just consoles).
  const onHost = state.boards.filter(board => board.lab?.id === lab.id && board.slotRef?.split('/')[1] === host)
  const heldOnHost = onHost.filter(board => board.lease || board.lab?.heldBy)
  const running = !!lab.discovery?.running
  return (
    <Section title={`实验室 ${lab.id} · 发现板子`} extra={running ? <Pill tone="mine">进行中</Pill> : null}>
      <p className="muted">{lab.kind}。找到的板子马上登记；没能登记的列在「待确认」，确认（可以改名）后才登记。</p>
      {held.length > 0 && <p className="muted">{held.map(board => `${board.name} 正被 ${who(board.lease?.holder ?? board.lab!.heldBy!)} 使用`).join('；')}。正在使用的板子不受影响。</p>}
      <div className="scan-modes">
        {methodError && <div className="scan-mode"><p className="warn">没问到实验室的发现方式：{methodError}</p></div>}
        {!methods && !methodError && <div className="scan-mode"><p className="muted">正在问实验室有哪些发现方式…</p></div>}
        {methods && !methods.some(method => !method.compose) && <div className="scan-mode"><p className="muted">实验室现在没有可用的发现方式。</p></div>}
        {(methods ?? []).filter(method => !method.compose).map(method => <div className="scan-mode" key={method.id}>
          <b>{method.title}</b>
          <p className="muted">{method.about}</p>
          <div className="actions">
            {lab.hosts.length > 1 && <select value={host} onChange={event => setHost(event.target.value)} aria-label={`${method.title}的主机`}>{lab.hosts.map(item => <option key={item} value={item}>{item}</option>)}</select>}
            <button className="primary" disabled={running} onClick={() => setChosen(method)}>选择</button>
          </div>
        </div>)}
        {lab.canRebuild && <div className="scan-mode">
          <b>重新布线以后：重建一台主机</b>
          <p className="muted">把串口、USB 线重新插过、换了口以后用：忘掉这台主机上发现过的板子和槽位，按现在插着的串口重新建槽位，再逐个找板子，找到一块登记一块。主机上任何板子被用着时不会开始。</p>
          <div className="actions">
            {lab.hosts.length
              ? <select value={host} onChange={event => setHost(event.target.value)} aria-label="重建的主机">{lab.hosts.map(item => <option key={item} value={item}>{item}</option>)}</select>
              : <input className="host-input" value={host} onChange={event => setHost(event.target.value)} placeholder="主机名" aria-label="重建的主机" />}
            <button className="danger" disabled={running || heldOnHost.length > 0 || !host.trim()} title={heldOnHost.length ? `${heldOnHost.map(board => board.name).join('、')} 正被使用` : undefined}
              onClick={() => onPrompt({ kind: 'confirm', title: `重建 ${host.trim()}`, action: '重建', danger: true,
                body: `会忘掉 ${host.trim()} 上的 ${onHost.filter(board => !board.lab?.empty).map(board => board.name).join('、') || '（没有登记的板子）'} 和它的所有槽位，按现在的接线重新发现板子，可能复位没人用的板子。`,
                run: () => rebuild(host.trim()) })}>重建</button>
          </div>
        </div>}
      </div>
      {chosen && <MethodForm lab={lab.id} method={chosen} host={host.trim() || undefined} onRun={onRun} onBack={() => setChosen(null)} onClose={() => setChosen(null)} />}
      {lab.discovery && <p className={lab.discovery.running ? 'warn' : 'muted'} data-testid={`lab-${lab.id}-discovery`}>{lab.discovery.running ? '进行中：' : '上次：'}{lab.discovery.line} · {time(lab.discovery.at)}
        {lab.discovery.running && <button className="link danger" onClick={() => void onRun('取消发现', () => api.cancelDiscovery(lab.id))}>取消发现</button>}</p>}
    </Section>
  )
}

/** A remote lab: whether boardd uses it, and the access its boards are reached with. */
export function LabSection({ lab, onRun, onPrompt }: { lab: LabSettings, onRun: Run, onPrompt: (prompt: Prompt) => void }) {
  const fields = lab.fields
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
      <p className="muted">{lab.kind}。{lab.about}</p>
      <form className="form-grid" onSubmit={event => { event.preventDefault(); void save() }}>
        <label className="switch span"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />开启 {lab.id} 实验室</label>
        {fields.url && <label>{fields.url.label}<input value={url} onChange={event => setUrl(event.target.value)} placeholder={fields.url.placeholder ?? undefined} required={enabled && fields.url.required} /></label>}
        {fields.username && <label>{fields.username.label}<input value={username} onChange={event => setUsername(event.target.value)} placeholder={fields.username.placeholder ?? undefined} autoComplete="off" required={enabled && fields.username.required} /></label>}
        {fields.password && <label>{fields.password.label}
          <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password"
            placeholder={lab.hasPassword ? '已保存（不显示，留空则不修改）' : fields.password.placeholder ?? undefined} required={enabled && fields.password.required && !lab.hasPassword} />
        </label>}
        {fields.jump && <label>{fields.jump.label}<input value={jump} onChange={event => setJump(event.target.value)} placeholder={lab.defaultJump ? `留空用 ${lab.defaultJump}` : fields.jump.placeholder ?? undefined} /></label>}
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
