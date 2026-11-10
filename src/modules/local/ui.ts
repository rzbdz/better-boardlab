/**
 * The local module's part of the page, as views any frontend renders: a way to scan this machine's slots (a job with
 * live steps and a cancel), what the latest scan found, and past scans on the history page.
 */
import { api, call } from '../../ui/api.ts'
import { action, job, notice, text, type Element, type ModuleUi, type View } from '../../ui/contract.ts'
import type { Scan, ScanRow } from 'boardlab-core/shared/types.ts'

const scanApi = {
  start: (slots: number[]) => call<Scan>('POST', 'api/scan', { slots, confirmed: true }),
  cancel: (id: string) => call('POST', 'api/scan/cancel', { id }),
  evidence: (id: string) => call<Array<{ slot: number | null, kind: string, label: string, body: string, at: string }>>('GET', `api/scan/evidence?id=${encodeURIComponent(id)}`),
}

const STATUS: Record<Scan['status'], string> = { running: '进行中', done: '完成', failed: '失败', cancelled: '已取消' }
const TONE = { running: 'mine', done: 'ok', failed: 'error', cancelled: 'warn' } as const
/** `/dev/serial/by-path/pci-…-usb-0:6.4.2:1.0-port0` → `USB 6.4.2`. */
const shortLink = (link: string) => { const port = link.match(/-usb-\d+:([\d.]+):/)?.[1]; return port ? `USB ${port}` : link.split('/').at(-1)! }
const shortenLinks = (value: string) => value.replace(/\/dev\/serial\/by-path\/\S+/g, link => shortLink(link))
const who = (holder: string) => holder.startsWith('user:') ? holder.slice(5) : holder

/** What a scan found, slot by slot. */
function result(rows: ScanRow[]): Element[] {
  if (!rows.length) return []
  return [{
    kind: 'table',
    columns: [{ key: 'slot', title: '槽位', width: 'narrow' }, { key: 'product', title: '型号' }, { key: 'serial', title: '串口' }, { key: 'usb', title: '下载口' }, { key: 'note', title: '说明', width: 'wide' }],
    rows: rows.flatMap(row => (row.chips.length ? row.chips : [null]).map((chip, index) => ({
      key: `${row.slot}-${chip?.die ?? index}`,
      tone: row.flags.length ? 'warn' as const : undefined,
      cells: {
        slot: index ? '' : String(row.slot),
        product: chip?.product ?? (chip ? '型号未知' : '没有发现板子'),
        serial: chip?.serialPath ? { code: shortLink(chip.serialPath) } : '—',
        usb: chip?.downloadUsbPath ? { code: chip.downloadUsbPath } : '—',
        note: index ? '' : [row.board ? `已登记为 ${row.board}` : '', ...row.flags.map(flag => ` ${flag}`)].join('').trim() || '',
      },
    }))),
  }]
}

/** Follow a scan through the page state until it ends, reporting each new step; resolves with its last state. */
function follow(id: string, scope: number[], sink: { line(text: string): void, progress(fraction: number): void }, signal: AbortSignal): Promise<Scan> {
  return new Promise((resolve, reject) => {
    const source = new EventSource('api/events')
    let seen = 0
    const check = async () => {
      try {
        const scan = (await api.state()).scan
        if (!scan || scan.id !== id) return
        for (const step of scan.steps.slice(seen)) sink.line(`${step.slot !== null ? `槽位 ${step.slot} · ` : ''}${shortenLinks(step.summary)}`)
        seen = scan.steps.length
        const done = new Set(scan.steps.map(step => step.slot).filter(slot => slot !== null)).size
        sink.progress(Math.min(0.99, done / Math.max(1, scope.length)))
        if (scan.status !== 'running') { source.close(); resolve(scan) }
      } catch (error) { source.close(); reject(error) }
    }
    source.addEventListener('scan', () => void check())
    source.addEventListener('changed', () => void check())
    signal.addEventListener('abort', () => { void scanApi.cancel(id).catch(() => {}) })
    void check()
  })
}

