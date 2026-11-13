/** Every API boardd serves, grouped by module, with the OpenAPI document for programs and crawlers. */
import { Card, Flex, Input, Table, Tag, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { call } from '../../../src/ui/api.ts'
import type { ModuleInfo } from 'boardlab-core/shared/types.ts'

interface Described { method: string, path: string, about: string, module: string }
interface Index { described: Described[], modules: ModuleInfo[], openapi?: string }
type Row = Described & { key: string, group: string }

export function ApiPage() {
  const [index, setIndex] = useState<Index | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  useEffect(() => { void call<Index>('GET', 'api').then(setIndex, (e: Error) => setError(e.message)) }, [])
  const rows = useMemo<Row[]>(() => {
    if (!index) return []
    const text = query.trim().toLowerCase()
    const titles = new Map(index.modules.map(module => [module.id, module.title]))
    return index.described
      .filter(item => !text || `${item.method} ${item.path} ${item.about}`.toLowerCase().includes(text))
      .map(item => ({ ...item, key: `${item.method} ${item.path}`, group: titles.get(item.module) ?? item.module }))
      .sort((a, b) => a.group.localeCompare(b.group) || a.path.localeCompare(b.path))
  }, [index, query])
  return (
    <Card variant="borderless" style={{ boxShadow: 'var(--bl-card-shadow)' }}>
      <Flex vertical gap={12}>
        <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
          boardd 的全部接口，按模块分组；程序和爬虫用同内容的 OpenAPI 3.1 文档：<a href="api/openapi.json" target="_blank" rel="noreferrer">api/openapi.json</a>。
        </Typography.Paragraph>
        <Flex gap={12} wrap align="center">
          <Input allowClear placeholder="筛接口：路径、方法或说明" value={query} onChange={e => setQuery(e.target.value)} style={{ maxWidth: 360 }} />
          {index && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{index.described.length} 个接口</Typography.Text>}
        </Flex>
        {error && <Typography.Text type="danger">取不到接口列表：{error}</Typography.Text>}
        <Table<Row> size="small" loading={!index && !error} dataSource={rows} pagination={{ pageSize: 40, showSizeChanger: false }}
          columns={[
            { title: '模块', dataIndex: 'group', width: 180 },
            { title: '方法', dataIndex: 'method', width: 80, render: (value: string) => <Tag bordered={false} color={value === 'GET' ? 'default' : 'processing'}>{value}</Tag> },
            { title: '路径', dataIndex: 'path', width: 320, render: (value: string) => <Typography.Text className="bl-mono" style={{ fontSize: 12 }}>{value}</Typography.Text> },
            { title: '说明', dataIndex: 'about' },
          ]} />
      </Flex>
    </Card>
  )
}
