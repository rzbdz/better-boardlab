/** The API tab: every endpoint boardd serves, grouped by module, and the OpenAPI document for programs. */
import { useEffect, useMemo, useState } from 'react'
import { call } from '../../../src/ui/api.ts'
import type { ModuleInfo } from 'boardlab-core/shared/types.ts'
import { Section } from '../kit.tsx'

interface Described { method: string, path: string, about: string, module: string }
interface Index { described: Described[], modules: ModuleInfo[] }

export function ApiTab() {
  const [index, setIndex] = useState<Index | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  useEffect(() => { call<Index>('GET', 'api').then(setIndex, (e: Error) => setError(e.message)) }, [])
  const groups = useMemo(() => {
    if (!index) return []
    const text = query.trim().toLowerCase()
    const titles = new Map(index.modules.map(module => [module.id, module.title]))
    const byModule = new Map<string, Described[]>()
    for (const item of index.described) {
      if (text && !`${item.method} ${item.path} ${item.about}`.toLowerCase().includes(text)) continue
      const title = titles.get(item.module) ?? item.module
      byModule.set(title, [...(byModule.get(title) ?? []), item])
    }
    return [...byModule].map(([title, items]) => ({ title, items: items.sort((a, b) => a.path.localeCompare(b.path)) })).sort((a, b) => a.title.localeCompare(b.title))
  }, [index, query])
  return (
    <div className="stack narrow">
      <Section title="接口" extra={
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="筛接口：路径、方法或说明" aria-label="筛接口" />
      }>
        <p className="muted">boardd 的全部接口，按模块分组；程序和爬虫用同内容的 OpenAPI 3.1 文档：<a href="api/openapi.json" target="_blank" rel="noreferrer">api/openapi.json</a>。</p>
        {error && <p className="warn">取不到接口列表：{error}</p>}
        {!index && !error && <p className="muted">加载中…</p>}
        {groups.map(group => (
          <div key={group.title} style={{ marginTop: 12 }}>
            <h3>{group.title} <span className="muted">{group.items.length}</span></h3>
            <ul className="log">
              {group.items.map(item => (
                <li key={`${item.method} ${item.path}`}>
                  <span className="tag">{item.method}</span>
                  <span className="what"><code>{item.path}</code><span className="muted detail">{item.about}</span></span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Section>
    </div>
  )
}
