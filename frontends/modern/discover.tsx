/**
 * Finding a board. The ways a lab can do it are the lab backend's own: its methods, titles, explanations and fields
 * come from `discoverMethods`, and this page only renders them. A new method needs nothing here.
 */
import { useEffect, useState } from 'react'
import type { DiscoveryContext, DiscoveryField, DiscoveryMethod, DiscoveryValues, LabSettings } from 'boardlab-core/shared/types.ts'
import { api } from '../../src/ui/api.ts'
import { Icon, refreshNow, useUI } from './kit.tsx'

/** A board is found by its host, or by one empty slot on it. */
export function DiscoverBoardDialog({ lab, host, slot, close }: { lab: LabSettings, host: string, slot?: string, close: () => void }) {
  return <>
    <h2>发现这块板 · {host}{slot ? ` / ${slot.split('/').at(-1)}` : ''}</h2>
    <div className="lead">选一种实验室上报的方式：</div>
    <MethodList lab={lab} host={host} slot={slot} close={close} />
  </>
}

/**
 * A board a scan cannot see: each lab that can describe one offers its `compose` method, and the person fills in the
 * backend's own fields. The first such lab is one click away; the rest are behind its name.
 */
export function AddDevicePanel({ labs }: { labs: LabSettings[] }) {
  const ui = useUI()
  const [methods, setMethods] = useState<Array<{ lab: LabSettings, method: DiscoveryMethod }> | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setMethods(null); setError(null)
    void Promise.all(labs.map(lab => api.discoverMethods(lab.id, {}).then(list => list.filter(item => item.compose).map(method => ({ lab, method })), () => [])))
      .then(groups => setMethods(groups.flat()), (failure: Error) => setError(failure.message))
  }, [labs.map(lab => lab.id).join()])
  if (error) return <section className="panel"><h2><Icon name="plus" />新增设备</h2><p className="warn">{error}</p></section>
  if (!methods) return <section className="panel"><h2><Icon name="plus" />新增设备</h2><p className="sub">正在问实验室怎么手工登记…</p></section>
  if (!methods.length) return null
  const open = (item: { lab: LabSettings, method: DiscoveryMethod }) => ui.layer(close =>
    <MethodForm lab={item.lab} method={item.method} back={close} close={close} />)
  return (
    <section className="panel">
      <h2><Icon name="plus" />新增设备</h2>
      <p className="lead">扫不到、或者没有哪种扫描看得出它的板子：在这里按实验室上报的字段登记成一块板子。每种方式说清它要什么，由后端给出。</p>
      <div className="opts">{methods.map(item => (
        <button key={`${item.lab.id}:${item.method.id}`} className="opt" onClick={() => open(item)}>
          <Icon name="plus" /><span><b>{item.method.title} · {item.lab.id}</b><span>{item.method.about}</span></span>
        </button>
      ))}</div>
    </section>
  )
}

/** The whole lab: choose the host (a lab reports its own), then how its board should be found. */
export function DiscoverLabDialog({ lab, close }: { lab: LabSettings, close: () => void }) {
  const [host, setHost] = useState(lab.hosts[0] ?? '')
  return <>
    <h2>发现板子 · 实验室 {lab.id}</h2>
    <div className="lead">{lab.hosts.length ? '先选板子在哪台主机上，再选一种方式：' : '选一种实验室上报的方式：'}</div>
    {lab.hosts.length > 0 && <label className="field wide"><span>主机</span>
      <select className="select" value={host} onChange={event => setHost(event.target.value)}>
        {lab.hosts.map(item => <option key={item} value={item}>{item}</option>)}
      </select>
    </label>}
    <MethodList lab={lab} host={host || undefined} close={close} />
  </>
}

/** The ways to find a board a scan can see (a `compose` method is how a person describes one instead). */
function MethodList({ lab, host, slot, close }: { lab: LabSettings, host?: string, slot?: string, close: () => void }) {
  const ui = useUI()
  const context: DiscoveryContext = { host: host ?? null, slot: slot ?? null }
  const key = `${lab.id}\u0000${host ?? ''}\u0000${slot ?? ''}`
  const [methods, setMethods] = useState<DiscoveryMethod[] | null>(() => methodsFor(key) ?? null)
  const [error, setError] = useState<string | null>(null)
  const ask = (fresh = false) => {
    if (fresh) answered.delete(key)
    const known = methodsFor(key)
    if (known) { setMethods(known); setError(null); return }
    setMethods(null); setError(null)
    api.discoverMethods(lab.id, context).then(list => { setMethodsFor(key, list); setMethods(list) }, failure => setError((failure as Error).message))
  }
  useEffect(ask, [key])
  if (error) return <>
    <p className="warn" style={{ marginTop: 10 }}>{error}</p>
    <div className="foot"><button className="pill" onClick={() => ask(true)}>重试</button><button className="pill" onClick={close}>取消</button></div>
  </>
  if (!methods) return <p className="sub" style={{ marginTop: 12 }}>正在问实验室有哪些发现方式…</p>
  const scans = methods.filter(method => !method.compose)
  if (!scans.length) return <>
    <p className="sub" style={{ marginTop: 12 }}>实验室现在没有可用的发现方式。</p>
    <div className="foot"><button className="pill" onClick={() => ask(true)}>重试</button><button className="pill" onClick={close}>取消</button></div>
  </>
  return <>
    <div className="opts">
      {scans.map(method => <button key={method.id} className="opt" onClick={() => ui.layer(next =>
        <MethodForm lab={lab} method={method} host={host} slot={slot} back={() => ui.layer(back => <MethodList lab={lab} host={host} slot={slot} close={back} />)} close={next} />)}>
        <Icon name="search" /><span><b>{method.title}</b><span>{method.about}</span></span>
      </button>)}
    </div>
    <div className="foot"><button className="pill" onClick={close}>取消</button></div>
  </>
}

