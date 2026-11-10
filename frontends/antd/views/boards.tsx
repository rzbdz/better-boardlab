/**
 * The boards page: the list and the chosen board's workspace side by side. The list is a compact table with a
 * status strip, filters and search; ↑/↓ (or j/k) move through it, and the workspace follows.
 */
import { SearchOutlined } from '@ant-design/icons'
import { Badge as DotBadge, Input, Segmented, Table, Tooltip, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import type { PageState } from '../../../src/ui/api.ts'
import type { Board } from 'boardlab-core/shared/types.ts'
import { ago, who } from '../format.ts'
import { BoardWorkspace } from './board.tsx'

type Filter = 'all' | 'free' | 'mine' | 'busy'

export function boardState(board: Board, you: string): { tone: 'success' | 'processing' | 'warning' | 'error' | 'default', text: string } {
  if (board.lab?.empty) return { tone: 'default', text: '空槽位' }
  if (board.lab?.slotGone) return { tone: 'error', text: '串口不见了' }
  if (board.lab?.attention) return { tone: 'warning', text: '等人操作' }
  if (board.lease?.holder === you) return { tone: 'processing', text: '你在使用' }
  if (board.lease) return { tone: 'warning', text: `${who(board.lease.holder)} 在用` }
  if (board.lab?.heldBy) return { tone: 'warning', text: '实验室占用' }
  return { tone: 'success', text: '空闲' }
}

const where = (board: Board) => board.lab ? (board.slotRef?.split('/').slice(1).join('/') ?? board.lab.device) : board.slot !== null ? `槽位 ${board.slot}` : '—'

export function BoardsPage({ state, dark, selected, onSelect }: { state: PageState, dark: boolean, selected: string | null, onSelect: (board: string) => void }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const you = state.you
  const real = state.boards.filter(board => !board.lab?.empty)
  const counts = {
    all: real.length,
    free: real.filter(board => !board.lease && !board.lab?.heldBy).length,
    mine: real.filter(board => board.lease?.holder === you).length,
    busy: real.filter(board => board.lease && board.lease.holder !== you).length,
  }
  const shown = useMemo(() => state.boards.filter(board => {
    if (filter === 'free' && (board.lease || board.lab?.heldBy || board.lab?.empty)) return false
    if (filter === 'mine' && board.lease?.holder !== you) return false
    if (filter === 'busy' && !(board.lease && board.lease.holder !== you)) return false
    const q = query.trim().toLowerCase()
    return !q || [board.name, board.product, board.soc, board.slotRef, board.lease?.holder, board.lab?.id].some(value => value?.toLowerCase().includes(q))
  }).sort((a, b) => Number(!!a.lab?.empty) - Number(!!b.lab?.empty) || a.name.localeCompare(b.name)), [state.boards, filter, query, you])
  const current = state.boards.find(board => board.name === selected) ?? shown[0] ?? null

  useEffect(() => { if (!selected && shown[0]) onSelect(shown[0].name) }, [selected, shown[0]?.name])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, .xterm, [contenteditable]')) return
      const at = shown.findIndex(board => board.name === current?.name)
      if ((event.key === 'ArrowDown' || event.key === 'j') && at < shown.length - 1) { onSelect(shown[at + 1]!.name); event.preventDefault() }
      if ((event.key === 'ArrowUp' || event.key === 'k') && at > 0) { onSelect(shown[at - 1]!.name); event.preventDefault() }
      if (event.key === '/') { document.getElementById('bl-board-search')?.focus(); event.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shown, current?.name])

  return (
    <div className="bl-split">
      <div style={{ gap: 12 }}>
        <div className="bl-stats">
          <div><span>板子</span><b>{counts.all}</b></div>
          <div><span>空闲</span><b style={{ color: '#12b76a' }}>{counts.free}</b></div>
          <div><span>我的</span><b style={{ color: 'var(--bl-accent)' }}>{counts.mine}</b></div>
          <div><span>别人在用</span><b style={{ color: '#f79009' }}>{counts.busy}</b></div>
        </div>
        <div className="bl-panel" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="bl-toolbar" style={{ padding: '8px 10px', borderBottom: '1px solid var(--bl-line)' }}>
            <Segmented<Filter> size="small" value={filter} onChange={setFilter} options={[
              { label: '全部', value: 'all' }, { label: '空闲', value: 'free' }, { label: '我的', value: 'mine' }, { label: '在用', value: 'busy' },
            ]} />
            <span className="bl-grow" />
            <Tooltip title="按 / 搜索，↑↓ 或 j/k 切换板子">
              <Input id="bl-board-search" size="small" allowClear prefix={<SearchOutlined />} placeholder="搜索" value={query} onChange={event => setQuery(event.target.value)} style={{ width: 200 }} />
            </Tooltip>
          </div>
          <div className="bl-scroll">
            <Table<Board> rowKey="name" dataSource={shown} pagination={false} size="small" sticky showHeader
              rowClassName={board => [board.name === current?.name ? 'bl-current' : '', board.lab?.slotGone ? 'bl-dim' : ''].join(' ')}
              onRow={board => ({ onClick: () => onSelect(board.name) })}
              columns={[
                {
                  title: '板子', key: 'name', ellipsis: true, render: (_, board) => (
                    <div style={{ minWidth: 0 }}>
                      <Typography.Text strong style={{ fontSize: 13 }} ellipsis>{board.lab?.empty ? `空槽位 ${where(board)}` : board.name}</Typography.Text>
                      <div style={{ fontSize: 12, color: 'var(--bl-text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {board.lab?.empty ? '只有串口' : [board.product ?? '型号未知', board.soc?.toUpperCase()].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                  ),
                },
                { title: '位置', key: 'where', width: 132, ellipsis: true, render: (_, board) => <span className="bl-mono" style={{ fontSize: 12 }}>{where(board)}</span> },
                {
                  title: '状态', key: 'state', width: 150, render: (_, board) => {
                    const s = boardState(board, you)
                    return (
                      <div>
                        <DotBadge status={s.tone} text={<span style={{ fontSize: 12 }}>{s.text}</span>} />
                        {board.lease && <div style={{ fontSize: 11, color: 'var(--bl-text3)' }} className="bl-num">{ago(board.lease.startedAt)}{board.waiters.length ? ` · 排队 ${board.waiters.length}` : ''}</div>}
                      </div>
                    )
                  },
                },
                { title: '串口', key: 'serial', width: 56, align: 'center', render: (_, board) => <DotBadge status={board.chips.some(chip => chip.online) ? 'success' : 'default'} /> },
              ]} />
          </div>
        </div>
      </div>
      <div><BoardWorkspace state={state} board={current} dark={dark} /></div>
    </div>
  )
}
