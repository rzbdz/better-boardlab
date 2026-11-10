/** The boards page: a summary, filters, and a table of every board, with a drawer for one board's details. */
import { ApiOutlined, LockOutlined, PoweroffOutlined, SearchOutlined, ThunderboltOutlined, UnlockOutlined } from '@ant-design/icons'
import { App, Badge as DotBadge, Button, Card, Col, Dropdown, Flex, Input, Row, Segmented, Space, Statistic, Table, Tag, Tooltip, Typography } from 'antd'
import { useMemo, useState } from 'react'
import { api, type PageState } from '../../../src/ui/api.ts'
import type { Board } from 'boardlab-core/shared/types.ts'
import { ago, MODE, who } from '../format.ts'
import { LockDialog, useBoardActions } from './dialogs.tsx'

type Filter = 'all' | 'free' | 'mine' | 'busy'

export function boardState(board: Board, you: string): { tone: 'success' | 'processing' | 'warning' | 'error' | 'default', text: string } {
  if (board.lab?.empty) return { tone: 'default', text: '空槽位' }
  if (board.lab?.slotGone) return { tone: 'error', text: '槽位串口不见了' }
  if (board.lease?.holder === you) return { tone: 'processing', text: '你在使用' }
  if (board.lease) return { tone: 'warning', text: `${who(board.lease.holder)} 在用` }
  if (board.lab?.heldBy) return { tone: 'warning', text: '实验室占用' }
  return { tone: 'success', text: '空闲' }
}

const where = (board: Board) => board.lab ? (board.slotRef?.split('/').slice(1).join('/') ?? board.lab.device) : board.slot !== null ? `槽位 ${board.slot}` : '—'

