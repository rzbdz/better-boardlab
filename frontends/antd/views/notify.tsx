/** Notifications: switching on the operating system's notifications, which ones, and watching a board. */
import { BellOutlined, EyeOutlined, EyeInvisibleOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Checkbox, Flex, Space, Tooltip, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { ask, onPrefs, permission, prefs, support, TOPICS, type Topic } from '../../../src/ui/notify.ts'

function usePrefs() {
  const [value, setValue] = useState(prefs.get())
  useEffect(() => onPrefs(setValue), [])
  return value
}

export function NotifyCard() {
  const p = usePrefs()
  const [granted, setGranted] = useState(permission())
  const can = support()
  return (
    <Card variant="borderless" style={{ boxShadow: 'var(--bl-card-shadow)' }} title={<Space><BellOutlined />通知</Space>}>
      <Flex vertical gap={14}>
        <Typography.Text type="secondary">打开后，这些事会出现在操作系统的通知中心（页面在后台也能收到）；没打开时只在页面右下角提示。</Typography.Text>
        {!can.ok ? <Alert type="warning" showIcon message="这个页面不能发系统通知" description={can.why} />
          : granted === 'granted' ? <Alert type="success" showIcon message="已开启系统通知" />
          : <Space><Button type="primary" onClick={async () => setGranted(await ask())}>开启系统通知</Button><Typography.Text type="secondary">浏览器会问你是否允许</Typography.Text></Space>}
        <Flex vertical gap={8}>
          {(Object.keys(TOPICS) as Topic[]).map(topic => <Checkbox key={topic} checked={p.enabled[topic]} onChange={event => prefs.topic(topic, event.target.checked)}>{TOPICS[topic]}</Checkbox>)}
        </Flex>
        <Typography.Text type="secondary">关注的板子：{p.watched.length ? p.watched.join('、') : '还没有。在板子详情里点「关注」，它空闲时会通知你。'}</Typography.Text>
      </Flex>
    </Card>
  )
}

/** Watch a board: be told when it becomes free. */
export function WatchButton({ board }: { board: string }) {
  const p = usePrefs()
  const on = p.watched.includes(board)
  return (
    <Tooltip title={on ? '不再关注' : '空闲时通知我'}>
      <Button icon={on ? <EyeInvisibleOutlined /> : <EyeOutlined />} onClick={() => prefs.watch(board, !on)}>{on ? '取消关注' : '关注'}</Button>
    </Tooltip>
  )
}
