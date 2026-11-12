/**
 * A small Markdown renderer for help pages, as React elements (no HTML is ever taken from the text): headings,
 * paragraphs, lists, block quotes, fenced code, and inline code, bold, emphasis and links (http, https, or a page's own
 * relative path).
 */
import type { ReactNode } from 'react'

const SAFE_LINK = /^(https?:\/\/|\.{0,2}\/|#)/i

function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = []
  // `code`, **bold**, *em* / _em_, [text](href)
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|\b_([^_]+)_\b|\[([^\]]+)\]\(([^)\s]+)\)/g
  let last = 0, match: RegExpExecArray | null, n = key
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const [, code, bold, em, em2, label, href] = match
    if (code !== undefined) out.push(<code key={n++} className="mono">{code}</code>)
    else if (bold !== undefined) out.push(<b key={n++}>{inline(bold, n * 100)}</b>)
    else if (em !== undefined || em2 !== undefined) out.push(<i key={n++}>{inline(em ?? em2!, n * 100)}</i>)
    else if (label !== undefined) out.push(SAFE_LINK.test(href!) ? <a key={n++} href={href} target="_blank" rel="noreferrer">{label}</a> : `${label} (${href})`)
    last = pattern.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

type Block =
  | { kind: 'heading', level: number, text: string }
  | { kind: 'para', text: string }
  | { kind: 'list', ordered: boolean, items: string[] }
  | { kind: 'quote', text: string }
  | { kind: 'code', text: string }

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) { i++; continue }
    const fence = /^\s*(```|~~~)/.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!)
      i++
      blocks.push({ kind: 'code', text: body.join('\n') })
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) { blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim() }); i++; continue }
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/
    if (item.test(line)) {
      const ordered = /^\s*\d/.test(line), items: string[] = []
      while (i < lines.length && lines[i]!.trim()) {
        const found = item.exec(lines[i]!)
        if (found) items.push(found[2]!)
        else if (items.length) items[items.length - 1] += ` ${lines[i]!.trim()}`
        i++
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    if (line.startsWith('>')) {
      const text: string[] = []
      while (i < lines.length && lines[i]!.startsWith('>')) text.push(lines[i++]!.replace(/^>\s?/, ''))
      blocks.push({ kind: 'quote', text: text.join(' ') })
      continue
    }
    const text: string[] = []
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|\s*```|\s*~~~|>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]!)) text.push(lines[i++]!.trim())
    blocks.push({ kind: 'para', text: text.join(' ') })
  }
  return blocks
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {parseMarkdown(text).map((block, index) => {
        switch (block.kind) {
          case 'heading': return block.level === 1 ? <h2 key={index}>{inline(block.text)}</h2> : block.level === 2 ? <h3 key={index}>{inline(block.text)}</h3> : <h4 key={index}>{inline(block.text)}</h4>
          case 'para': return <p key={index}>{inline(block.text)}</p>
          case 'quote': return <blockquote key={index}>{inline(block.text)}</blockquote>
          case 'code': return <pre key={index} className="mv-pre">{block.text}</pre>
          case 'list': {
            const items = block.items.map((item, at) => <li key={at}>{inline(item)}</li>)
            return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>
          }
        }
      })}
    </div>
  )
}
