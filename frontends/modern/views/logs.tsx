/** A board's serial log: time range, search with context lines, highlight, download and the wget command. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { logs, rangeOf, RANGES, type LogResult, type LogSearch } from '../../../src/ui/logs.ts'
import { copyText, Icon, useUI } from '../kit.tsx'

const STAMP = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\] ?/
const plain = (text: string) => text.replace(/\u0000/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b./g, '')

function pattern(grep: string, regex: boolean): RegExp | null | 'bad' {
  if (!grep) return null
  try { return new RegExp(regex ? grep : grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') } catch { return 'bad' }
}
function Marked({ text, rx }: { text: string, rx: RegExp | null }) {
  if (!rx) return <>{text}</>
  const parts: Array<string | JSX.Element> = []
  let last = 0
  for (const match of text.matchAll(new RegExp(rx.source, 'gi'))) { if (!match[0]) break; parts.push(text.slice(last, match.index), <mark key={match.index}>{match[0]}</mark>); last = match.index! + match[0].length }
  parts.push(text.slice(last))
  return <>{parts}</>
}

export function LogPanel({ board, die }: { board: string, die?: string }) {
  const ui = useUI()
  const [range, setRange] = useState('60')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [grep, setGrep] = useState('')
  const [regex, setRegex] = useState(false)
  const [ctx, setCtx] = useState(2)
  const [result, setResult] = useState<LogResult | null>(null)
  const [loading, setLoading] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const span = useMemo(() => range === 'custom' ? { since: since.replace('T', ' ') || undefined, until: until.replace('T', ' ') || undefined } : rangeOf(range === 'all' ? null : Number(range)), [range, since, until])
  // The whole range comes back, so context lines can be shown around matches; the search narrows it here.
  const search: LogSearch = { board, die, ...span, limit: 5000 }
  const download: LogSearch = { board, die, ...span, grep: grep.trim() || undefined, regex }
  const run = async () => {
    setLoading(true)
    try { setResult(await logs.search(search)); requestAnimationFrame(() => box.current?.scrollTo?.({ top: box.current.scrollHeight })) } catch (error) { ui.fail('读不到日志', error) } finally { setLoading(false) }
  }
  useEffect(() => { void run() }, [board, die, range, since, until])
  const rx = pattern(grep.trim(), regex)
  const lines = useMemo(() => (result?.lines ?? []).map(line => { const s = STAMP.exec(line); return { ts: s ? s[1]!.slice(11) : '', text: plain(s ? line.slice(s[0].length) : line) } }), [result])
  const hits = useMemo(() => {
    if (!rx || rx === 'bad') return null
    const keep = new Set<number>(), hit = new Set<number>()
    lines.forEach((l, i) => { if (new RegExp(rx.source, 'i').test(l.text)) { hit.add(i); for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k++) keep.add(k) } })
    return { keep: [...keep].sort((a, b) => a - b), hit }
  }, [lines, rx, ctx])
  const shown = hits ? hits.keep : lines.map((_, i) => i)
  return <>
    <div className="lq">
      <label className="in"><Icon name="search" /><input className={rx === 'bad' ? 'bad' : ''} value={grep} onChange={e => setGrep(e.target.value)} placeholder={regex ? '正则，比如 mmc[0-9]: (error|timeout)' : '搜索：error、mmc、U-Boot…'} /></label>
      <button className={`chip${regex ? ' on' : ''}`} title="正则" onClick={() => setRegex(!regex)}>.*</button>
      <select value={ctx} onChange={e => setCtx(Number(e.target.value))} aria-label="上下文">{[0, 2, 5, 10].map(n => <option key={n} value={n}>上下文 {n} 行</option>)}</select>
      <select value={range} onChange={e => setRange(e.target.value)} aria-label="时间范围">{RANGES.map(r => <option key={r.label} value={r.minutes === null ? 'all' : String(r.minutes)}>{r.label}</option>)}<option value="custom">自定义…</option></select>
      {range === 'custom' && <><input type="datetime-local" step={1} value={since} onChange={e => setSince(e.target.value)} aria-label="开始" /><span>到</span><input type="datetime-local" step={1} value={until} onChange={e => setUntil(e.target.value)} aria-label="结束" /></>}
      <button className="chip" onClick={() => void run()} title="重新读取">{loading ? <span className="spin" /> : <Icon name="rebuild" />}</button>
    </div>
    <div ref={box} className={`logs${hits ? ' searching' : ''}`} data-testid="log-lines">
      {shown.map((i, at) => <div key={i}>
        {hits && at > 0 && i !== shown[at - 1]! + 1 && <div className="gap-l">⋯</div>}
        <div className={`ll${hits?.hit.has(i) ? ' hit' : ''}`}><span className="ts">{lines[i]!.ts}</span><Marked text={lines[i]!.text || ' '} rx={hits?.hit.has(i) && rx !== 'bad' ? rx : null} /></div>
      </div>)}
      {result && !shown.length && <div className="term-empty" style={{ height: '100%' }}>{lines.length ? '没有匹配的行' : '这段时间里没有日志'}</div>}
    </div>
    <div className="lfoot">
      <span>{!result ? '读取中…' : hits ? `${hits.hit.size} 处匹配 / ${lines.length} 行` : `${lines.length} 行`}{result?.truncated ? ' · 只显示最后 5000 行' : ''}{result?.source === 'buffer' ? ' · 来自串口缓冲' : ''}</span>
      <span className="gap" />
      <button className="pill" onClick={() => void copyText(ui, logs.wget(download), '复制了 wget 命令')}><Icon name="copy" />复制 wget</button>
      <button className="pill dark" onClick={() => logs.download(download)}><Icon name="dl" />下载 .log</button>
    </div>
  </>
}
