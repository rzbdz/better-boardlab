/** A board's serial log in the shadcn frontend: time range, search, highlight, download and a wget command. */
import { Copy, Download, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { logs, rangeOf, RANGES, type LogResult, type LogSearch } from '../../../src/ui/logs.ts'
import { Button, Checkbox, Input, NativeSelect, Tip } from '../ui/index.tsx'

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
  const [range, setRange] = useState<string>('60')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [grep, setGrep] = useState('')
  const [regex, setRegex] = useState(false)
  const [result, setResult] = useState<LogResult | null>(null)
  const [loading, setLoading] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const search = useMemo((): LogSearch => {
    const span = range === 'custom' ? { since: since.replace('T', ' ') || undefined, until: until.replace('T', ' ') || undefined } : rangeOf(range === 'all' ? null : Number(range))
    return { board, die, ...span, grep: grep.trim() || undefined, regex, limit: 5000 }
  }, [board, die, range, since, until, grep, regex])
  const run = async () => {
    setLoading(true)
    try { setResult(await logs.search(search)); requestAnimationFrame(() => box.current?.scrollTo?.({ top: box.current.scrollHeight })) }
    catch (error) { toast.error((error as Error).message) } finally { setLoading(false) }
  }
  useEffect(() => { void run() }, [board, die, range])
  const copy = async () => {
    const command = logs.wget({ ...search, limit: undefined })
    try { await navigator.clipboard.writeText(command); toast.success('已复制 wget 命令') } catch { toast(command, { duration: 8000 }) }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <NativeSelect value={range} onChange={event => setRange(event.target.value)} className="h-7 text-xs" aria-label="时间范围">
          {RANGES.map(item => <option key={item.label} value={item.minutes === null ? 'all' : String(item.minutes)}>{item.label}</option>)}
          <option value="custom">自定义…</option>
        </NativeSelect>
        {range === 'custom' && <>
          <Input type="datetime-local" step={1} value={since} onChange={event => setSince(event.target.value)} className="h-7 w-auto text-xs" aria-label="开始" />
          <span className="text-xs text-muted-foreground">至</span>
          <Input type="datetime-local" step={1} value={until} onChange={event => setUntil(event.target.value)} className="h-7 w-auto text-xs" aria-label="结束" />
        </>}
        <div className="relative"><Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={grep} onChange={event => setGrep(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void run() }} placeholder={regex ? '正则' : '搜索'} className={regex ? 'h-7 w-44 pl-7 font-mono text-xs' : 'h-7 w-44 pl-7 text-xs'} /></div>
        <label className="flex items-center gap-1.5 text-xs"><Checkbox checked={regex} onCheckedChange={setRegex} />正则</label>
        <Button size="sm" variant="outline" loading={loading} onClick={() => void run()}>搜索</Button>
        <div className="flex-1" />
        <span className="text-xs tabular-nums text-muted-foreground">{result ? `${result.matched} 行${result.truncated ? `，显示最后 ${result.lines.length}` : ''}${result.source === 'buffer' ? ' · 来自串口缓冲' : ''}` : ''}</span>
        <Tip text="下载这段日志"><Button size="sm" variant="outline" onClick={() => logs.download({ ...search, limit: undefined })}><Download />下载</Button></Tip>
        <Tip text="复制 wget 命令，在终端里下载同一份文件"><Button size="sm" variant="outline" onClick={() => void copy()}><Copy />wget</Button></Tip>
      </div>
      <div ref={box} className="logview" data-testid="log-lines">
        {result?.lines.map((line, index) => {
          const stamp = STAMP.exec(line)
          const body = stamp ? line.slice(stamp[0].length) : line
          return (
            <div key={index} className="grid grid-cols-[4.5em_1fr] gap-2.5 whitespace-pre-wrap break-all">
              <span className="select-none text-right text-zinc-600">{index + 1}</span>
              <span>{stamp && <span className="text-zinc-500">{stamp[1]!.slice(11)} </span>}<Highlight text={body} grep={grep.trim()} regex={regex} /></span>
            </div>
          )
        })}
        {result && !result.lines.length && <span className="text-zinc-500">这段时间里没有匹配的日志。</span>}
      </div>
    </div>
  )
}
