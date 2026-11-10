/**
 * The Ant Design frontend's renderer for module views (src/ui/contract.ts). Each element kind becomes an antd piece;
 * actions show a spinner and a message, jobs open a progress drawer with their live lines and fraction, `open`
 * operations a modal. Custom elements of modules this frontend has adapted to are drawn specially (CUSTOM); every
 * other one falls back to its common elements.
 */
import { CheckCircleFilled, CloseCircleFilled, LoadingOutlined } from '@ant-design/icons'
import { App, Alert, Button, Card, Checkbox, Collapse, Descriptions, Drawer, Empty, Flex, Form, Input, InputNumber, List, Modal, Progress, Select, Space, Switch, Table, Tag, Timeline, Typography } from 'antd'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { plain, type Badge, type Element, type Field, type Inline, type ModuleUi, type Operation, type PageState, type Rich, type Tone, type Values, type View, type ViewContext } from '../../src/ui/contract.ts'
import { stamp } from '../../src/ui/format.ts'

let registered: ModuleUi[] = []
export function registerModuleUis(uis: ModuleUi[]) { registered = uis }

export function viewsFor(state: PageState, slot: View['slot'], context: ViewContext = {}): View[] {
  return registered.filter(ui => state.modules.some(module => module.id === ui.module))
    .flatMap(ui => { try { return ui.views(state, context) } catch { return [] } }).filter(view => view.slot === slot)
}

/** Custom elements this frontend draws specially, by type. None yet: add `'<module>.<what>': (data) => <…/>` here. */
const CUSTOM: Record<string, (data: unknown) => ReactNode> = {}

const COLOR: Record<Tone, string> = { neutral: 'default', ok: 'success', info: 'processing', warn: 'warning', error: 'error', mine: 'blue' }
export const badge = (status?: Badge) => status ? <Tag color={COLOR[status.tone]} bordered={false}>{status.text}</Tag> : null
const alertType = (tone?: Tone) => tone === 'error' ? 'error' : tone === 'warn' ? 'warning' : tone === 'ok' ? 'success' : 'info'

function inline(part: Inline, key: number): ReactNode {
  if (typeof part === 'string') return part
  if ('code' in part) return <Typography.Text key={key} code>{part.code}</Typography.Text>
  if ('strong' in part) return <Typography.Text key={key} strong>{part.strong}</Typography.Text>
  if ('link' in part) return <Typography.Link key={key} href={part.href} target="_blank">{part.link}</Typography.Link>
  if ('muted' in part) return <Typography.Text key={key} type="secondary">{part.muted}</Typography.Text>
  return <span key={key}>{stamp(part.time)}</span>
}
export const rich = (value: Rich): ReactNode => Array.isArray(value) ? value.map(inline) : inline(value, 0)

/** One running job, as the drawer shows it. */
interface JobRun { id: number, label: string, lines: string[], fraction: number | null, state: 'running' | 'done' | 'failed', message?: string, abort: AbortController }

/** Jobs run here outlive the view that started them: they show in a drawer, opened when one starts. */
let jobListeners = new Set<(jobs: JobRun[]) => void>()
let jobs: JobRun[] = []
const publish = () => jobListeners.forEach(fn => fn([...jobs]))
export function useJobs(): JobRun[] {
  const [list, setList] = useState(jobs)
  useEffect(() => { jobListeners.add(setList); return () => { jobListeners.delete(setList) } }, [])
  return list
}

export function JobDrawer({ open, onClose }: { open: boolean, onClose: () => void }) {
  const list = useJobs()
  return (
    <Drawer title="任务" open={open} onClose={onClose} width={520}>
      {!list.length && <Empty description="还没有任务" />}
      <Flex vertical gap={16}>
        {[...list].reverse().map(run => (
          <Card key={run.id} size="small" title={<Space>{run.state === 'running' ? <LoadingOutlined /> : run.state === 'done' ? <CheckCircleFilled style={{ color: '#16a34a' }} /> : <CloseCircleFilled style={{ color: '#dc2626' }} />}{run.label}</Space>}
            extra={run.state === 'running' ? <Button size="small" danger onClick={() => run.abort.abort()}>取消</Button> : null}>
            {run.fraction !== null && <Progress percent={Math.round(run.fraction * 100)} size="small" status={run.state === 'failed' ? 'exception' : run.state === 'done' ? 'success' : 'active'} />}
            {run.message && <Alert type={run.state === 'failed' ? 'error' : 'success'} message={run.message} showIcon style={{ margin: '8px 0' }} />}
            <pre className="bl-log" style={{ maxHeight: 260, overflow: 'auto' }}>{run.lines.join('\n')}</pre>
          </Card>
        ))}
      </Flex>
    </Drawer>
  )
}

