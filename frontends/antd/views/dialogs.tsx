/** The dialogs and quick actions on a board: locking and queueing, reset, fastboot, releasing. */
import { App, Flex, Form, Input, Modal, Tag, Typography } from 'antd'
import { useState } from 'react'
import { api } from '../../../src/ui/api.ts'
import type { Board } from 'boardlab-core/shared/types.ts'
import { PURPOSES, who } from '../../../src/ui/format.ts'

/**
 * Board actions that need no form. A reset of a lab board can take tens of seconds; the button spins while this board
 * waits, and the rest of the page stays usable.
 */
export function useBoardActions() {
  const { message, modal } = App.useApp()
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (key: string, label: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    const hide = message.loading(`${label}…`, 0)
    try { await fn(); hide(); message.success(`${label}：完成`) } catch (error) { hide(); message.error((error as Error).message) } finally { setBusy(null) }
  }
  return {
    busy,
    reset: (board: Board) => modal.confirm({ title: `复位 ${board.name}`, content: '板子会立即重启。', okText: '复位', cancelText: '取消', onOk: () => { void run(`${board.name}:reset`, `复位 ${board.name}`, () => api.reset(board.name)) } }),
    fastboot: (board: Board) => modal.confirm({ title: `${board.name} 进入 fastboot`, content: '板子会重启进入 boot ROM 下载模式。', okText: '进入 fastboot', cancelText: '取消', onOk: () => { void run(`${board.name}:fastboot`, `${board.name} 进入 fastboot`, () => api.fastboot(board.name)) } }),
    unlock: (board: Board) => void run(`${board.name}:unlock`, board.waiters[0] ? `放锁并交给 ${who(board.waiters[0].holder)}` : `放锁 ${board.name}`, () => api.unlock(board.name)),
    steal: (board: Board, reason: string) => run(`${board.name}:steal`, `抢锁 ${board.name}`, () => api.steal(board.name, reason)),
  }
}

/** Taking a board's lock, or queueing for it, with a purpose (one click for the usual ones). */
export function LockDialog({ board, queue, onClose }: { board: Board, queue: boolean, onClose: () => void }) {
  const { message } = App.useApp()
  const [purpose, setPurpose] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!purpose.trim()) return
    setBusy(true)
    try {
      if (queue) { await api.queue(board.name, purpose.trim()); message.success(`已排队 ${board.name}`) }
      else { await api.lock(board.name, purpose.trim()); message.success(`已拿到 ${board.name} 的锁`) }
      onClose()
    } catch (error) { message.error((error as Error).message) } finally { setBusy(false) }
  }
  return (
    <Modal open title={queue ? `排队 ${board.name}` : `拿 ${board.name} 的锁`} okText={queue ? '排队' : '拿锁'} cancelText="取消"
      onOk={submit} onCancel={onClose} confirmLoading={busy} okButtonProps={{ disabled: !purpose.trim() }} destroyOnClose>
      <Flex vertical gap={14}>
        <Typography.Text type="secondary">
          {queue && board.lease ? <>现在由 <b>{who(board.lease.holder)}</b> 使用（{board.lease.purpose}）{board.waiters.length ? `，前面还有 ${board.waiters.length} 人` : ''}。轮到你时会自动把锁交给你。</>
            : '锁没有时间限制，用完请放锁；有人排队时会自动交给排在第一位的人。'}
        </Typography.Text>
        <Form layout="vertical" onFinish={submit}>
          <Form.Item label="用途" style={{ marginBottom: 10 }}>
            <Input autoFocus value={purpose} onChange={event => setPurpose(event.target.value)} placeholder="例如：调试 U-Boot 网络" onPressEnter={submit} />
          </Form.Item>
          <Flex wrap gap={8}>
            {PURPOSES.map(item => <Tag.CheckableTag key={item} checked={purpose === item} onChange={() => setPurpose(item)} style={{ padding: '3px 12px', borderRadius: 999, border: '1px solid var(--ant-color-border)' }}>{item}</Tag.CheckableTag>)}
          </Flex>
        </Form>
      </Flex>
    </Modal>
  )
}

/** Taking a lock someone else holds: needs a reason, which the holder is told. */
export function StealDialog({ board, onClose }: { board: Board, onClose: () => void }) {
  const actions = useBoardActions()
  const [reason, setReason] = useState('')
  return (
    <Modal open title={`抢 ${board.name} 的锁`} okText="抢锁" okButtonProps={{ danger: true, disabled: !reason.trim() }} cancelText="取消"
      onOk={async () => { await actions.steal(board, reason.trim()); onClose() }} onCancel={onClose} destroyOnClose>
      <Typography.Paragraph type="secondary">当前由 <b>{who(board.lease?.holder ?? '')}</b> 使用（{board.lease?.purpose}）。抢锁会记录下来，原使用者会收到通知；排队顺序不变。</Typography.Paragraph>
      <Input autoFocus value={reason} onChange={event => setReason(event.target.value)} placeholder="写明为什么要抢" />
    </Modal>
  )
}