// The last answer per context, so returning to the list does not ask the backend again (a method list can be slow).
const answered = new Map<string, DiscoveryMethod[]>()
const methodsFor = (key: string) => answered.get(key)
const setMethodsFor = (key: string, methods: DiscoveryMethod[]) => { answered.set(key, methods) }

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
function MethodForm({ lab, method, host, slot, back, close }: { lab: LabSettings, method: DiscoveryMethod, host?: string, slot?: string, back: () => void, close: () => void }) {
  const ui = useUI()
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
      const list = await api.discoverMethods(lab.id, { host: host ?? null, slot: slot ?? null })
      const again = list.find(item => item.id === method.id)
      if (!again) { ui.fail('刷新失败', new Error('实验室不再提供这个方式')); return }
      setFresh(again)
      setValues(prior => startValues(again, prior))
    } catch (failure) { ui.fail('刷新失败', failure) }
    finally { setLoading(false) }
  }
  const start = () => {
    setBusy(true)
    close()
    // What is left empty is not sent: the backend treats an absent optional field the same, and the run stays clear.
    const sent = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim()))
    if (method.compose) {
      // Describing a board that is already there: nothing on it is touched, so it registers at once with no confirmation.
      void api.composeBoard(lab.id, { method: method.id, values: sent, ...(host ? { host } : {}), ...(slot ? { slot } : {}) })
        .then(out => ui.toast('登记了', out.message), error => ui.fail('登记失败', error))
        .finally(() => { window.setTimeout(() => void refreshNow().catch(() => {}), 400) })
      return
    }
    // Discovery can run for minutes; the page shows its progress and its cancel button as boardd reports it.
    void api.discoverLab(lab.id, { method: method.id, values: sent, ...(host ? { host } : {}), ...(slot ? { slot } : {}) })
      .then(out => ui.toast('开始发现', out.message), error => ui.fail('发现失败', error))
    // boardd marks it running before it answers; read the state again so the cancel button appears now.
    window.setTimeout(() => void refreshNow().catch(() => {}), 400)
  }
  return <>
    <h2>{method.title}{host ? ` · ${host}` : ''}{slot ? ` / ${slot.split('/').at(-1)}` : ''}</h2>
    <div className="lead">{method.about}</div>
    {fields.map(field => <Field key={field.id} field={field} value={values[field.id] ?? ''} disabled={busy || loading}
      onChange={value => setValues(prior => ({ ...prior, [field.id]: value }))} />)}
    <div className="foot">
      <button className="pill" onClick={() => void refresh()} disabled={busy || loading}>刷新</button>
      <button className="pill" onClick={back} disabled={busy}>返回</button>
      <button className="pill dark" disabled={busy || loading || !ready} onClick={start}>{busy ? (method.compose ? '登记中…' : '开始中…') : (method.compose ? '登记' : '开始')}</button>
    </div>
  </>
}

function Field({ field, value, disabled, onChange }: { field: DiscoveryField, value: string, disabled: boolean, onChange: (value: string) => void }) {
  const note = field.note ? <span className="sub small">{field.note}</span> : null
  if (field.kind === 'choice') return <label className="field wide" style={{ marginTop: 12 }}><span>{field.label}{field.required ? '' : '（可选）'}</span>
    <select className="select" value={value} onChange={event => onChange(event.target.value)} disabled={disabled}>
      <option value="">{field.options?.length ? '选一个' : '没有可选项'}</option>
      {(field.options ?? []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    {note}
  </label>
  return <label className="field wide" style={{ marginTop: 12 }}><span>{field.label}{field.required ? '' : '（可选）'}</span>
    <input className="input" placeholder={field.placeholder ?? ''} value={value} onChange={event => onChange(event.target.value)} disabled={disabled} />
    {note}
  </label>
}