interface Ctx { selections: Record<string, string[]>, setSelection: (id: string, values: string[]) => void, onJobStarted: () => void }

function useOperation(op: Operation, ctx: Ctx, values: () => Values, onDone?: () => void) {
  const { message, modal } = App.useApp()
  const [busy, setBusy] = useState(false)
  const [opened, setOpened] = useState(false)
  const input = () => ({ ...values(), ...Object.fromEntries((op.using ?? []).map(id => [id, ctx.selections[id] ?? []])) })
  const go = async () => {
    if (op.kind === 'open') { setOpened(true); return }
    if (op.kind === 'action') {
      setBusy(true)
      try { const out = await op.run(input()); message.success(out.message || `${op.label}：完成`); onDone?.() }
      catch (error) { message.error((error as Error).message) }
      finally { setBusy(false) }
      return
    }
    const run: JobRun = { id: Date.now(), label: op.label, lines: [], fraction: null, state: 'running', abort: new AbortController() }
    jobs = [...jobs.slice(-9), run]; publish(); ctx.onJobStarted()
    setBusy(true)
    try {
      const out = await op.start(input(), {
        line: text => { run.lines = [...run.lines.slice(-400), text]; publish() },
        progress: fraction => { run.fraction = fraction; publish() },
      }, run.abort.signal)
      run.state = 'done'; run.fraction = run.fraction === null ? null : 1; run.message = out.message
      message.success(out.message || `${op.label}：完成`); onDone?.()
    } catch (error) { run.state = 'failed'; run.message = (error as Error).message; message.error(run.message) }
    finally { setBusy(false); publish() }
  }
  const trigger = () => op.confirm
    ? modal.confirm({ title: op.confirm.title, content: rich(op.confirm.body), okText: op.confirm.action, cancelText: '取消', okButtonProps: { danger: op.intent === 'danger' }, onOk: () => { void go() } })
    : void go()
  return { trigger, busy, opened, close: () => setOpened(false) }
}

export function OperationButton({ op, ctx, values = () => ({}), onDone, size }: { op: Operation, ctx: Ctx, values?: () => Values, onDone?: () => void, size?: 'small' | 'middle' }) {
  const run = useOperation(op, ctx, values, onDone)
  return (
    <>
      <Button size={size} type={op.intent === 'primary' ? 'primary' : 'default'} danger={op.intent === 'danger'} loading={run.busy}
        disabled={!!op.blocked} title={op.blocked} onClick={run.trigger}>{op.label}</Button>
      {op.kind === 'open' && (
        <Modal title={op.title} open={run.opened} onCancel={run.close} footer={null} width={640} destroyOnClose>
          <Elements body={op.body()} ctx={ctx} onDone={run.close} />
        </Modal>
      )}
    </>
  )
}

function initialValues(fields: Field[]): Values {
  return Object.fromEntries(fields.map(field => [field.id, field.kind === 'secret' ? '' : field.kind === 'switch' ? !!field.initial : field.kind === 'choice' ? field.initial ?? field.options[0]?.value ?? '' : field.initial ?? '']))
}

function FieldItem({ field }: { field: Field }) {
  const help = 'help' in field && field.help ? rich(field.help) : undefined
  switch (field.kind) {
    case 'switch': return <Form.Item name={field.id} label={field.label} valuePropName="checked" extra={help}><Switch /></Form.Item>
    case 'choice': return <Form.Item name={field.id} label={field.label}><Select options={field.options} /></Form.Item>
    case 'code': return <Form.Item name={field.id} label={field.label} rules={[{ required: field.required, message: `填写${field.label}` }]} extra={help}><Input.TextArea className="bl-mono" rows={field.rows ?? 4} placeholder={field.placeholder} spellCheck={false} /></Form.Item>
    case 'number': return <Form.Item name={field.id} label={field.label} rules={[{ required: field.required, message: `填写${field.label}` }]}><InputNumber min={field.min} max={field.max} disabled={field.disabled} style={{ width: '100%' }} /></Form.Item>
    case 'secret': return <Form.Item name={field.id} label={field.label} extra={help}><Input.Password placeholder={field.placeholder} autoComplete="off" /></Form.Item>
    default: return <Form.Item name={field.id} label={field.label} rules={[{ required: field.required, message: `填写${field.label}` }, ...(field.pattern ? [{ pattern: new RegExp(`^(?:${field.pattern})$`), message: '格式不对' }] : [])]} extra={help}><Input placeholder={field.placeholder} disabled={field.disabled} /></Form.Item>
  }
}

