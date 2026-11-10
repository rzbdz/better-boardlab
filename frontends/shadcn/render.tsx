/**
 * The shadcn frontend's renderer for module views (src/ui/contract.ts): each element as shadcn components. Actions show
 * a spinner and a toast, jobs report their lines and progress under their button, `open` operations a dialog.
 */
import { ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { plain, type Badge as ViewBadge, type Element, type Field, type Inline, type ModuleUi, type Operation, type PageState, type Rich, type Tone, type Values, type View, type ViewContext } from '../../src/ui/contract.ts'
import { stamp } from '../../src/ui/format.ts'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Dialog, Input, Label, NativeSelect, Switch, Table, TBody, TD, TH, THead, TR, Textarea, cn } from './ui/index.tsx'

let registered: ModuleUi[] = []
export function registerModuleUis(uis: ModuleUi[]) { registered = uis }
export function viewsFor(state: PageState, slot: View['slot'], context: ViewContext = {}): View[] {
  return registered.filter(ui => state.modules.some(module => module.id === ui.module))
    .flatMap(ui => { try { return ui.views(state, context) } catch { return [] } }).filter(view => view.slot === slot)
}

const VARIANT: Record<Tone, 'secondary' | 'ok' | 'info' | 'warn' | 'destructive'> = { neutral: 'secondary', ok: 'ok', info: 'info', warn: 'warn', error: 'destructive', mine: 'info' }
const badge = (status?: ViewBadge) => status ? <Badge variant={VARIANT[status.tone]}>{status.text}</Badge> : null

function inline(part: Inline, key: number): ReactNode {
  if (typeof part === 'string') return part
  if ('code' in part) return <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">{part.code}</code>
  if ('strong' in part) return <b key={key} className="font-semibold">{part.strong}</b>
  if ('link' in part) return <a key={key} href={part.href} target="_blank" rel="noreferrer" className="underline underline-offset-4">{part.link}</a>
  if ('muted' in part) return <span key={key} className="text-muted-foreground">{part.muted}</span>
  return <span key={key} className="tabular-nums">{stamp(part.time)}</span>
}
const rich = (value: Rich): ReactNode => Array.isArray(value) ? value.map(inline) : inline(value, 0)

interface Ctx { selections: Record<string, string[]>, setSelection: (id: string, values: string[]) => void, confirm: (op: Operation, go: () => void) => void }

function useOperation(op: Operation, ctx: Ctx, values: () => Values, onDone?: () => void) {
  const [busy, setBusy] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [fraction, setFraction] = useState<number | null>(null)
  const [opened, setOpened] = useState(false)
  const input = () => ({ ...values(), ...Object.fromEntries((op.using ?? []).map(id => [id, ctx.selections[id] ?? []])) })
  const go = async () => {
    if (op.kind === 'open') { setOpened(true); return }
    setBusy(true)
    try {
      const out = op.kind === 'action' ? await op.run(input())
        : (setLines([]), setFraction(null), await op.start(input(), { line: text => setLines(list => [...list.slice(-200), text]), progress: setFraction }, new AbortController().signal))
      toast.success(out.message || `${op.label}：完成`); onDone?.()
    } catch (error) { toast.error((error as Error).message) } finally { setBusy(false) }
  }
  const trigger = () => op.confirm ? ctx.confirm(op, () => void go()) : void go()
  return { trigger, busy, lines, fraction, opened, close: () => setOpened(false) }
}

