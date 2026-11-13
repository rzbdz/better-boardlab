/** Every API boardd serves, grouped by module, with the OpenAPI document for programs and crawlers. */
import { useEffect, useMemo, useState } from 'react'
import { call } from '../../../src/ui/api.ts'
import type { ModuleInfo } from 'boardlab-core/shared/types.ts'

interface Described { method: string, path: string, about: string, module: string }
interface Index { described: Described[], modules: ModuleInfo[], openapi?: string }

const ORDER: Record<string, number> = { GET: 0, POST: 1, PUT: 2, DELETE: 3 }

export function ApiPage() {
  const [index, setIndex] = useState<Index | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  useEffect(() => { call<Index>('GET', 'api').then(setIndex, (e: Error) => setError(e.message)) }, [])
  const groups = useMemo(() => {
    if (!index) return []
    const text = query.trim().toLowerCase()
    const shown = index.described.filter(item => !text || `${item.method} ${item.path} ${item.about}`.toLowerCase().includes(text))
    const titles = new Map(index.modules.map(module => [module.id, module.title]))
    const byModule = new Map<string, Described[]>()
    for (const item of shown) byModule.set(item.module, [...(byModule.get(item.module) ?? []), item])
    return [...byModule].map(([id, items]) => ({
      id, title: titles.get(id) ?? id,
      items: items.sort((a, b) => a.path.localeCompare(b.path) || (ORDER[a.method] ?? 9) - (ORDER[b.method] ?? 9)),
    })).sort((a, b) => a.title.localeCompare(b.title))
  }, [index, query])

  return (
    <div className="page">
      <section className="hero"><h1>API</h1>
        <p>boardd 的全部接口，按模块分组。程序和爬虫用同内容的 OpenAPI 3.1 文档：<a className="mono" href="api/openapi.json" target="_blank" rel="noreferrer">api/openapi.json</a>（<a href="api" target="_blank" rel="noreferrer">api</a> 是同样的列表）。</p>
      </section>
      <section className="panel">
        <div className="row-acts" style={{ marginBottom: 10 }}>
          <input className="input" style={{ maxWidth: 360 }} placeholder="筛接口：路径、方法或说明" value={query} onChange={e => setQuery(e.target.value)} />
          {index && <span className="sub small">{index.described.length} 个接口 · {groups.length} 个模块</span>}
        </div>
        {error && <p className="mv-note error">取不到接口列表：{error}</p>}
        {!index && !error && <span className="spin" />}
        {groups.map(group => (
          <div key={group.id} style={{ marginTop: group.id === groups[0]?.id ? 0 : 18 }}>
            <div className="sect">{group.title}<span className="sub small">{group.items.length}</span></div>
            <div className="mv-list">
              {group.items.map(item => (
                <div key={`${item.method} ${item.path}`}>
                  <span className={`tag ${item.method === 'GET' ? '' : 'info'}`}>{item.method}</span>
                  <div className="mv-li-text"><div className="mv-li-title mono">{item.path}</div><div className="mv-li-desc">{item.about}</div></div>
                </div>
              ))}
            </div>
          </div>
        ))}
        {index && !groups.length && <p className="mv-text">没有匹配的接口。</p>}
      </section>
    </div>
  )
}