function FormElement({ element, ctx, onDone }: { element: Extract<Element, { kind: 'form' }>, ctx: Ctx, onDone?: () => void }) {
  const [form] = Form.useForm()
  const initial = useMemo(() => initialValues(element.fields), [])
  const submit = useOperation(element.submit, ctx, () => form.getFieldsValue(true), () => { form.setFieldsValue(Object.fromEntries(element.fields.filter(field => field.kind === 'secret').map(field => [field.id, '']))); onDone?.() })
  return (
    <Form form={form} layout="vertical" initialValues={initial} requiredMark={false} onFinish={() => submit.trigger()} style={{ maxWidth: 720 }}>
      {element.fields.map(field => <FieldItem key={field.id} field={field} />)}
      <Space wrap>
        <Button type="primary" htmlType="submit" loading={submit.busy} disabled={!!element.submit.blocked}>{element.submitLabel}</Button>
        {element.secondary?.map(op => <OperationButton key={op.id} op={op} ctx={ctx} values={() => form.getFieldsValue(true)} />)}
        {element.note && <Typography.Text type="secondary">{rich(element.note)}</Typography.Text>}
      </Space>
    </Form>
  )
}

function SelectMany({ element, ctx }: { element: Extract<Element, { kind: 'select-many' }>, ctx: Ctx }) {
  const chosen = ctx.selections[element.id] ?? element.initial
  useEffect(() => { if (!ctx.selections[element.id]) ctx.setSelection(element.id, element.initial) }, [])
  return (
    <div>
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>{element.label}</Typography.Text>
      <Checkbox.Group value={chosen} disabled={element.disabled} onChange={values => ctx.setSelection(element.id, values as string[])}>
        <Flex wrap gap={8}>
          {element.options.map(option => (
            <Checkbox key={option.value} value={option.value}>
              <span>{option.label}</span>{option.note && <Typography.Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>{option.note}</Typography.Text>}
            </Checkbox>
          ))}
        </Flex>
      </Checkbox.Group>
    </div>
  )
}

function Details({ element, ctx }: { element: Extract<Element, { kind: 'details' }>, ctx: Ctx }) {
  const [body, setBody] = useState<Element[] | null>(null)
  const [loading, setLoading] = useState(false)
  return (
    <Collapse ghost size="small" onChange={async keys => { if (keys.length && !body && !loading) { setLoading(true); try { setBody(await element.load()) } finally { setLoading(false) } } }}
      items={[{ key: 'd', label: rich(element.summary), children: body ? <Elements body={body} ctx={ctx} /> : <LoadingOutlined /> }]} />
  )
}

function Live({ element }: { element: Extract<Element, { kind: 'live' }> }) {
  const [lines, setLines] = useState<string[]>([])
  const box = useRef<HTMLPreElement>(null)
  useEffect(() => element.stream.open({ line: text => setLines(list => [...list.slice(-800), text]) }), [element.stream.id])
  useEffect(() => { box.current?.scrollTo?.({ top: box.current.scrollHeight }) }, [lines])
  return <pre ref={box} className="bl-log bl-terminal" style={{ minHeight: 0, maxHeight: element.height === 'large' ? 480 : 220, overflow: 'auto', color: '#d7dde8' }}>{lines.join('\n')}</pre>
}