function OperationButton({ op, ctx, values = () => ({}), onDone, size = 'sm' }: { op: Operation, ctx: Ctx, values?: () => Values, onDone?: () => void, size?: 'sm' | 'default' }) {
  const run = useOperation(op, ctx, values, onDone)
  return (
    <>
      <Button size={size} variant={op.intent === 'primary' ? 'default' : op.intent === 'danger' ? 'destructive' : 'outline'} loading={run.busy} disabled={!!op.blocked} title={op.blocked} onClick={run.trigger}>{op.label}</Button>
      {op.kind === 'job' && (run.busy || run.lines.length > 0) && (
        <div className="basis-full space-y-1.5">
          {run.fraction !== null && <div className="h-1 overflow-hidden rounded bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${Math.round(run.fraction * 100)}%` }} /></div>}
          <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-relaxed">{run.lines.slice(-30).join('\n')}</pre>
        </div>
      )}
      {op.kind === 'open' && <Dialog open={run.opened} onOpenChange={open => !open && run.close()} title={op.title}><div className="grid gap-3"><Elements body={op.body()} ctx={ctx} onDone={run.close} /></div></Dialog>}
    </>
  )
}

function initial(fields: Field[]): Values {
  return Object.fromEntries(fields.map(field => [field.id, field.kind === 'secret' ? '' : field.kind === 'switch' ? !!field.initial : field.kind === 'choice' ? field.initial ?? field.options[0]?.value ?? '' : field.initial ?? '']))
}

function FieldInput({ field, values, set }: { field: Field, values: Values, set: (id: string, value: Values[string]) => void }) {
  const value = values[field.id]
  const wrap = (control: ReactNode, wide = false) => <div className={cn('grid gap-1.5', wide && 'sm:col-span-2')}><Label htmlFor={field.id}>{field.label}</Label>{control}{'help' in field && field.help && <p className="text-xs text-muted-foreground">{rich(field.help)}</p>}</div>
  switch (field.kind) {
    case 'switch': return <div className="flex items-center gap-2 sm:col-span-2"><Switch checked={!!value} onCheckedChange={next => set(field.id, next)} /><span className="text-[13px]">{field.label}</span></div>
    case 'choice': return wrap(<NativeSelect id={field.id} value={String(value ?? '')} onChange={event => set(field.id, event.target.value)}>{field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</NativeSelect>)
    case 'code': return wrap(<Textarea id={field.id} rows={field.rows ?? 4} spellCheck={false} required={field.required} placeholder={field.placeholder} value={String(value ?? '')} onChange={event => set(field.id, event.target.value)} />, true)
    case 'number': return wrap(<Input id={field.id} type="number" min={field.min} max={field.max} required={field.required} disabled={field.disabled} value={value === undefined ? '' : String(value)} onChange={event => set(field.id, event.target.value)} />)
    case 'secret': return wrap(<Input id={field.id} type="password" autoComplete="off" placeholder={field.placeholder} value={String(value ?? '')} onChange={event => set(field.id, event.target.value)} />)
    default: return wrap(<Input id={field.id} required={field.required} disabled={field.disabled} pattern={field.pattern} placeholder={field.placeholder} value={String(value ?? '')} onChange={event => set(field.id, event.target.value)} />, field.wide)
  }
}

function Form({ element, ctx, onDone }: { element: Extract<Element, { kind: 'form' }>, ctx: Ctx, onDone?: () => void }) {
  const [values, setValues] = useState<Values>(() => initial(element.fields))
  const set = (id: string, value: Values[string]) => setValues(current => ({ ...current, [id]: value }))
  const submit = useOperation(element.submit, ctx, () => values, () => { setValues(initial(element.fields)); onDone?.() })
  return (
    <form className="grid max-w-2xl gap-3 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); submit.trigger() }}>
      {element.fields.map(field => <FieldInput key={field.id} field={field} values={values} set={set} />)}
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
        <Button size="sm" type="submit" loading={submit.busy} disabled={!!element.submit.blocked}>{element.submitLabel}</Button>
        {element.secondary?.map(op => <OperationButton key={op.id} op={op} ctx={ctx} values={() => values} />)}
        {element.note && <span className="text-xs text-muted-foreground">{rich(element.note)}</span>}
      </div>
    </form>
  )
}

function Details({ element, ctx }: { element: Extract<Element, { kind: 'details' }>, ctx: Ctx }) {
  const [body, setBody] = useState<Element[] | null>(null)
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button className="flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground" onClick={async () => { setOpen(!open); if (!body) setBody(await element.load()) }}>
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />{rich(element.summary)}
      </button>
      {open && body && <div className="mt-2 grid gap-2"><Elements body={body} ctx={ctx} /></div>}
    </div>
  )
}

function Live({ element }: { element: Extract<Element, { kind: 'live' }> }) {
  const [lines, setLines] = useState<string[]>([])
  const box = useRef<HTMLPreElement>(null)
  useEffect(() => element.stream.open({ line: text => setLines(list => [...list.slice(-800), text]) }), [element.stream.id])
  useEffect(() => { box.current?.scrollTo?.({ top: box.current.scrollHeight }) }, [lines])
  return <pre ref={box} className={cn('logview', element.height === 'large' ? 'max-h-[480px]' : 'max-h-56')}>{lines.join('\n')}</pre>
}

function One({ element, ctx, onDone }: { element: Element, ctx: Ctx, onDone?: () => void }): ReactNode {
  switch (element.kind) {
    case 'text': return element.tone && element.tone !== 'neutral'
      ? <div className={cn('rounded-md border px-3 py-2 text-[13px]', element.tone === 'error' ? 'border-destructive/40 bg-destructive/5 text-destructive' : element.tone === 'warn' ? 'border-warn/40 bg-warn/5' : 'bg-muted/50')}>{rich(element.text)}</div>
      : <p className="text-[13px] leading-relaxed text-muted-foreground">{rich(element.text)}</p>
    case 'facts': return <dl className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-4 gap-y-2">{element.items.map(item => <div key={item.label}><dt className="text-[11px] text-muted-foreground">{item.label}</dt><dd className="truncate text-[13px]">{rich(item.value)}</dd></div>)}</dl>
    case 'form': return <Form element={element} ctx={ctx} onDone={onDone} />
    case 'actions': return <div className="flex flex-wrap gap-2">{element.actions.map(op => <OperationButton key={op.id} op={op} ctx={ctx} onDone={onDone} />)}</div>
    case 'list': return element.items.length ? (
      <ul className="divide-y rounded-md border">{element.items.map(item => (
        <li key={item.key} className="flex flex-wrap items-center gap-3 px-3 py-2">
          {item.tag && <Badge variant="outline">{item.tag}</Badge>}
          <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-medium">{rich(item.title)}</div>{item.description && <div className="truncate text-xs text-muted-foreground">{rich(item.description)}</div>}</div>
          {badge(item.status)}
          {item.actions?.map(op => <OperationButton key={op.id} op={op} ctx={ctx} />)}
        </li>
      ))}</ul>
    ) : element.empty ? <p className="text-[13px] text-muted-foreground">{rich(element.empty)}</p> : null
    case 'table': return element.rows.length ? (
      <div className="overflow-auto rounded-md border"><Table>
        <THead><TR>{element.columns.map(column => <TH key={column.key}>{column.title}</TH>)}{element.rows.some(row => row.actions?.length) && <TH />}</TR></THead>
        <TBody>{element.rows.map(row => <TR key={row.key} className={row.tone === 'warn' ? 'text-warn' : row.tone === 'error' ? 'text-destructive' : undefined}>
          {element.columns.map(column => <TD key={column.key}>{rich(row.cells[column.key] ?? '')}</TD>)}
          {row.actions?.length ? <TD className="text-right">{row.actions.map(op => <OperationButton key={op.id} op={op} ctx={ctx} />)}</TD> : null}
        </TR>)}</TBody>
      </Table></div>
    ) : element.empty ? <p className="text-[13px] text-muted-foreground">{rich(element.empty)}</p> : null
    case 'select-many': {
      const chosen = ctx.selections[element.id] ?? element.initial
      return (
        <fieldset className="grid gap-2" disabled={element.disabled}>
          <legend className="mb-1 text-xs font-medium text-muted-foreground">{element.label}</legend>
          <div className="flex flex-wrap gap-2">{element.options.map(option => (
            <label key={option.value} className={cn('flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-[13px]', chosen.includes(option.value) && 'border-foreground/40 bg-muted')}>
              <Checkbox checked={chosen.includes(option.value)} onCheckedChange={on => ctx.setSelection(element.id, on ? [...chosen, option.value] : chosen.filter(value => value !== option.value))} />
              {option.label}{option.note && <span className="text-xs text-muted-foreground">{option.note}</span>}
            </label>
          ))}</div>
        </fieldset>
      )
    }
    case 'timeline': return <ol className="relative ml-1 border-l pl-4">{element.items.map(item => (
      <li key={item.key} className="relative pb-2 text-[13px]"><span className={cn('absolute -left-[21px] top-1.5 size-2 rounded-full border-2 border-background', item.tone === 'error' ? 'bg-destructive' : item.tone === 'warn' ? 'bg-warn' : 'bg-foreground/60')} />
        <span className="mr-2 font-mono text-[11px] tabular-nums text-muted-foreground">{item.at ? stamp(item.at, false) : ''}</span>{item.tag && <Badge variant="outline" className="mr-2">{item.tag}</Badge>}{rich(item.text)}</li>
    ))}</ol>
    case 'progress': return <div className="grid gap-1.5"><span className="text-xs text-muted-foreground">{rich(element.label)}</span>{element.fraction != null && <div className="h-1 overflow-hidden rounded bg-muted"><div className="h-full bg-primary" style={{ width: `${Math.round(element.fraction * 100)}%` }} /></div>}</div>
    case 'live': return <Live element={element} />
    case 'details': return <Details element={element} ctx={ctx} />
    case 'group': return element.layout === 'columns'
      ? <div className="grid gap-3 md:grid-cols-2"><Elements body={element.body} ctx={ctx} onDone={onDone} /></div>
      : <div className="grid gap-3 rounded-md border p-3">{element.title && <div className="flex items-center gap-2 text-[13px] font-medium">{element.title}{badge(element.status)}</div>}<Elements body={element.body} ctx={ctx} onDone={onDone} /></div>
    case 'custom': return <Elements body={element.fallback} ctx={ctx} onDone={onDone} />
  }
}

export function Elements({ body, ctx, onDone }: { body: Element[], ctx: Ctx, onDone?: () => void }) {
  return <>{body.map((element, index) => <One key={index} element={element} ctx={ctx} onDone={onDone} />)}</>
}

/** A module's view as a card. */
export function ViewCard({ view }: { view: View }) {
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [asking, setAsking] = useState<{ op: Operation, go: () => void } | null>(null)
  const ctx: Ctx = { selections, setSelection: (id, values) => setSelections(current => ({ ...current, [id]: values })), confirm: (op, go) => setAsking({ op, go }) }
  return (
    <Card>
      {view.title && <CardHeader><CardTitle>{view.title}</CardTitle>{badge(view.status)}</CardHeader>}
      <CardContent className="grid gap-3"><Elements body={view.body} ctx={ctx} /></CardContent>
      {asking && (
        <Dialog open onOpenChange={open => !open && setAsking(null)} title={asking.op.confirm!.title} description={plain(asking.op.confirm!.body)}
          footer={<><Button variant="outline" size="sm" onClick={() => setAsking(null)}>取消</Button><Button size="sm" variant={asking.op.intent === 'danger' ? 'destructive' : 'default'} onClick={() => { asking.go(); setAsking(null) }}>{asking.op.confirm!.action}</Button></>} />
      )}
    </Card>
  )
}