export const ui: ModuleUi = {
  module: 'local',
  views(state): View[] {
    const views: View[] = []
    const scan = state.scan
    const running = scan?.status === 'running'
    const boardIn = (slot: number) => state.boards.find(board => board.slot === slot)
    // boardd refuses a scan while any board is held, whoever holds it and whichever slot it is in.
    const held = state.boards.filter(board => !!board.lease)
    const minor = state.firmware.find(item => item.soc === 'k3' && item.purpose === 'minor-board-info')
    if (state.slots.length) {
      views.push({
        id: 'scan', slot: 'scan', title: '扫描本机槽位',
        body: [
          text('逐个槽位按 fastboot，记录响应的串口和新出现的下载口；K3 板子往内存加载 minor-board-info 读型号，最后复位恢复正常启动。只能复位的槽位改按复位，靠启动输出认串口。不烧录、不擦除、不改板上配置。'),
          ...(!minor ? [notice('boardd 没有自带 K3 的 minor-board-info 固件，只能对应串口和下载口，读不到型号。')] : []),
          ...(held.length ? [notice(`${held.map(board => `${board.name} 正被 ${who(board.lease!.holder)} 使用`).join('；')}。有板子被拿着锁时不能扫描。`)] : []),
          {
            kind: 'select-many', id: 'slots', label: '扫描范围', disabled: running,
            initial: state.slots.map(slot => String(slot.slot)),
            options: state.slots.map(slot => ({ value: String(slot.slot), label: `槽位 ${slot.slot}`, note: `${boardIn(slot.slot)?.name ?? '空'}${slot.canFastboot ? '' : ' · 只能复位'}` })),
          },
          {
            kind: 'actions', actions: running ? [
              action('cancel', '取消扫描', async () => { await scanApi.cancel(scan!.id); return '已请求取消' }, { intent: 'danger' }),
            ] : [
              job('scan', '开始扫描', async (input, sink, signal) => {
                const slots = ((input.slots as string[]) ?? []).map(Number)
                if (!slots.length) throw new Error('先选要扫描的槽位')
                const started = await scanApi.start(slots)
                sink.line(`锁住槽位 ${slots.join('、')}，开始扫描`)
                const end = await follow(started.id, slots, sink, signal)
                const found = end.result.filter(row => row.chips.length).length
                if (end.status !== 'done') throw new Error(end.message ?? `扫描${STATUS[end.status]}`)
                return { message: `扫描完成：${found} 个槽位有板子，改动建议见下方`, data: end }
              }, {
                intent: 'primary', using: ['slots'], blocked: held.length ? '有板子被拿着锁' : undefined,
                confirm: { title: '开始扫描', action: '开始扫描', body: '会锁住选中的槽位，停掉所有 serial-mux 守护进程，逐个切换到 fastboot、加载诊断镜像，结束后复位。扫描期间别人不能使用这些板子。' },
              }),
            ],
          },
        ],
      })
    }
    views.push({
      id: 'scan-result', slot: 'scan-result', title: scan ? '最近一次扫描' : '扫描结果',
      status: scan ? { tone: TONE[scan.status], text: STATUS[scan.status] } : undefined,
      body: scan ? [
        ...(scan.message ? [notice(scan.message)] : []),
        { kind: 'timeline', items: scan.steps.map(step => ({ key: String(step.seq), at: step.at, tag: step.slot !== null ? String(step.slot) : undefined, text: shortenLinks(step.summary) })) },
        ...result(scan.result),
        ...(!running ? [{
          kind: 'details' as const, summary: '原始证据',
          load: async (): Promise<Element[]> => (await scanApi.evidence(scan.id)).map(item => ({
            kind: 'group' as const, title: `${item.slot !== null ? `槽位 ${item.slot} · ` : ''}${shortenLinks(item.label)}`, body: [text({ code: item.body || '（空）' })],
          })),
        }] : []),
      ] : [text('还没有扫描过。', 'neutral')],
    })
    const scans = (state.history?.scans ?? []) as Scan[]
    if (state.history) {
      views.push({
        id: 'scans', slot: 'history', title: '扫描记录',
        body: [{
          kind: 'list', empty: '还没有扫描过。',
          items: scans.map(item => ({
            key: item.id, title: `槽位 ${item.scope.join('、')}`, description: [{ time: item.startedAt }, ` · ${who(item.holder)}`],
            status: { tone: TONE[item.status], text: STATUS[item.status] },
          })),
        }],
      })
    }
    return views
  },
}