function One({ element, ctx, onDone }: { element: Element, ctx: Ctx, onDone?: () => void }): ReactNode {
  switch (element.kind) {
    case 'text': return element.tone && element.tone !== 'neutral'
      ? <Alert type={alertType(element.tone)} message={rich(element.text)} showIcon banner={false} />
      : <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>{rich(element.text)}</Typography.Paragraph>
    case 'facts': return <Descriptions size="small" column={{ xs: 1, md: 2 }} items={element.items.map(item => ({ key: item.label, label: item.label, children: rich(item.value) }))} />
    case 'form': return <FormElement element={element} ctx={ctx} onDone={onDone} />
    case 'actions': return <Space wrap>{element.actions.map(op => <OperationButton key={op.id} op={op} ctx={ctx} onDone={onDone} />)}</Space>
    case 'list': return (
      <List itemLayout="horizontal" dataSource={element.items} locale={{ emptyText: element.empty ? rich(element.empty) : '没有' }}
        renderItem={item => (
          <List.Item actions={item.actions?.map(op => <OperationButton key={op.id} op={op} ctx={ctx} size="small" />)}>
            <List.Item.Meta title={<Space>{item.tag && <Tag bordered={false}>{item.tag}</Tag>}{rich(item.title)}{badge(item.status)}</Space>} description={item.description ? rich(item.description) : undefined} />
          </List.Item>
        )} />
    )
    case 'table': return (
      <Table size="small" pagination={false} rowKey="key" scroll={{ x: true }} locale={{ emptyText: element.empty ? rich(element.empty) : '没有' }}
        dataSource={element.rows} columns={[
          ...element.columns.map(column => ({ key: column.key, title: column.title, width: column.width === 'narrow' ? 72 : undefined, render: (_: unknown, row: typeof element.rows[number]) => <span style={{ color: row.tone === 'warn' ? '#d97706' : row.tone === 'error' ? '#dc2626' : undefined }}>{rich(row.cells[column.key] ?? '')}</span> })),
          ...(element.rows.some(row => row.actions?.length) ? [{ key: '_', title: '', render: (_: unknown, row: typeof element.rows[number]) => <Space>{row.actions?.map(op => <OperationButton key={op.id} op={op} ctx={ctx} size="small" />)}</Space> }] : []),
        ]} />
    )
    case 'select-many': return <SelectMany element={element} ctx={ctx} />
    case 'timeline': return <Timeline items={element.items.map(item => ({ key: item.key, color: item.tone === 'error' ? 'red' : item.tone === 'warn' ? 'orange' : 'blue', children: <Space size={8} wrap>{item.at && <Typography.Text type="secondary" className="bl-mono" style={{ fontSize: 12 }}>{stamp(item.at, false)}</Typography.Text>}{item.tag && <Tag bordered={false}>{item.tag}</Tag>}<span>{rich(item.text)}</span></Space> }))} />
    case 'progress': return <div><Typography.Text type="secondary">{rich(element.label)}</Typography.Text>{element.fraction != null && <Progress percent={Math.round(element.fraction * 100)} size="small" />}</div>
    case 'live': return <Live element={element} />
    case 'details': return <Details element={element} ctx={ctx} />
    case 'group': return element.layout === 'columns'
      ? <Flex wrap gap={16}><Elements body={element.body} ctx={ctx} onDone={onDone} /></Flex>
      : <Card size="small" type="inner" title={element.title && <Space>{element.title}{badge(element.status)}</Space>}><Flex vertical gap={12}><Elements body={element.body} ctx={ctx} onDone={onDone} /></Flex></Card>
    case 'custom': return CUSTOM[element.type] ? CUSTOM[element.type]!(element.data) : <Elements body={element.fallback} ctx={ctx} onDone={onDone} />
  }
}

export function Elements({ body, ctx, onDone }: { body: Element[], ctx: Ctx, onDone?: () => void }) {
  return <>{body.map((element, index) => <One key={index} element={element} ctx={ctx} onDone={onDone} />)}</>
}

/** A module's view as a card. */
export function ViewCard({ view, onJobStarted }: { view: View, onJobStarted: () => void }) {
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const ctx: Ctx = { selections, setSelection: (id, values) => setSelections(current => ({ ...current, [id]: values })), onJobStarted }
  return (
    <Card title={view.title} extra={badge(view.status)} variant="borderless" style={{ boxShadow: 'var(--bl-card-shadow)' }}>
      <Flex vertical gap={14}><Elements body={view.body} ctx={ctx} /></Flex>
    </Card>
  )
}

export { plain }
