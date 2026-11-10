/** History: every action, every lock, and what modules add (past scans). */
import { Card, Flex, Select, Table, Tabs, Tag, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { api, type History, type PageState } from '../../../src/ui/api.ts'
import type { Action, Lease } from 'boardlab-core/shared/types.ts'
import { ACTIONS, stamp, who } from '../../../src/ui/format.ts'
import { ViewCard, viewsFor } from '../render.tsx'

const LEASE: Record<Lease['status'], { text: string, color: string }> = { held: { text: '使用中', color: 'processing' }, released: { text: '已释放', color: 'default' }, stolen: { text: '被抢', color: 'warning' } }

export function HistoryPage({ state, refreshKey, onJobStarted }: { state: PageState, refreshKey: number, onJobStarted: () => void }) {
  const [history, setHistory] = useState<History | null>(null)
  const [board, setBoard] = useState<string | undefined>()
  const [kind, setKind] = useState<string | undefined>()
  useEffect(() => { void api.history().then(setHistory).catch(() => {}) }, [refreshKey])
  const boards = useMemo(() => [...new Set((history?.actions ?? []).map(action => action.board).filter((name): name is string => !!name))].sort(), [history])
  const kinds = useMemo(() => [...new Set((history?.actions ?? []).map(action => action.kind))].sort(), [history])
  const actions = (history?.actions ?? []).filter(action => (!board || action.board === board) && (!kind || action.kind === kind))
  const moduleViews = history ? viewsFor({ ...state, history }, 'history') : []
  return (
    <Card variant="borderless" style={{ boxShadow: 'var(--bl-card-shadow)' }} styles={{ body: { paddingTop: 8 } }}>
      <Tabs items={[
        {
          key: 'actions', label: '操作记录', children: (
            <Flex vertical gap={12}>
              <Flex gap={12} wrap>
                <Select allowClear placeholder="全部板子" value={board} onChange={setBoard} options={boards.map(name => ({ value: name, label: name }))} style={{ width: 220 }} showSearch />
                <Select allowClear placeholder="全部操作" value={kind} onChange={setKind} options={kinds.map(item => ({ value: item, label: ACTIONS[item] ?? item }))} style={{ width: 180 }} />
              </Flex>
              <Table<Action> size="small" rowKey="id" loading={!history} dataSource={actions} pagination={{ pageSize: 30, showSizeChanger: false }} scroll={{ x: 760 }}
                columns={[
                  { title: '时间', dataIndex: 'at', width: 150, render: value => <Typography.Text type="secondary" className="bl-mono" style={{ fontSize: 12 }}>{stamp(value)}</Typography.Text> },
                  { title: '谁', dataIndex: 'actor', width: 160, render: value => who(value) },
                  { title: '操作', dataIndex: 'kind', width: 130, render: value => <Tag bordered={false}>{ACTIONS[value] ?? value}</Tag> },
                  { title: '板子', dataIndex: 'board', width: 200, render: value => value ?? '—' },
                  { title: '详情', key: 'detail', render: (_, action) => action.ok ? <Typography.Text type="secondary">{action.detail}</Typography.Text> : <Typography.Text type="danger">失败：{action.message}</Typography.Text> },
                ]} />
            </Flex>
          ),
        },
        {
          key: 'leases', label: '锁记录', children: (
            <Table<Lease> size="small" rowKey="id" loading={!history} dataSource={history?.leases ?? []} pagination={{ pageSize: 30, showSizeChanger: false }}
              columns={[
                { title: '开始', dataIndex: 'startedAt', width: 150, render: value => <Typography.Text type="secondary" className="bl-mono" style={{ fontSize: 12 }}>{stamp(value)}</Typography.Text> },
                { title: '谁', dataIndex: 'holder', width: 160, render: value => who(value) },
                { title: '板子', dataIndex: 'board', width: 200 },
                { title: '用途', dataIndex: 'purpose' },
                { title: '状态', key: 'status', width: 200, render: (_, lease) => <><Tag bordered={false} color={LEASE[lease.status].color}>{LEASE[lease.status].text}</Tag>{lease.endedAt && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{stamp(lease.endedAt)}</Typography.Text>}</> },
              ]} />
          ),
        },
        ...moduleViews.map(view => ({ key: view.id, label: view.title ?? view.id, children: <ViewCard view={view} onJobStarted={onJobStarted} /> })),
      ]} />
    </Card>
  )
}
