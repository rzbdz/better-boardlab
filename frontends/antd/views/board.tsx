/**
 * One board's workspace, beside the list: who has it and what it is, its actions in one toolbar, and tabs for the live
 * console, the log (search, download, wget) and recent history. Actions follow the lock.
 */
import { CodeOutlined, EyeInvisibleOutlined, EyeOutlined, FileTextOutlined, HistoryOutlined, LockOutlined, MoreOutlined, PoweroffOutlined, ReloadOutlined, ThunderboltOutlined, UnlockOutlined } from '@ant-design/icons'
import { Alert, App, Badge as DotBadge, Button, Dropdown, Empty, Modal, Select, Space, Tabs, Tag, Tooltip, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { api, type PageState } from '../../../src/ui/api.ts'
import { onPrefs, prefs } from '../../../src/ui/notify.ts'
import type { Board, BoardDetail } from 'boardlab-core/shared/types.ts'
import { SerialConsole, STATUS_TEXT, type ConsoleStatus } from '../console.tsx'
import { ACTIONS, ago, MODE, stamp, who } from '../format.ts'
import { LogPanel } from '../logs.tsx'
import { boardState } from './boards.tsx'
import { LockDialog, StealDialog, useBoardActions } from './dialogs.tsx'

function useWatched(board: string) {
  const [on, setOn] = useState(prefs.get().watched.includes(board))
  useEffect(() => { setOn(prefs.get().watched.includes(board)); return onPrefs(next => setOn(next.watched.includes(board))) }, [board])
  return [on, () => prefs.watch(board, !on)] as const
}

export function BoardWorkspace({ state, board, dark }: { state: PageState, board: Board | null, dark: boolean }) {
  if (!board) return <div className="bl-panel" style={{ flex: 1, display: 'grid', placeItems: 'center' }}><Empty description="选一块板子" /></div>
  return <Workspace key={board.name} state={state} board={board} dark={dark} />
}

function Workspace({ state, board, dark }: { state: PageState, board: Board, dark: boolean }) {
  const actions = useBoardActions()
  const { message } = App.useApp()
  const [detail, setDetail] = useState<BoardDetail | null>(null)
  const [die, setDie] = useState<string | undefined>(undefined)
  const [status, setStatus] = useState<ConsoleStatus>('connecting')
  const [dialog, setDialog] = useState<'lock' | 'queue' | 'steal' | 'sdk' | null>(null)
  const [sdk, setSdk] = useState<string>()
  const [method, setMethod] = useState<'load' | 'download'>('load')
  const [tab, setTab] = useState('console')
  const [watched, toggleWatch] = useWatched(board.name)
  useEffect(() => { void api.board(board.name).then(setDetail).catch(() => {}) }, [board.name, board.lease?.id, board.mode])
  const you = state.you
  const mine = board.lease?.holder === you
  const s = boardState(board, you)
  const dies = board.chips.filter(chip => chip.online || board.lab)
  const chosenDie = die ?? dies[0]?.die
  const vacant = !!board.lab?.empty
  const place = board.waiters.findIndex(waiter => waiter.holder === you)
  const where = board.slotRef ?? (board.slot !== null ? `槽位 ${board.slot}` : '—')

  const primary = mine ? (
    <Space.Compact>
      <Button icon={<PoweroffOutlined />} loading={actions.busy === `${board.name}:reset`} onClick={() => actions.reset(board)}>复位</Button>
      <Button icon={<ThunderboltOutlined />} loading={actions.busy === `${board.name}:fastboot`} onClick={() => actions.fastboot(board)}>fastboot</Button>
      {!!board.lab?.sdks.length && <Button onClick={() => { setSdk(board.lab!.sdks[0]); setDialog('sdk') }}>SDK 启动</Button>}
    </Space.Compact>
  ) : !board.lease && !board.lab?.heldBy && !vacant ? <Button type="primary" icon={<LockOutlined />} onClick={() => setDialog('lock')}>拿锁</Button>
    : board.lease || board.lab?.heldBy ? (place >= 0
      ? <Button onClick={() => void api.unqueue(board.name).then(() => message.success('已退出排队'))}>排第 {place + 1} 位 · 退出排队</Button>
      : <Button onClick={() => setDialog('queue')}>排队</Button>) : null

  const more = [
    ...(mine && board.lab?.canRefresh ? [{ key: 'refresh', icon: <ReloadOutlined />, label: '重新读取（槽位里换了板子）', onClick: () => void api.refresh(board.name, {}).then(result => message.success(result.message), error => message.error((error as Error).message)) }] : []),
    { key: 'watch', icon: watched ? <EyeInvisibleOutlined /> : <EyeOutlined />, label: watched ? '不再关注' : '关注：空闲时通知我', onClick: toggleWatch },
    ...(board.lease && !mine ? [{ type: 'divider' as const }, { key: 'steal', danger: true, label: '抢锁…', onClick: () => setDialog('steal') }] : []),
  ]

  return (
    <div className="bl-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
      <div className="bl-panel-head" style={{ alignItems: 'flex-start', paddingTop: 12, paddingBottom: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div className="bl-eyebrow">{board.lab ? `实验室 ${board.lab.id}` : '本机'} · {where}</div>
          <Space size={10} align="center" style={{ marginTop: 2 }}>
            <Typography.Title level={5} style={{ margin: 0, fontSize: 16, letterSpacing: '-.01em' }} ellipsis>{vacant ? `空槽位 ${where}` : board.name}</Typography.Title>
            <DotBadge status={s.tone} text={<span style={{ fontSize: 12 }}>{s.text}</span>} />
          </Space>
        </div>
        <Space size={8} wrap style={{ justifyContent: 'flex-end' }}>
          {primary}
          {mine && <Button icon={<UnlockOutlined />} onClick={() => actions.unlock(board)}>{board.waiters[0] ? `放锁 → ${who(board.waiters[0].holder)}` : '放锁'}</Button>}
          <Dropdown trigger={['click']} menu={{ items: more }}><Button icon={<MoreOutlined />} aria-label="更多" /></Dropdown>
        </Space>
      </div>

      {(board.lab?.slotGone || board.lab?.attention || board.lab?.progress) && (
        <div style={{ padding: '10px 14px 0', display: 'grid', gap: 8 }}>
          {board.lab?.slotGone && <Alert type="error" showIcon message="这块板的槽位串口不见了" description={`串口线拔掉或换了口。最近重新布线过的话，到「发现」里重建主机 ${board.slotRef?.split('/')[1] ?? ''}。`} />}
          {board.lab?.attention && <Alert type="warning" showIcon message="需要你操作" description={board.lab.attention}
            action={board.lab.canConfirm ? <Button size="small" type="primary" onClick={() => void api.confirm(board.name).then(() => message.success('已告诉实验室'))}>我已完成</Button> : undefined} />}
          {board.lab?.progress && <Alert type="info" showIcon message={board.lab.progress} />}
        </div>
      )}

      <dl className="bl-facts" style={{ padding: '12px 14px', margin: 0, borderBottom: '1px solid var(--bl-line)' }}>
        {[
          ['型号', vacant ? '—' : board.product ?? '未知'], ['SoC', board.soc?.toUpperCase() ?? '—'], ['模式', MODE[board.mode]],
          ['使用者', board.lease ? `${who(board.lease.holder)} · ${board.lease.purpose}` : '—'],
          ['排队', board.waiters.length ? board.waiters.map(waiter => who(waiter.holder)).join('、') : '—'],
          ['复位', board.lab?.mediaBoot ? (board.lab.mediaBoot.method === 'reset' ? '从介质启动' : board.lab.mediaBoot.available ? `经 ${board.lab.mediaBoot.method} 从介质启动` : '停在下载模式') : '—'],
          ['下载口', board.chips.map(chip => chip.downloadUsbPath).filter(Boolean).join('、') || '—'],
          ['自', board.lease ? ago(board.lease.startedAt) : '—'],
        ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd title={value}>{value}</dd></div>)}
      </dl>

      <Tabs activeKey={tab} onChange={setTab} size="small" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
        tabBarStyle={{ margin: 0, padding: '0 14px', borderBottom: '1px solid var(--bl-line)' }}
        tabBarExtraContent={tab === 'console' && (
          <Space size={10}>
            {board.lease && !mine && <Tooltip title="你的输入会和持锁人的混在一起"><Tag color="warning" bordered={false}>锁在 {who(board.lease.holder)} 手里</Tag></Tooltip>}
            <DotBadge status={status === 'live' ? 'success' : status === 'retry' ? 'warning' : 'default'} text={<span style={{ fontSize: 12 }}>{STATUS_TEXT[status]}</span>} />
            {dies.length > 1 && <Select size="small" value={chosenDie} onChange={setDie} options={dies.map(chip => ({ value: chip.die, label: chip.die }))} />}
          </Space>
        )}
        items={[
          {
            key: 'console', label: <Space size={6}><CodeOutlined />串口</Space>,
            children: dies.length || board.lab
              ? <div style={{ height: '100%', display: 'flex' }}><SerialConsole key={`${board.name}:${chosenDie ?? ''}`} board={board.name} die={chosenDie} dark={dark} onStatus={setStatus} /></div>
              : <Empty description="没有在线的串口" style={{ padding: 40 }} />,
          },
          { key: 'logs', label: <Space size={6}><FileTextOutlined />日志</Space>, children: <LogPanel board={board.name} die={chosenDie} /> },
          {
            key: 'history', label: <Space size={6}><HistoryOutlined />记录</Space>, children: (
              <div style={{ overflow: 'auto', height: '100%' }}>
                {!detail?.actions.length ? <Empty description="还没有操作记录" style={{ padding: 40 }} /> : (
                  <table className="bl-mini">
                    <tbody>{detail.actions.slice(0, 60).map(action => (
                      <tr key={action.id}>
                        <td className="bl-mono bl-num" style={{ color: 'var(--bl-text3)', whiteSpace: 'nowrap' }}>{stamp(action.at)}</td>
                        <td><Tag bordered={false} color={action.ok ? undefined : 'error'}>{ACTIONS[action.kind] ?? action.kind}</Tag></td>
                        <td style={{ whiteSpace: 'nowrap' }}>{who(action.actor)}</td>
                        <td style={{ color: action.ok ? 'var(--bl-text2)' : '#f04438' }}>{action.ok ? action.detail : action.message}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                )}
              </div>
            ),
          },
        ]} />

      {(dialog === 'lock' || dialog === 'queue') && <LockDialog board={board} queue={dialog === 'queue'} onClose={() => setDialog(null)} />}
      {dialog === 'steal' && <StealDialog board={board} onClose={() => setDialog(null)} />}
      {dialog === 'sdk' && (
        <Modal open title={`用 SDK 启动 ${board.name}`} okText={method === 'download' ? '刷机' : '内存启动'} cancelText="取消" onCancel={() => setDialog(null)}
          onOk={() => { setDialog(null); const hide = message.loading('启动中，进度显示在板子上…', 0); void api.bootSdk(board.name, sdk!, method).then(() => { hide(); message.success('完成') }, error => { hide(); message.error((error as Error).message) }) }}>
          <Space direction="vertical" style={{ width: '100%' }} size={10}>
            <Typography.Text type="secondary">板子所在的主机去构建服务器取这个 SDK 的产物，按它的启动流程加载或烧录。</Typography.Text>
            <Select value={sdk} onChange={setSdk} options={board.lab?.sdks.map(item => ({ value: item, label: item }))} style={{ width: '100%' }} />
            <Select value={method} onChange={setMethod} style={{ width: '100%' }} options={[{ value: 'load', label: '内存启动（不写板子）' }, { value: 'download', label: '刷机（烧录到板上存储）' }]} />
          </Space>
        </Modal>
      )}
    </div>
  )
}
