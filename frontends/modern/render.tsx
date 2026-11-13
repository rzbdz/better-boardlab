/**
 * Modern's renderer for module views (src/ui/contract.ts). Actions spin and toast, jobs show their lines and progress
 * under their button, `open` operations a dialog, confirmations ask first. A view is a panel.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { plain, type Badge, type Element, type Field, type Inline, type ModuleUi, type Operation, type PageState, type Rich, type Values, type View, type ViewContext } from '../../src/ui/contract.ts'
import { stamp } from '../../src/ui/format.ts'
import { TerminalPage } from '../../src/ui/terminal.tsx'
import { HelpButtons } from './help.tsx'
import { Confirm, Icon, refreshNow, useUI } from './kit.tsx'

let registered: ModuleUi[] = []
export function registerModuleUis(uis: ModuleUi[]) { registered = uis }
export function viewsFor(state: PageState, slot: View['slot'], context: ViewContext = {}): View[] {
  return registered.filter(ui => state.modules.some(module => module.id === ui.module))
    .flatMap(ui => { try { return ui.views(state, context) } catch { return [] } }).filter(view => view.slot === slot)
}

const TAG: Record<Badge['tone'], string> = { neutral: '', ok: 'ok', info: 'info', warn: 'warn', error: 'bad', mine: 'info' }
const badge = (b?: Badge) => b ? <span className={`tag ${TAG[b.tone]}`}>{b.text}</span> : null
function inline(part: Inline, key: number): ReactNode {
  if (typeof part === 'string') return part
  if ('code' in part) return <code key={key} className="mono">{part.code}</code>
  if ('strong' in part) return <b key={key}>{part.strong}</b>
  if ('link' in part) return <a key={key} href={part.href} target="_blank" rel="noreferrer">{part.link}</a>
  if ('muted' in part) return <span key={key} className="sub">{part.muted}</span>
  return <span key={key} className="mono">{stamp(part.time)}</span>
}
export const rich = (value: Rich): ReactNode => Array.isArray(value) ? value.map(inline) : inline(value, 0)

interface Ctx { selections: Record<string, string[]>, setSelection: (id: string, values: string[]) => void }

function useOperation(op: Operation, ctx: Ctx, values: () => Values, onDone?: () => void) {
  const ui = useUI()
  const [busy, setBusy] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [fraction, setFraction] = useState<number | null>(null)
  const [step, setStep] = useState<string | null>(null)
  // A line `[n/N] …` says the job is at step n of N (Sink in src/ui/contract.ts).
  const line = (text: string) => {
    const at = /^\[(\d+)\/(\d+)\]/.exec(text)
    if (at && Number(at[2]) > 0) { setStep(`${at[1]}/${at[2]}`); setFraction(Math.min(1, Number(at[1]) / Number(at[2]))) }
    setLines(list => [...list.slice(-200), text])
  }
  const input = () => ({ ...values(), ...Object.fromEntries((op.using ?? []).map(id => [id, ctx.selections[id] ?? []])) })
  const go = async () => {
    if (op.kind === 'open') { ui.layer(close => <><h2>{op.title}</h2><div className="mv" style={{ marginTop: 12 }}><Elements body={op.body()} ctx={ctx} onDone={close} /></div></>, 'wide'); return }
    setBusy(true)
    try {
      const out = op.kind === 'action' ? await op.run(input())
        : (setLines([]), setFraction(null), setStep(null), await op.start(input(), { line, progress: setFraction }, new AbortController().signal))
      ui.toast(out.message || `${op.label}：好了`); onDone?.()
    } catch (error) { ui.fail(`${op.label}失败`, error) } finally { await refreshNow().catch(() => {}); setBusy(false) }
  }
  const trigger = () => op.confirm
    ? ui.layer(close => <Confirm title={op.confirm!.title} ok={op.confirm!.action} danger={op.intent === 'danger'} close={close} onOk={() => void go()}>{plain(op.confirm!.body)}</Confirm>)
    : void go()
  return { trigger, busy, lines, fraction, step }
}

function OpButton({ op, ctx, values = () => ({}), onDone }: { op: Operation, ctx: Ctx, values?: () => Values, onDone?: () => void }) {
  const run = useOperation(op, ctx, values, onDone)
  return (
    <>
      <button className={`pill sm${op.intent === 'primary' ? ' dark' : op.intent === 'danger' ? ' danger-o' : ''}`} disabled={!!op.blocked || run.busy} title={op.blocked} onClick={run.trigger}>{run.busy && <span className="spin" />}{op.label}</button>
      {op.kind === 'job' && (run.busy || run.lines.length > 0) && (
        <div style={{ flexBasis: '100%', display: 'grid', gap: 6 }}>
          {run.step && <span className="sub small">步骤 {run.step}</span>}
          {run.fraction !== null && <div className="mv-progress"><i style={{ width: `${Math.round(run.fraction * 100)}%` }} /></div>}
          <pre className="mv-pre">{run.lines.slice(-30).join('\n')}</pre>
        </div>
      )}
    </>
  )
}

const initial = (fields: Field[]): Values => Object.fromEntries(fields.map(f => [f.id, f.kind === 'secret' ? '' : f.kind === 'switch' ? !!f.initial : f.kind === 'choice' ? f.initial ?? f.options[0]?.value ?? '' : f.initial ?? '']))

function FieldInput({ field, values, set }: { field: Field, values: Values, set: (id: string, value: Values[string]) => void }) {
  const value = values[field.id]
  const label = field.doc ? <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{field.label}<HelpButtons view={{ title: field.label, help: field.doc }} ai={false} /></span> : field.label
  const wrap = (control: ReactNode, wide = false) => <label className={`field${wide ? ' wide' : ''}`}>{label}{control}{'help' in field && field.help && <span className="sub small" style={{ fontWeight: 400 }}>{rich(field.help)}</span>}</label>
  switch (field.kind) {
    case 'switch': return <div className="toggle wide"><span>{field.label}</span><button type="button" className={`sw${value ? ' on' : ''}`} aria-label={field.label} onClick={() => set(field.id, !value)} /></div>
    case 'choice': return wrap(<select className="select" value={String(value ?? '')} onChange={e => set(field.id, e.target.value)}>{field.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>)
    case 'code': return wrap(<textarea className="textarea" rows={field.rows ?? 4} spellCheck={false} required={field.required} placeholder={field.placeholder} value={String(value ?? '')} onChange={e => set(field.id, e.target.value)} />, true)
    case 'number': return wrap(<input className="input" type="number" min={field.min} max={field.max} required={field.required} disabled={field.disabled} value={value === undefined ? '' : String(value)} onChange={e => set(field.id, e.target.value)} />)
    case 'secret': return wrap(<input className="input" type="password" autoComplete="off" placeholder={field.placeholder} value={String(value ?? '')} onChange={e => set(field.id, e.target.value)} />)
    default: return wrap(<input className="input" required={field.required} disabled={field.disabled} pattern={field.pattern} placeholder={field.placeholder} value={String(value ?? '')} onChange={e => set(field.id, e.target.value)} />, field.wide)
  }
}

function Form({ element, ctx, onDone }: { element: Extract<Element, { kind: 'form' }>, ctx: Ctx, onDone?: () => void }) {
  const [values, setValues] = useState<Values>(() => initial(element.fields))
  const set = (id: string, value: Values[string]) => setValues(current => ({ ...current, [id]: value }))
  const submit = useOperation(element.submit, ctx, () => values, () => { setValues(initial(element.fields)); onDone?.() })
  return (
    <form className="form" onSubmit={e => { e.preventDefault(); submit.trigger() }}>
      {element.fields.map(f => <FieldInput key={f.id} field={f} values={values} set={set} />)}
      <div className="row-acts">
        <button className="pill sm dark" type="submit" disabled={submit.busy || !!element.submit.blocked}>{submit.busy && <span className="spin" />}{element.submitLabel}</button>
        {element.secondary?.map(op => <OpButton key={op.id} op={op} ctx={ctx} values={() => values} />)}
        {element.note && <span className="sub small">{rich(element.note)}</span>}
      </div>
    </form>
  )
}

function Details({ element, ctx }: { element: Extract<Element, { kind: 'details' }>, ctx: Ctx }) {
  const [body, setBody] = useState<Element[] | null>(null)
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button className="sub small" style={{ display: 'flex', alignItems: 'center', gap: 4 }} onClick={async () => { setOpen(!open); if (!body) setBody(await element.load()) }}>
        <Icon name="chev" className={open ? 'rot' : ''} />{rich(element.summary)}
      </button>
      {open && body && <div className="mv" style={{ marginTop: 8 }}><Elements body={body} ctx={ctx} /></div>}
    </div>
  )
}

function Live({ element }: { element: Extract<Element, { kind: 'live' }> }) {
  const [lines, setLines] = useState<string[]>([])
  const box = useRef<HTMLPreElement>(null)
  useEffect(() => element.stream.open({ line: text => setLines(list => [...list.slice(-800), text]) }), [element.stream.id])
  useEffect(() => { box.current?.scrollTo?.({ top: box.current.scrollHeight }) }, [lines])
  return <pre ref={box} className={`mv-pre${element.height === 'large' ? ' large' : ''}`}>{lines.join('\n')}</pre>
}

function One({ element, ctx, onDone }: { element: Element, ctx: Ctx, onDone?: () => void }): ReactNode {
  switch (element.kind) {
    case 'text': return element.tone && element.tone !== 'neutral' ? <div className={`mv-note ${element.tone === 'error' ? 'error' : element.tone === 'warn' ? 'warn' : ''}`}>{rich(element.text)}</div> : <p className="mv-text">{rich(element.text)}</p>
    case 'facts': return <dl className="mv-facts">{element.items.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{rich(item.value)}</dd></div>)}</dl>
    case 'form': return <Form element={element} ctx={ctx} onDone={onDone} />
    case 'actions': return <div className="acts" style={{ marginLeft: 0 }}>{element.actions.map(op => <OpButton key={op.id} op={op} ctx={ctx} onDone={onDone} />)}</div>
    case 'list': return element.items.length ? (
      <div className="mv-list">{element.items.map(item => (
        <div key={item.key}>
          {item.tag && <span className="tag">{item.tag}</span>}
          <div className="mv-li-text"><div className="mv-li-title">{rich(item.title)}</div>{item.description && <div className="mv-li-desc">{rich(item.description)}</div>}</div>
          {badge(item.status)}{item.actions?.map(op => <OpButton key={op.id} op={op} ctx={ctx} />)}
        </div>
      ))}</div>
    ) : element.empty ? <p className="mv-text">{rich(element.empty)}</p> : null
    case 'table': return element.rows.length ? (
      <div style={{ overflow: 'auto' }}><table className="mv-table">
        <thead><tr>{element.columns.map(c => <th key={c.key}>{c.title}</th>)}{element.rows.some(r => r.actions?.length) && <th />}</tr></thead>
        <tbody>{element.rows.map(row => <tr key={row.key} className={row.tone === 'warn' ? 'warn-t' : row.tone === 'error' ? 'bad-t' : undefined}>
          {element.columns.map(c => <td key={c.key}>{rich(row.cells[c.key] ?? '')}</td>)}
          {row.actions?.length ? <td style={{ textAlign: 'right' }}>{row.actions.map(op => <OpButton key={op.id} op={op} ctx={ctx} />)}</td> : null}
        </tr>)}</tbody>
      </table></div>
    ) : element.empty ? <p className="mv-text">{rich(element.empty)}</p> : null
    case 'select-many': {
      const chosen = ctx.selections[element.id] ?? element.initial
      return (
        <fieldset disabled={element.disabled} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 6 }}>
          <legend className="sub small" style={{ fontWeight: 600, marginBottom: 6 }}>{element.label}</legend>
          <div className="mv-pick">{element.options.map(option => (
            <label key={option.value} className={chosen.includes(option.value) ? 'on' : ''}>
              <input type="checkbox" checked={chosen.includes(option.value)} onChange={e => ctx.setSelection(element.id, e.target.checked ? [...chosen, option.value] : chosen.filter(v => v !== option.value))} />
              {option.label}{option.note && <span className="sub">{option.note}</span>}
            </label>
          ))}</div>
        </fieldset>
      )
    }
    case 'timeline': return <ol className="mv-timeline">{element.items.map(item => (
      <li key={item.key} className={item.tone === 'error' ? 'error' : item.tone === 'warn' ? 'warn' : ''}><span className="mono faint" style={{ marginRight: 8 }}>{item.at ? stamp(item.at, false) : ''}</span>{item.tag && <span className="tag" style={{ marginRight: 6 }}>{item.tag}</span>}{rich(item.text)}</li>
    ))}</ol>
    case 'progress': return <div style={{ display: 'grid', gap: 5 }}><span className="sub small">{rich(element.label)}</span>{element.fraction != null && <div className="mv-progress"><i style={{ width: `${Math.round(element.fraction * 100)}%` }} /></div>}</div>
    case 'live': return <Live element={element} />
    case 'details': return <Details element={element} ctx={ctx} />
    case 'group': return element.layout === 'columns'
      ? <div className="mv-cols"><Elements body={element.body} ctx={ctx} onDone={onDone} /></div>
      : <div className="mv-group">{element.title && <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>{element.title}{badge(element.status)}{element.help && <HelpButtons view={{ title: element.title, help: element.help }} ai={false} />}</div>}<Elements body={element.body} ctx={ctx} onDone={onDone} /></div>
    case 'custom': return element.type === 'terminal.page' ? <TerminalWithToasts api={String((element.data as { api?: string }).api ?? 'api/terminals')} /> : <Elements body={element.fallback} ctx={ctx} onDone={onDone} />
  }
}

export function Elements({ body, ctx, onDone }: { body: Element[], ctx: Ctx, onDone?: () => void }) {
  return <>{body.map((element, index) => <One key={index} element={element} ctx={ctx} onDone={onDone} />)}</>
}

function TerminalWithToasts({ api }: { api: string }) {
  const ui = useUI()
  return <TerminalPage base={api} onError={(title, error) => ui.fail(title, error)} />
}

/**
 * A module's page (a `page` view). One that draws itself (the terminal's custom element) fills the window; any other is
 * a page like the others: a title, then its body in a panel.
 */
export function ViewPage({ view }: { view: View }) {
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const ctx: Ctx = { selections, setSelection: (id, values) => setSelections(current => ({ ...current, [id]: values })) }
  if (view.body.some(element => element.kind === 'custom')) return <div className="module-page"><Elements body={view.body} ctx={ctx} /></div>
  return (
    <div className="page">
      <section className="hero"><h1>{view.title ?? view.id}</h1></section>
      <section className="panel"><Elements body={view.body} ctx={ctx} /></section>
    </div>
  )
}

/** A module's view as a panel. */
export function ViewPanel({ view }: { view: View }) {
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const ctx: Ctx = { selections, setSelection: (id, values) => setSelections(current => ({ ...current, [id]: values })) }
  return (
    <section className="panel">
      {view.title && <h2>{view.title}{badge(view.status)}<HelpButtons view={view} /></h2>}
      <div className="mv" style={{ marginTop: view.title ? 10 : 0 }}><Elements body={view.body} ctx={ctx} /></div>
    </section>
  )
}
