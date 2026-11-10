/**
 * TroyMitchellDefault's renderer for module views (src/ui/contract.ts): every element kind drawn with this frontend's
 * own pieces (panels, pills, forms, lists), and every operation run the way this frontend runs things (confirm in a
 * dialog, a toast when done, a job's lines under its button).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { plain, type Badge, type Element, type Field, type Inline, type ModuleUi, type Operation, type PageState, type Rich, type Values, type View, type ViewContext } from '../../src/ui/contract.ts'
import { Dialog, Pill, Section, time, type Prompt, type Run } from './kit.tsx'

let registered: ModuleUi[] = []
export function registerModuleUis(uis: ModuleUi[]) { registered = uis }

/** The views of the loaded modules for one slot of the page. */
export function viewsFor(state: PageState, slot: View['slot'], context: ViewContext = {}): View[] {
  return registered.filter(ui => state.modules.some(module => module.id === ui.module))
    .flatMap(ui => { try { return ui.views(state, context) } catch { return [] } }).filter(view => view.slot === slot)
}

const TONE: Record<Badge['tone'], 'ok' | 'warn' | 'mine' | 'err'> = { neutral: 'mine', ok: 'ok', info: 'mine', warn: 'warn', error: 'err', mine: 'mine' }

function inline(part: Inline, key: number): ReactNode {
  if (typeof part === 'string') return part
  if ('code' in part) return <code key={key}>{part.code}</code>
  if ('strong' in part) return <b key={key}>{part.strong}</b>
  if ('link' in part) return <a key={key} href={part.href} target="_blank" rel="noreferrer">{part.link}</a>
  if ('muted' in part) return <span key={key} className="muted">{part.muted}</span>
  return <time key={key}>{time(part.time)}</time>
}
export const rich = (value: Rich): ReactNode => Array.isArray(value) ? value.map(inline) : inline(value, 0)

interface Ctx { onRun: Run, onPrompt: (prompt: Prompt) => void, selections: Record<string, string[]> }

/** Run one operation: confirm first if it asks, then run it as an action, a job (its lines shown while it runs) or open it. */
function useOperation(op: Operation, ctx: Ctx, values: () => Values, onDone?: () => void) {
  const [lines, setLines] = useState<string[]>([])
  const [fraction, setFraction] = useState<number | null>(null)
  const [running, setRunning] = useState(false)
  const [opened, setOpened] = useState(false)
  const input = () => ({ ...values(), ...Object.fromEntries((op.using ?? []).map(id => [id, ctx.selections[id] ?? []])) })
  const go = async () => {
    if (op.kind === 'open') { setOpened(true); return }
    if (op.kind === 'action') return ctx.onRun(op.label, async () => { const out = await op.run(input()); onDone?.(); return out.message }).then(() => {})
    setRunning(true); setLines([]); setFraction(null)
    const abort = new AbortController()
    await ctx.onRun(op.label, async () => {
      try { const out = await op.start(input(), { line: text => setLines(list => [...list.slice(-200), text]), progress: setFraction }, abort.signal); onDone?.(); return out.message }
      finally { setRunning(false) }
    })
  }
  const trigger = () => op.confirm
    ? ctx.onPrompt({ kind: 'confirm', title: op.confirm.title, body: plain(op.confirm.body), action: op.confirm.action, danger: op.intent === 'danger', run: go })
    : void go()
  return { trigger, lines, fraction, running, opened, close: () => setOpened(false) }
}

function OperationButton({ op, ctx, values = () => ({}), onDone, submit }: { op: Operation, ctx: Ctx, values?: () => Values, onDone?: () => void, submit?: boolean }) {
  const run = useOperation(op, ctx, values, onDone)
  const cls = op.intent === 'primary' ? 'primary' : op.intent === 'danger' ? 'danger' : ''
  return (
    <>
      <button type={submit ? 'submit' : 'button'} className={cls} disabled={!!op.blocked || run.running} title={op.blocked}
        onClick={submit ? undefined : run.trigger}>{run.running ? `${op.label}…` : op.label}</button>
      {(run.running || run.lines.length > 0) && op.kind === 'job' && (
        <div className="span job-log">
          {run.fraction !== null && <progress value={run.fraction} max={1} />}
          <ol className="steps">{run.lines.slice(-12).map((line, index) => <li key={index}><span>{line}</span></li>)}</ol>
        </div>
      )}
      {run.opened && op.kind === 'open' && (
        <Dialog title={op.title} onClose={run.close} actions={<button onClick={run.close}>关闭</button>}>
          <Elements body={op.body()} ctx={ctx} onDone={run.close} />
        </Dialog>
      )}
    </>
  )
}