export function BoardsPage({ state, onOpen }: { state: PageState, onOpen: (board: string) => void }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [lockFor, setLockFor] = useState<{ board: Board, queue: boolean } | null>(null)
  const actions = useBoardActions()
  const { message } = App.useApp()
  const you = state.you
  const boards = state.boards
  const counts = {
    all: boards.filter(board => !board.lab?.empty).length,
    free: boards.filter(board => !board.lab?.empty && !board.lease && !board.lab?.heldBy).length,
    mine: boards.filter(board => board.lease?.holder === you).length,
    busy: boards.filter(board => board.lease && board.lease.holder !== you).length,
    queued: boards.filter(board => board.waiters.some(waiter => waiter.holder === you)).length,
  }
  const shown = useMemo(() => boards.filter(board => {
    if (filter === 'free' && (board.lease || board.lab?.heldBy || board.lab?.empty)) return false
    if (filter === 'mine' && board.lease?.holder !== you) return false
    if (filter === 'busy' && !(board.lease && board.lease.holder !== you)) return false
    const q = query.trim().toLowerCase()
    return !q || [board.name, board.product, board.soc, board.slotRef, board.lease?.holder, board.lab?.id].some(value => value?.toLowerCase().includes(q))
  }).sort((a, b) => Number(!!a.lab?.empty) - Number(!!b.lab?.empty) || a.name.localeCompare(b.name)), [boards, filter, query, you])

  return (
    <Flex vertical gap={20}>
      <Row gutter={[16, 16]}>
        {[
          { label: '板子', value: counts.all, icon: <ApiOutlined /> },
          { label: '空闲', value: counts.free, icon: <UnlockOutlined />, color: '#16a34a' },
          { label: '你在使用', value: counts.mine, icon: <LockOutlined />, color: '#0a66ff' },
          { label: '别人在用', value: counts.busy, icon: <ThunderboltOutlined />, color: '#d97706', extra: counts.queued ? `你在排 ${counts.queued} 块` : undefined },
        ].map(item => (
          <Col key={item.label} xs={12} md={6}>
            <Card variant="borderless" style={{ boxShadow: 'var(--bl-card-shadow)' }}>
              <Statistic title={<Space size={6}>{item.icon}{item.label}</Space>} value={item.value} valueStyle={{ fontWeight: 600, color: item.color }} />
              {item.extra && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{item.extra}</Typography.Text>}
            </Card>
          </Col>
        ))}
      </Row>

      <Card variant="borderless" style={{ boxShadow: 'var(--bl-card-shadow)' }} styles={{ body: { padding: 0 } }}>
        <Flex justify="space-between" align="center" wrap gap={12} style={{ padding: '16px 20px' }}>
          <Segmented<Filter> value={filter} onChange={setFilter} options={[
            { label: `全部 ${counts.all}`, value: 'all' }, { label: `空闲 ${counts.free}`, value: 'free' },
            { label: `我的 ${counts.mine}`, value: 'mine' }, { label: `在用 ${counts.busy}`, value: 'busy' },
          ]} />
          <Input allowClear prefix={<SearchOutlined />} placeholder="搜索板名、型号、槽位、持有人" value={query} onChange={event => setQuery(event.target.value)} style={{ width: 280 }} />
        </Flex>
        <Table<Board> rowKey="name" dataSource={shown} pagination={false} size="middle" scroll={{ x: 900 }}
          onRow={board => ({ onClick: event => { if (!(event.target as HTMLElement).closest('button, .ant-dropdown-trigger')) onOpen(board.name) }, style: { cursor: 'pointer', opacity: board.lab?.slotGone ? 0.55 : 1 } })}
          columns={[
            {
              title: '板子', key: 'name', render: (_, board) => (
                <Flex vertical gap={2}>
                  <Typography.Text strong>{board.lab?.empty ? `空槽位 ${where(board)}` : board.name}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{board.lab?.empty ? '只有串口，还没有登记板子' : [board.product ?? '型号未知', board.soc?.toUpperCase()].filter(Boolean).join(' · ')}</Typography.Text>
                </Flex>
              ),
            },
            {
              title: '位置', key: 'where', render: (_, board) => (
                <Flex vertical gap={2}>
                  <span>{where(board)}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{board.lab ? `实验室 ${board.lab.id}` : '本机'}</Typography.Text>
                </Flex>
              ),
            },
            {
              title: '状态', key: 'state', render: (_, board) => {
                const s = boardState(board, you)
                return <Flex vertical gap={2}><DotBadge status={s.tone} text={s.text} />{board.lease && <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis={{ tooltip: board.lease.purpose }}>{board.lease.purpose} · {ago(board.lease.startedAt)}</Typography.Text>}</Flex>
              },
            },
            {
              title: '串口', key: 'serial', render: (_, board) => {
                const online = board.chips.some(chip => chip.online)
                return <DotBadge status={online ? 'success' : 'default'} text={online ? '在线' : '离线'} />
              },
            },
            { title: '模式', key: 'mode', render: (_, board) => board.lab?.progress ? <Tag color="processing" bordered={false}>{board.lab.progress}</Tag> : <Typography.Text type="secondary">{MODE[board.mode]}</Typography.Text> },
            { title: '排队', key: 'queue', align: 'center', render: (_, board) => board.waiters.length ? <Tooltip title={board.waiters.map(waiter => who(waiter.holder)).join('、')}><Tag bordered={false}>{board.waiters.length}</Tag></Tooltip> : <Typography.Text type="secondary">—</Typography.Text> },
            {
              title: '', key: 'act', align: 'right', render: (_, board) => {
                const mine = board.lease?.holder === you
                if (board.lab?.empty) return <Button size="small" onClick={() => onOpen(board.name)}>串口</Button>
                if (mine) return (
                  <Space size={6}>
                    <Button size="small" icon={<PoweroffOutlined />} loading={actions.busy === `${board.name}:reset`} onClick={() => actions.reset(board)}>复位</Button>
                    <Dropdown trigger={['click']} menu={{ items: [
                      { key: 'fastboot', label: '进入 fastboot', onClick: () => actions.fastboot(board) },
                      { key: 'console', label: '打开串口', onClick: () => onOpen(board.name) },
                      { type: 'divider' },
                      { key: 'unlock', label: board.waiters[0] ? `放锁并交给 ${who(board.waiters[0].holder)}` : '放锁', onClick: () => actions.unlock(board) },
                    ] }}><Button size="small">更多</Button></Dropdown>
                  </Space>
                )
                if (board.lease || board.lab?.heldBy) {
                  const place = board.waiters.findIndex(waiter => waiter.holder === you)
                  return place >= 0
                    ? <Button size="small" onClick={() => void api.unqueue(board.name).then(() => message.success('已退出排队'))}>排第 {place + 1} 位 · 退出</Button>
                    : <Button size="small" onClick={() => setLockFor({ board, queue: true })}>排队</Button>
                }
                return <Button size="small" type="primary" icon={<LockOutlined />} onClick={() => setLockFor({ board, queue: false })}>拿锁</Button>
              },
            },
          ]} />
      </Card>
      {lockFor && <LockDialog board={lockFor.board} queue={lockFor.queue} onClose={() => setLockFor(null)} />}
    </Flex>
  )
}
