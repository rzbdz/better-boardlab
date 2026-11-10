/**
 * One board in a drawer: what it is, who has it, its actions, the live serial console, and its recent history. The
 * console fills the drawer's lower half; actions follow the lock.
 */
import { CodeOutlined, LockOutlined, PoweroffOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { Alert, App, Badge as DotBadge, Button, Descriptions, Drawer, Flex, Modal, Select, Space, Tag, Timeline, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { api, type PageState } from '../../../src/ui/api.ts'
import type { BoardDetail } from 'boardlab-core/shared/types.ts'
import { SerialConsole, STATUS_TEXT, type ConsoleStatus } from '../console.tsx'
import { ACTIONS, ago, MODE, stamp, who } from '../format.ts'
import { boardState } from './boards.tsx'
import { LockDialog, StealDialog, useBoardActions } from './dialogs.tsx'
import { WatchButton } from './notify.tsx'

export function BoardDrawer({ state, name, dark, onClose }: { state: PageState, name: string | null, dark: boolean, onClose: () => void }) {
  const board = state.boards.find(item => item.name === name) ?? null
  const actions = useBoardActions()
  const { message } = App.useApp()
  const [detail, setDetail] = useState<BoardDetail | null>(null)
  const [die, setDie] = useState<string | undefined>(undefined)
  const [status, setStatus] = useState<ConsoleStatus>('connecting')
  const [dialog, setDialog] = useState<'lock' | 'queue' | 'steal' | 'sdk' | null>(null)
  const [sdk, setSdk] = useState<string>()
  const [method, setMethod] = useState<'load' | 'download'>('load')
  useEffect(() => { setDetail(null); setDie(undefined); if (name) void api.board(name).then(setDetail).catch(() => {}) }, [name, board?.lease?.id, board?.mode])
  if (!board) return <Drawer open={false} onClose={onClose} />
  const you = state.you
  const mine = board.lease?.holder === you
  const s = boardState(board, you)
  const dies = board.chips.filter(chip => chip.online || board.lab)
  const vacant = !!board.lab?.empty
  return (
    <Drawer open={!!name} onClose={onClose} width="min(980px, 96vw)" destroyOnClose
      title={<Space size={12}><span>{vacant ? `空槽位 ${board.slotRef?.split('/').slice(1).join('/')}` : board.name}</span><DotBadge status={s.tone} text={s.text} /></Space>}
      extra={
        <Space>
          {!board.lease && !board.lab?.heldBy && !vacant && <Button type="primary" icon={<LockOutlined />} onClick={() => setDialog('lock')}>拿锁</Button>}
          {(board.lease || board.lab?.heldBy) && !mine && <WatchButton board={board.name} />}
          {(board.lease || board.lab?.heldBy) && !mine && <Button onClick={() => setDialog('queue')}>排队</Button>}
          {board.lease && !mine && <Button danger type="text" onClick={() => setDialog('steal')}>抢锁</Button>}
          {mine && <>
            <Button icon={<PoweroffOutlined />} loading={actions.busy === `${board.name}:reset`} onClick={() => actions.reset(board)}>复位</Button>
            <Button icon={<ThunderboltOutlined />} loading={actions.busy === `${board.name}:fastboot`} onClick={() => actions.fastboot(board)}>fastboot</Button>
            {!!board.lab?.sdks.length && <Button onClick={() => { setSdk(board.lab!.sdks[0]); setDialog('sdk') }}>用 SDK 启动</Button>}
            {board.lab?.canRefresh && <Button icon={<ReloadOutlined />} onClick={() => void api.refresh(board.name, {}).then(result => message.success(result.message), error => message.error((error as Error).message))}>重新读取</Button>}
            <Button onClick={() => actions.unlock(board)}>{board.waiters[0] ? `放锁并交给 ${who(board.waiters[0].holder)}` : '放锁'}</Button>
          </>}
        </Space>
      }
      styles={{ body: { display: 'flex', flexDirection: 'column', gap: 16 } }}>
      {board.lab?.slotGone && <Alert type="error" showIcon message="这块板的槽位串口不见了" description={`串口线拔掉或换了口。最近重新布线过的话，到「发现」里重建主机 ${board.slotRef?.split('/')[1] ?? ''}。`} />}
      {board.lab?.attention && <Alert type="warning" showIcon message="需要你操作" description={board.lab.attention}
        action={board.lab.canConfirm ? <Button size="small" type="primary" onClick={() => void api.confirm(board.name).then(() => message.success('已告诉实验室'))}>我已完成</Button> : undefined} />}
      {board.lab?.progress && <Alert type="info" showIcon message={board.lab.progress} />}
      <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }} items={[
        { key: 'p', label: '型号', children: vacant ? '—' : board.product ?? '未知' },
        { key: 's', label: 'SoC', children: board.soc?.toUpperCase() ?? '—' },
        { key: 'w', label: '位置', children: board.slotRef ?? (board.slot !== null ? `槽位 ${board.slot}` : '—') },
        { key: 'm', label: '模式', children: MODE[board.mode] },
        { key: 'l', label: '使用者', children: board.lease ? `${who(board.lease.holder)} · ${board.lease.purpose}` : '—' },
        { key: 'q', label: '排队', children: board.waiters.length ? board.waiters.map(waiter => who(waiter.holder)).join('、') : '—' },
        { key: 'r', label: '复位', children: board.lab?.mediaBoot ? (board.lab.mediaBoot.method === 'reset' ? '从介质启动' : board.lab.mediaBoot.available ? `经 ${board.lab.mediaBoot.method} 从介质启动` : '停在下载模式') : '—' },
        { key: 'u', label: '下载口', children: board.chips.map(chip => chip.downloadUsbPath).filter(Boolean).join('、') || '—' },
      ]} />

      <Flex vertical style={{ flex: 1, minHeight: 360 }} gap={8}>
        <Flex justify="space-between" align="center">
          <Space><CodeOutlined /><Typography.Text strong>串口</Typography.Text><DotBadge status={status === 'live' ? 'success' : status === 'retry' ? 'warning' : 'default'} text={STATUS_TEXT[status]} />
            {board.lease && !mine && <Typography.Text type="secondary" style={{ fontSize: 12 }}>锁在 {who(board.lease.holder)} 手里，你的输入会和对方的混在一起</Typography.Text>}</Space>
          <Space>
            {dies.length > 1 && <Select size="small" value={die ?? dies[0]?.die} onChange={setDie} options={dies.map(chip => ({ value: chip.die, label: chip.die }))} />}
          </Space>
        </Flex>
        {dies.length || board.lab ? <SerialConsole key={`${board.name}:${die ?? ''}`} board={board.name} die={die ?? dies[0]?.die} dark={dark} onStatus={setStatus} />
          : <Alert type="info" message="没有在线的串口" />}
      </Flex>

      {detail && detail.actions.length > 0 && (
        <div>
          <Typography.Text strong>最近的操作</Typography.Text>
          <Timeline style={{ marginTop: 12 }} items={detail.actions.slice(0, 8).map(action => ({
            key: action.id, color: action.ok ? 'blue' : 'red',
            children: <Space size={8} wrap><Typography.Text type="secondary" className="bl-mono" style={{ fontSize: 12 }}>{stamp(action.at)}</Typography.Text><Tag bordered={false}>{ACTIONS[action.kind] ?? action.kind}</Tag><span>{who(action.actor)}</span>{!action.ok && <Typography.Text type="danger">{action.message}</Typography.Text>}<Typography.Text type="secondary" style={{ fontSize: 12 }}>{ago(action.at)}</Typography.Text></Space>,
          }))} />
        </div>
      )}

      {(dialog === 'lock' || dialog === 'queue') && <LockDialog board={board} queue={dialog === 'queue'} onClose={() => setDialog(null)} />}
      {dialog === 'steal' && <StealDialog board={board} onClose={() => setDialog(null)} />}
      {dialog === 'sdk' && (
        <Modal open title={`用 SDK 启动 ${board.name}`} okText={method === 'download' ? '刷机' : '内存启动'} cancelText="取消" onCancel={() => setDialog(null)}
          onOk={() => { setDialog(null); const hide = message.loading('启动中，进度显示在板子上…', 0); void api.bootSdk(board.name, sdk!, method).then(() => { hide(); message.success('完成') }, error => { hide(); message.error((error as Error).message) }) }}>
          <Flex vertical gap={12}>
            <Typography.Text type="secondary">板子所在的主机去构建服务器取这个 SDK 的产物，按它的启动流程加载或烧录。</Typography.Text>
            <Select value={sdk} onChange={setSdk} options={board.lab?.sdks.map(item => ({ value: item, label: item }))} />
            <Select value={method} onChange={setMethod} options={[{ value: 'load', label: '内存启动（不写板子）' }, { value: 'download', label: '刷机（烧录到板上存储）' }]} />
          </Flex>
        </Modal>
      )}
    </Drawer>
  )
}