function FieldInput({ field, values, set }: { field: Field, values: Values, set: (id: string, value: Values[string]) => void }) {
  const value = values[field.id]
  switch (field.kind) {
    case 'switch': return <label className="switch span"><input type="checkbox" checked={!!value} onChange={event => set(field.id, event.target.checked)} />{field.label}</label>
    case 'choice': return <label>{field.label}<select value={String(value ?? '')} onChange={event => set(field.id, event.target.value)}>{field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    case 'code': return <label className="span">{field.label}<textarea rows={field.rows ?? 4} spellCheck={false} required={field.required} value={String(value ?? '')} placeholder={field.placeholder} onChange={event => set(field.id, event.target.value)} /></label>
    case 'number': return <label>{field.label}<input type="number" min={field.min} max={field.max} required={field.required} disabled={field.disabled} value={value === undefined ? '' : String(value)} onChange={event => set(field.id, event.target.value)} /></label>
    case 'secret': return <label>{field.label}<input type="password" autoComplete="off" value={String(value ?? '')} placeholder={field.placeholder} onChange={event => set(field.id, event.target.value)} /></label>
    default: return <label className={field.wide ? 'span' : ''}>{field.label}<input value={String(value ?? '')} placeholder={field.placeholder} required={field.required} disabled={field.disabled} pattern={field.pattern} onChange={event => set(field.id, event.target.value)} /></label>
  }
}

function initialValues(fields: Field[]): Values {
  return Object.fromEntries(fields.map(field => [field.id, field.kind === 'secret' ? '' : field.kind === 'switch' ? !!field.initial : field.kind === 'choice' ? field.initial ?? field.options[0]?.value ?? '' : field.initial ?? '']))
}

function Form({ element, ctx, onDone }: { element: Extract<Element, { kind: 'form' }>, ctx: Ctx, onDone?: () => void }) {
  const [values, setValues] = useState<Values>(() => initialValues(element.fields))
  const set = (id: string, value: Values[string]) => setValues(current => ({ ...current, [id]: value }))
  const submit = useOperation(element.submit, ctx, () => values, () => { setValues(initialValues(element.fields)); onDone?.() })
  return (
    <form className="form-grid" onSubmit={event => { event.preventDefault(); submit.trigger() }}>
      {element.fields.map(field => <FieldInput key={field.id} field={field} values={values} set={set} />)}
      <div className="actions span">
        <button className="primary" disabled={!!element.submit.blocked || submit.running}>{element.submitLabel}</button>
        {element.secondary?.map(op => <OperationButton key={op.id} op={op} ctx={ctx} values={() => values} />)}
        {element.note && <span className="muted">{rich(element.note)}</span>}
      </div>
    </form>
  )
}

function SelectMany({ element, ctx, onChange }: { element: Extract<Element, { kind: 'select-many' }>, ctx: Ctx, onChange: (values: string[]) => void }) {
  const chosen = ctx.selections[element.id] ?? element.initial
  const toggle = (value: string) => onChange(chosen.includes(value) ? chosen.filter(item => item !== value) : [...chosen, value])
  return (
    <fieldset className="toggles" disabled={element.disabled} aria-label={element.label}>
      {element.options.map(option => (
        <label key={option.value} className={chosen.includes(option.value) ? 'on' : ''}>
          <input type="checkbox" checked={chosen.includes(option.value)} onChange={() => toggle(option.value)} />
          <span>{option.label}</span>{option.note && <small>{option.note}</small>}
        </label>
      ))}
    </fieldset>
  )
}

function Details({ element, ctx }: { element: Extract<Element, { kind: 'details' }>, ctx: Ctx }) {
  const [body, setBody] = useState<Element[] | null>(null)
  return body ? <div className="evidence"><Elements body={body} ctx={ctx} /></div>
    : <button className="link" onClick={async () => setBody(await element.load())}>{rich(element.summary)}</button>
}

function Live({ element }: { element: Extract<Element, { kind: 'live' }> }) {
  const [lines, setLines] = useState<string[]>([])
  useEffect(() => element.stream.open({ line: text => setLines(list => [...list.slice(-500), text]) }), [element.stream.id])
  return <pre className={`live ${element.height ?? 'small'}`}>{lines.join('\n')}</pre>
}

function One({ element, ctx, onDone }: { element: Element, ctx: Ctx, onDone?: () => void }): ReactNode {
  switch (element.kind) {
    case 'text': return <p className={element.tone === 'warn' || element.tone === 'error' ? 'warn' : 'muted'}>{rich(element.text)}</p>
    case 'facts': return <dl className="facts">{element.items.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{rich(item.value)}</dd></div>)}</dl>
    case 'form': return <Form element={element} ctx={ctx} onDone={onDone} />
    case 'actions': return <div className="actions">{element.actions.map(op => <OperationButton key={op.id} op={op} ctx={ctx} onDone={onDone} />)}</div>
    case 'list': return element.items.length ? (
      <ul className="images">{element.items.map(item => (
        <li key={item.key}>
          {item.tag && <span className="slot-tag">{item.tag}</span>}
          <div className="grow"><b>{rich(item.title)}</b>{item.description && <small>{rich(item.description)}</small>}</div>
          {item.status && <Pill tone={TONE[item.status.tone]}>{item.status.text}</Pill>}
          {item.actions?.map(op => <OperationButton key={op.id} op={op} ctx={ctx} />)}
        </li>
      ))}</ul>
    ) : element.empty ? <p className="muted">{rich(element.empty)}</p> : null
    case 'table': return element.rows.length ? (
      <div className="table-wrap"><table>
        <thead><tr>{element.columns.map(column => <th key={column.key}>{column.title}</th>)}<th /></tr></thead>
        <tbody>{element.rows.map(row => <tr key={row.key} className={row.tone === 'warn' || row.tone === 'error' ? 'warn' : ''}>
          {element.columns.map(column => <td key={column.key}>{rich(row.cells[column.key] ?? '')}</td>)}
          <td>{row.actions?.map(op => <OperationButton key={op.id} op={op} ctx={ctx} />)}</td>
        </tr>)}</tbody>
      </table></div>
    ) : element.empty ? <p className="muted">{rich(element.empty)}</p> : null
    case 'select-many': return <SelectMany element={element} ctx={ctx} onChange={values => { ctx.selections[element.id] = values }} />
    case 'timeline': return <ol className="steps">{element.items.map(item => <li key={item.key}>{item.at && <time>{time(item.at, false)}</time>}<span className={`slot-tag ${item.tag ? '' : 'ghost'}`}>{item.tag ?? '·'}</span><span>{rich(item.text)}</span></li>)}</ol>
    case 'progress': return <div className="job-log"><p className="muted">{rich(element.label)}</p>{element.fraction != null && <progress value={element.fraction} max={1} />}</div>
    case 'live': return <Live element={element} />
    case 'details': return <Details element={element} ctx={ctx} />
    case 'group': return <div className="group">{element.title && <h4>{element.title}{element.status && <Pill tone={TONE[element.status.tone]}>{element.status.text}</Pill>}</h4>}<Elements body={element.body} ctx={ctx} onDone={onDone} /></div>
    // This frontend adapts to no module's custom elements: it shows what every frontend can.
    case 'custom': return <Elements body={element.fallback} ctx={ctx} onDone={onDone} />
  }
}

export function Elements({ body, ctx, onDone }: { body: Element[], ctx: Ctx, onDone?: () => void }) {
  return <>{body.map((element, index) => <One key={index} element={element} ctx={ctx} onDone={onDone} />)}</>
}

/** A module's view as one of this frontend's panels. */
export function ViewPanel({ view, onRun, onPrompt }: { view: View, onRun: Run, onPrompt: (prompt: Prompt) => void }) {
  const [selections] = useState<Record<string, string[]>>({})
  return (
    <Section title={view.title ?? ''} extra={view.status ? <Pill tone={TONE[view.status.tone]}>{view.status.text}</Pill> : null}>
      <Elements body={view.body} ctx={{ onRun, onPrompt, selections }} />
    </Section>
  )
}
