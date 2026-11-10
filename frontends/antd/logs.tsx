/** A board's serial log: search over a time range, download in the browser, or copy a wget command for a terminal. */
import { CopyOutlined, DownloadOutlined, SearchOutlined } from '@ant-design/icons'
import { App, Button, Checkbox, DatePicker, Input, Segmented, Select, Space, Tooltip, Typography } from 'antd'
import type { Dayjs } from 'dayjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import { logs, rangeOf, RANGES, type LogResult, type LogSearch } from '../../src/ui/logs.ts'

const STAMP = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\] ?/

function Highlight({ text, grep, regex }: { text: string, grep: string, regex: boolean }) {
  if (!grep) return <>{text}</>
  let rx: RegExp
  try { rx = regex ? new RegExp(grep, 'g') : new RegExp(grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') } catch { return <>{text}</> }
  const parts: Array<string | JSX.Element> = []
  let last = 0
  for (const match of text.matchAll(rx)) {
    if (!match[0]) break
    parts.push(text.slice(last, match.index), <mark key={match.index}>{match[0]}</mark>)
    last = match.index! + match[0].length
  }
  parts.push(text.slice(last))
  return <>{parts}</>
}

export function LogPanel({ board, die }: { board: string, die?: string }) {
  const { message } = App.useApp()
  const [range, setRange] = useState<number | 'custom'>(60)
  const [custom, setCustom] = useState<[Dayjs | null, Dayjs | null] | null>(null)
  const [grep, setGrep] = useState('')
  const [regex, setRegex] = useState(false)
  const [result, setResult] = useState<LogResult | null>(null)
  const [loading, setLoading] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const search = useMemo((): LogSearch => {
    const span = range === 'custom'
      ? { since: custom?.[0]?.format('YYYY-MM-DD HH:mm:ss'), until: custom?.[1]?.format('YYYY-MM-DD HH:mm:ss') }
      : rangeOf(range === 0 ? null : range)
    return { board, die, ...span, grep: grep.trim() || undefined, regex, limit: 5000 }
  }, [board, die, range, custom, grep, regex])
  const run = async () => {
    setLoading(true)
    try { setResult(await logs.search(search)); requestAnimationFrame(() => box.current?.scrollTo({ top: box.current.scrollHeight })) }
    catch (error) { message.error((error as Error).message) }
    finally { setLoading(false) }
  }
  useEffect(() => { void run() }, [board, die, range, custom])
  const copy = async () => {
    const command = logs.wget({ ...search, limit: undefined })
    try { await navigator.clipboard.writeText(command); message.success('已复制 wget 命令') }
    catch { message.info({ content: <span className="bl-mono" style={{ fontSize: 12 }}>{command}</span>, duration: 8 }) }
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="bl-toolbar" style={{ padding: '8px 12px', borderBottom: '1px solid var(--bl-line)' }}>
        <Select size="small" value={range} onChange={setRange} style={{ width: 128 }}
          options={[...RANGES.map(item => ({ value: item.minutes ?? 0, label: item.label })), { value: 'custom', label: '自定义…' }]} />
        {range === 'custom' && <DatePicker.RangePicker size="small" showTime value={custom} onChange={value => setCustom(value as [Dayjs | null, Dayjs | null] | null)} />}
        <Input size="small" allowClear prefix={<SearchOutlined />} placeholder={regex ? '正则' : '搜索'} value={grep} onChange={event => setGrep(event.target.value)} onPressEnter={() => void run()} style={{ width: 200 }} className={regex ? 'bl-mono' : undefined} />
        <Checkbox checked={regex} onChange={event => setRegex(event.target.checked)}><span style={{ fontSize: 12 }}>正则</span></Checkbox>
        <Button size="small" onClick={() => void run()} loading={loading}>搜索</Button>
        <span className="bl-grow" />
        <Typography.Text type="secondary" style={{ fontSize: 12 }} className="bl-num">
          {result ? `${result.matched} 行${result.truncated ? `，显示最后 ${result.lines.length}` : ''}${result.source === 'buffer' ? ' · 来自串口缓冲' : ''}` : ''}
        </Typography.Text>
        <Space.Compact>
          <Tooltip title="下载这段日志"><Button size="small" icon={<DownloadOutlined />} onClick={() => logs.download({ ...search, limit: undefined })}>下载</Button></Tooltip>
          <Tooltip title="复制 wget 命令，在终端里下载同一份文件"><Button size="small" icon={<CopyOutlined />} onClick={() => void copy()}>wget</Button></Tooltip>
        </Space.Compact>
      </div>
      <div ref={box} className="bl-logview bl-mono" data-testid="log-lines">
        {result?.lines.map((line, index) => {
          const stamp = STAMP.exec(line)
          const body = stamp ? line.slice(stamp[0].length) : line
          return (
            <div key={index} className="bl-line bl-log">
              <span className="bl-ln">{index + 1}</span>
              <span>{stamp && <span className="bl-ts">{stamp[1]!.slice(11)} </span>}<Highlight text={body} grep={grep.trim()} regex={regex} /></span>
            </div>
          )
        })}
        {result && !result.lines.length && <Typography.Text type="secondary">这段时间里没有匹配的日志。</Typography.Text>}
      </div>
    </div>
  )
}

/** The quick range control, as a compact segmented choice (for narrow places). */
export const RangeSegment = ({ value, onChange }: { value: number, onChange: (minutes: number) => void }) =>
  <Segmented size="small" value={value} onChange={onChange} options={RANGES.slice(0, 4).map(item => ({ value: item.minutes ?? 0, label: item.label.replace('最近 ', '') }))} />
