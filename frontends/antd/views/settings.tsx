/**
 * Settings: the look (frontend, light or dark), each lab's access, the modules' settings sections, and the firmware
 * boardd ships.
 */
import { ApiOutlined, BgColorsOutlined, CheckCircleFilled, CloseCircleFilled } from '@ant-design/icons'
import { App, Button, Card, Col, Flex, Form, Input, Radio, Row, Segmented, Space, Switch, Table, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { api, frontends, type FrontendList, type PageState } from '../../../src/ui/api.ts'
import type { LabSettings } from 'boardlab-core/shared/types.ts'
import { ago } from '../../../src/ui/format.ts'
import { ViewCard, viewsFor } from '../render.tsx'
import type { Mode } from '../theme.ts'
import { NotifyCard } from './notify.tsx'

function Appearance({ mode, onMode }: { mode: Mode, onMode: (mode: Mode) => void }) {
  const [list, setList] = useState<FrontendList | null>(null)
  useEffect(() => { void frontends.list().then(setList).catch(() => {}) }, [])
  return (
    <Card variant="borderless" style={{ boxShadow: 'var(--bl-card-shadow)' }} title={<Space><BgColorsOutlined />外观</Space>}>
      <Flex vertical gap={20}>
        <div>
          <Typography.Text strong>主题</Typography.Text>
          <div style={{ marginTop: 8 }}><Segmented<Mode> value={mode} onChange={onMode} options={[{ label: '跟随系统', value: 'system' }, { label: '浅色', value: 'light' }, { label: '深色', value: 'dark' }]} /></div>
        </div>
        {list && list.frontends.length > 1 && (
          <div>
            <Typography.Text strong>界面</Typography.Text>
            <Typography.Paragraph type="secondary" style={{ margin: '4px 0 10px' }}>每套界面都是一整个独立的页面。换一个只影响这个浏览器，页面会刷新。</Typography.Paragraph>
            <Radio.Group value={list.current} onChange={event => void frontends.choose(event.target.value)}>
              <Space direction="vertical">
                {list.frontends.map(item => <Radio key={item.name} value={item.name}>{item.title}{item.name === list.default && <Tag bordered={false} style={{ marginLeft: 8 }}>默认</Tag>}</Radio>)}
              </Space>
            </Radio.Group>
          </div>
        )}
      </Flex>
    </Card>
  )
}

function LabCard({ lab }: { lab: LabSettings }) {
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const fields = lab.fields
  const save = async (values: Record<string, string | boolean>) => {
    setSaving(true)
    try {
      const next = await api.configureLab({ id: lab.id, enabled: !!values.enabled, url: String(values.url ?? ''), username: String(values.username ?? ''), password: String(values.password ?? '') || undefined, jump: String(values.jump ?? ''), devices: String(values.devices ?? '') })
      form.setFieldValue('password', '')
      next.verifyOk === false ? message.error(next.verifyMessage ?? '验证失败') : message.success('已保存')
    } catch (error) { message.error((error as Error).message) } finally { setSaving(false) }
  }
  return (
    <Card variant="borderless" style={{ boxShadow: 'var(--bl-card-shadow)' }} title={<Space><ApiOutlined />实验室 {lab.id}</Space>}
      extra={lab.verifiedAt ? <Tag bordered={false} color={lab.verifyOk ? 'success' : 'error'} icon={lab.verifyOk ? <CheckCircleFilled /> : <CloseCircleFilled />}>{lab.verifyOk ? '连接正常' : '连接失败'} · {ago(lab.verifiedAt)}</Tag> : null}>
      <Typography.Paragraph type="secondary">{lab.about || lab.kind}</Typography.Paragraph>
      <Form form={form} layout="vertical" requiredMark={false} onFinish={save} style={{ maxWidth: 720 }}
        initialValues={{ enabled: lab.enabled, url: lab.url ?? '', username: lab.username ?? '', password: '', jump: lab.jump ?? '', devices: lab.devices ?? '' }}>
        <Form.Item name="enabled" label="使用这个实验室" valuePropName="checked"><Switch /></Form.Item>
        <Row gutter={16}>
          {fields.url && <Col xs={24} md={12}><Form.Item name="url" label={fields.url.label}><Input placeholder={fields.url.placeholder ?? undefined} /></Form.Item></Col>}
          {fields.username && <Col xs={24} md={12}><Form.Item name="username" label={fields.username.label}><Input placeholder={fields.username.placeholder ?? undefined} /></Form.Item></Col>}
          {fields.password && <Col xs={24} md={12}><Form.Item name="password" label={fields.password.label}><Input.Password autoComplete="new-password" placeholder={lab.hasPassword ? '已保存（留空则不修改）' : fields.password.placeholder ?? undefined} /></Form.Item></Col>}
          {fields.jump && <Col xs={24} md={12}><Form.Item name="jump" label={fields.jump.label}><Input placeholder={lab.defaultJump ?? fields.jump.placeholder ?? undefined} /></Form.Item></Col>}
          <Col xs={24}><Form.Item name="devices" label="只用这些板子" extra="设备名或带 * 的模式，空格分开；留空列出全部"><Input placeholder="例如 sub0-* sub1-*" /></Form.Item></Col>
        </Row>
        <Space>
          <Button type="primary" htmlType="submit" loading={saving}>保存并验证</Button>
          <Button onClick={() => void api.testLab(lab.id).then(next => next.verifyOk ? message.success(next.verifyMessage ?? '连接正常') : message.error(next.verifyMessage ?? '连接失败'), error => message.error((error as Error).message))}>重新验证</Button>
          {lab.verifyMessage && <Typography.Text type="secondary">{lab.verifyMessage}</Typography.Text>}
        </Space>
      </Form>
    </Card>
  )
}

export function SettingsPage({ state, mode, onMode, onJobStarted }: { state: PageState, mode: Mode, onMode: (mode: Mode) => void, onJobStarted: () => void }) {
  return (
    <Flex vertical gap={20} style={{ maxWidth: 1080 }}>
      <Appearance mode={mode} onMode={onMode} />
      <NotifyCard />
      {viewsFor(state, 'settings').map(view => <ViewCard key={view.id} view={view} onJobStarted={onJobStarted} />)}
      {state.labs.map(lab => <LabCard key={lab.id} lab={lab} />)}
      <Card variant="borderless" style={{ boxShadow: 'var(--bl-card-shadow)' }} title="自带固件">
        <Table size="small" pagination={false} rowKey={item => `${item.soc}/${item.purpose}`} dataSource={state.firmware} locale={{ emptyText: '这个 boardlab 没有自带固件' }}
          columns={[
            { title: 'SoC', dataIndex: 'soc', render: value => <Tag bordered={false}>{String(value).toUpperCase()}</Tag>, width: 90 },
            { title: '名字', dataIndex: 'purpose' },
            { title: 'sha256', dataIndex: 'sha256', render: value => <Typography.Text type="secondary" className="bl-mono" style={{ fontSize: 12 }}>{String(value).slice(0, 16)}…</Typography.Text> },
            { title: '说明', dataIndex: 'note', render: value => value ?? '—' },
          ]} />
      </Card>
    </Flex>
  )
}
