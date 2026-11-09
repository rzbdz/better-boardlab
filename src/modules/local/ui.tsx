/** The local module on the page: scanning this machine's slots, and what the latest scan found. */
import { useEffect, useState } from 'react'
import type { Scan, ScanRow } from 'boardlab-core/shared/types.ts'
import { call, type History } from 'boardlab-core/ui/api.ts'
import type { ModuleUi, ViewProps } from 'boardlab-core/ui/extensions.ts'
import { Pill, Section, STATUS, shortLink, shortenLinks, time, who } from 'boardlab-core/ui/kit.tsx'

const scanApi = {
  start: (slots: number[]) => call<Scan>('POST', 'api/scan', { slots, confirmed: true }),
  cancel: (id: string) => call('POST', 'api/scan/cancel', { id }),
  evidence: (id: string) => call<Array<{ slot: number | null, kind: string, label: string, body: string, at: string }>>('GET', `api/scan/evidence?id=${encodeURIComponent(id)}`),
}

function ScanResult({ rows }: { rows: ScanRow[] }) {
  if (!rows.length) return null
  return (
    <ul className="result">
      {rows.map(row => (
        <li key={row.slot}>
          <div className="result-head">
            <span className="slot-tag">槽位 {row.slot}</span>
            <b>{row.chips.find(chip => chip.product)?.product ?? (row.chips.length ? '型号未知' : '没有发现板子')}</b>
            {row.board && <span className="muted">已登记为 {row.board}</span>}
          </div>
          {row.chips.map(chip => (
            <div key={chip.die} className="result-chip">
              <span className="die">{chip.die}{chip.pending ? '（待确认）' : ''}</span>
              <span><span className="label">串口</span><code>{chip.serialPath ? shortLink(chip.serialPath) : '—'}</code></span>
              <span><span className="label">下载口</span><code>{chip.downloadUsbPath ?? '—'}</code>{chip.usbId && <small>{chip.usbId}</small>}</span>
            </div>
          ))}
          {row.flags.map((flag, index) => <p key={index} className="flag">{flag}</p>)}
        </li>
      ))}
    </ul>
  )
}

function ScanSlots(props: ViewProps) {
  const { state } = props
  const [selected, setSelected] = useState<number[]>(() => state.slots.map(slot => slot.slot))
  const scan = state.scan
  const running = scan?.status === 'running'
  const boardIn = (slot: number) => state.boards.find(board => board.slot === slot)
  // boardd refuses a scan while any board is held, whoever holds it and whichever slot it is in.
  const blocked = state.boards.filter(board => !!board.lease)
  const toggle = (slot: number) => setSelected(selected.includes(slot) ? selected.filter(item => item !== slot) : [...selected, slot].sort())
  const minor = state.firmware.find(item => item.soc === 'k3' && item.purpose === 'minor-board-info')
  return (
    <>
        {state.slots.length > 0 && <Section title="一键扫描">
          <p className="muted">逐个槽位按 fastboot，记录响应的串口和新出现的下载口；K3 板子往内存加载 minor-board-info 读型号，最后复位恢复正常启动。只能复位的槽位改按复位，靠启动输出认串口，读不到型号，应用建议时要填板名。扫描前会停掉所有 serial-mux 守护进程重新监听。不烧录、不擦除、不改板上配置。</p>
          <fieldset className="toggles" disabled={running} aria-label="扫描范围">
            {state.slots.map(slot => (
              <label key={slot.slot} className={selected.includes(slot.slot) ? 'on' : ''}>
                <input type="checkbox" checked={selected.includes(slot.slot)} onChange={() => toggle(slot.slot)} />
                <span>槽位 {slot.slot}</span>
                <small>{boardIn(slot.slot)?.name ?? '空'}{slot.canFastboot ? '' : ' · 只能复位'}</small>
              </label>
            ))}
          </fieldset>
          {!state.slots.length && <p className="warn">还没有槽位：请先在「设置」里填写 Home Assistant（槽位会自动读出），或添加自定义槽位。</p>}
          {!minor && <p className="warn">boardd 没有自带 K3 的 minor-board-info 固件，只能对应串口和下载口，读不到型号。</p>}
          {blocked.length > 0 && <p className="warn">{blocked.map(board => board.lease!.holder === state.you ? `${board.name} 被你拿着锁` : `${board.name} 正被 ${who(board.lease!.holder)} 使用`).join('；')}。有板子被拿着锁时不能扫描，先放锁或等别人用完。</p>}
          <div className="actions">
            {running
              ? <button className="danger" onClick={() => props.onRun('已请求取消', () => scanApi.cancel(scan!.id))}>取消扫描</button>
              : <button className="primary" disabled={!selected.length || blocked.length > 0} onClick={() => props.onPrompt({
                  kind: 'confirm', title: '开始扫描', action: '开始扫描',
                  body: `将锁住槽位 ${selected.join('、')}，停掉所有 serial-mux 守护进程，逐个切换到 fastboot、加载诊断镜像，结束后复位；只能复位的槽位会被复位两次。扫描期间别人不能使用这些板子。`,
                  run: () => scanApi.start(selected),
                })}>开始扫描</button>}
          </div>
        </Section>}
    </>
  )
}

function ScanProgress({ state }: ViewProps) {
  const [evidence, setEvidence] = useState<Array<{ slot: number | null, label: string, body: string }> | null>(null)
  const scan = state.scan
  const running = scan?.status === 'running'
  useEffect(() => setEvidence(null), [scan?.id])
  return (
    <>
        {scan ? (
          <Section title={`扫描 · ${time(scan.startedAt)}`} extra={<Pill tone={scan.status === 'done' ? 'ok' : scan.status === 'running' ? 'mine' : 'err'}>{STATUS[scan.status]}</Pill>}>
            {scan.message && <p className="warn">{scan.message}</p>}
            <ol className="steps" aria-live="polite">
              {scan.steps.map(step => (
                <li key={step.seq}>
                  <time>{time(step.at, false)}</time>
                  <span className={`slot-tag ${step.slot === null ? 'ghost' : ''}`}>{step.slot ?? '·'}</span>
                  <span>{shortenLinks(step.summary)}</span>
                </li>
              ))}
            </ol>
            <ScanResult rows={scan.result} />
            {!running && !evidence && <button className="link" onClick={async () => setEvidence(await scanApi.evidence(scan.id))}>查看原始证据</button>}
            {evidence && (
              <div className="evidence">
                {evidence.map((item, index) => <details key={index}><summary>{item.slot !== null ? `槽位 ${item.slot} · ` : ''}{shortenLinks(item.label)}</summary><pre>{item.body || '（空）'}</pre></details>)}
              </div>
            )}
          </Section>
        ) : <Section title="扫描结果"><p className="muted">还没有扫描过。</p></Section>}
    </>
  )
}

function ScanHistory({ history }: { history: History }) {
  const scans = (history.scans ?? []) as Scan[]
  return (
      <Section title="扫描记录">
        {scans.map(scan => (
          <details key={scan.id} className="scan-record">
            <summary><time>{time(scan.startedAt)}</time><span>{who(scan.holder)}</span><span className="muted">槽位 {scan.scope.join('、')}</span><Pill tone={scan.status === 'done' ? 'ok' : 'err'}>{STATUS[scan.status]}</Pill></summary>
            <ScanResult rows={scan.result} />
          </details>
        ))}
        {!scans.length && <p className="muted">还没有扫描过。</p>}
      </Section>
  )
}

export const ui: ModuleUi = { module: 'local', scan: ScanSlots, scanResult: ScanProgress, history: ScanHistory }
