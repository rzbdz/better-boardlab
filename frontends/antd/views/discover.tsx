/**
 * Finding boards: each lab that can (discover on free slots; rebuild a re-cabled host; a person resetting boards), the
 * modules' ways to scan and what they found, and the proposals waiting for a person.
 */
import { ClusterOutlined, RadarChartOutlined, SyncOutlined, UserOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Col, Empty, Flex, Input, List, Row, Select, Space, Tag, Typography } from 'antd'
import { useState } from 'react'
import { api, type PageState } from '../../../src/ui/api.ts'
import type { LabSettings, Proposal } from 'boardlab-core/shared/types.ts'
import { ago } from '../format.ts'
import { ViewCard, viewsFor } from '../render.tsx'

const KIND: Record<Proposal['kind'], string> = { 'new-board': '新板', 'replace-board': '换板', 'serial-moved': '串口', 'download-moved': '下载口', 'product-changed': '型号', 'slot-empty': '空槽位' }

function LabCard({ lab, state }: { lab: LabSettings, state: PageState }) {
  const { message, modal } = App.useApp()
  const [host, setHost] = useState<string | undefined>(lab.hosts[0])
  const running = !!lab.discovery?.running
  const held = state.boards.filter(board => board.lab?.id === lab.id && (board.lease || board.lab.heldBy))
  const onHost = state.boards.filter(board => board.lab?.id === lab.id && board.slotRef?.startsWith(`${lab.id}/${host}/`))
  const heldOnHost = onHost.filter(board => board.lease || board.lab?.heldBy)
  const fire = (promise: Promise<unknown>) => { void promise.catch(error => message.error((error as Error).message)) }
  return (
    <Card variant="borderless" style={{ boxShadow: 'var(--bl-card-shadow)' }}
      title={<Space><ClusterOutlined />实验室 {lab.id}</Space>} extra={running ? <Tag color="processing" bordered={false} icon={<SyncOutlined spin />}>进行中</Tag> : null}>
      <Flex vertical gap={16}>
        <Typography.Text type="secondary">{lab.kind}。找到的板子马上登记；没能自动登记的列为下方的改动建议。</Typography.Text>
        {lab.discovery && <Alert type={running ? 'info' : 'success'} showIcon={false} message={<Space size={8}><Typography.Text type="secondary">{running ? '进行中' : '上次'}</Typography.Text><span>{lab.discovery.line}</span><Typography.Text type="secondary">{ago(lab.discovery.at)}</Typography.Text></Space>} />}
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={8}>
            <Card size="small" type="inner" title={<Space><RadarChartOutlined />发现新板子</Space>} style={{ height: '100%' }}>
              <Typography.Paragraph type="secondary" style={{ minHeight: 66 }}>逐个拉还没用过的复位线，看哪个串口有反应、哪个下载口出现。会复位接在这些线上的板子。</Typography.Paragraph>
              <Button type="primary" block disabled={running || held.length > 0} title={held.length ? '有板子正被使用' : undefined}
                onClick={() => modal.confirm({ title: `在实验室 ${lab.id} 发现板子`, content: '逐个拉还没用过的复位线、看串口和 USB，会复位接在这些线上的板子。', okText: '开始发现', okButtonProps: { danger: true }, onOk: () => fire(api.discoverLab(lab.id)) })}>开始发现</Button>
            </Card>
          </Col>
          {lab.canRebuild && (
            <Col xs={24} lg={8}>
              <Card size="small" type="inner" title={<Space><SyncOutlined />重新布线以后：重建主机</Space>} style={{ height: '100%' }}>
                <Typography.Paragraph type="secondary" style={{ minHeight: 66 }}>忘掉这台主机发现过的板子和槽位，按现在的接线重新发现。以前用过的复位线先试，找到的板子沿用原名。</Typography.Paragraph>
                <Space.Compact block>
                  <Select value={host} onChange={setHost} options={lab.hosts.map(item => ({ value: item, label: item }))} style={{ flex: 1 }} placeholder="主机" />
                  <Button danger disabled={running || !host || heldOnHost.length > 0} title={heldOnHost.length ? `${heldOnHost.map(board => board.name).join('、')} 正被使用` : undefined}
                    onClick={() => modal.confirm({
                      title: `重建 ${host}`, okText: '重建', okButtonProps: { danger: true },
                      content: `会忘掉 ${host} 上的 ${onHost.filter(board => !board.lab?.empty).map(board => board.name).join('、') || '（没有登记的板子）'} 和它的所有槽位，按现在的接线重新发现，会复位接在复位线上的所有板子。`,
                      onOk: () => fire(api.rebuildLab(lab.id, host!)),
                    })}>重建</Button>
                </Space.Compact>
              </Card>
            </Col>
          )}
          <Col xs={24} lg={8}>
            <Card size="small" type="inner" title={<Space><UserOutlined />人工复位的板子</Space>} style={{ height: '100%' }}>
              <Typography.Paragraph type="secondary" style={{ minHeight: 66 }}>没接复位线的板子：开始后按提示一次让一块进下载模式，实验室把串口和下载口配成一对。</Typography.Paragraph>
              <Space.Compact block>
                <Select value={host} onChange={setHost} options={lab.hosts.map(item => ({ value: item, label: item }))} style={{ flex: 1 }} placeholder="主机" />
                <Button disabled={running || !host || held.length > 0}
                  onClick={() => modal.confirm({ title: `在 ${host} 上人工发现板子`, content: '按页面上的提示，一次只让一块还没登记的板子进下载模式（按 RESET，需要时同时按住 BOOT）。', okText: '开始', onOk: () => fire(api.discoverLab(lab.id, { human: true, host })) })}>开始</Button>
              </Space.Compact>
            </Card>
          </Col>
        </Row>
      </Flex>
    </Card>
  )
}

function Proposals({ proposals }: { proposals: Proposal[] }) {
  const { message } = App.useApp()
  const [names, setNames] = useState<Record<string, string>>({})
  if (!proposals.length) return null
  const decide = (ids: string[], decision: 'apply' | 'reject') => void api.proposals(ids, decision, decision === 'apply' ? names : undefined).then(() => message.success(decision === 'apply' ? '已应用' : '已拒绝'), error => message.error((error as Error).message))
  return (
    <Card variant="borderless" style={{ boxShadow: 'var(--bl-card-shadow)' }} title={`改动建议 · ${proposals.length}`}
      extra={<Space><Button onClick={() => decide(proposals.map(item => item.id), 'reject')}>全部拒绝</Button><Button type="primary" onClick={() => decide(proposals.map(item => item.id), 'apply')}>全部应用</Button></Space>}>
      <List dataSource={proposals} renderItem={item => (
        <List.Item actions={[<Button key="r" size="small" onClick={() => decide([item.id], 'reject')}>拒绝</Button>, <Button key="a" size="small" type="primary" onClick={() => decide([item.id], 'apply')}>应用</Button>]}>
          <List.Item.Meta avatar={<Tag bordered={false} color="blue">{KIND[item.kind]}</Tag>} title={item.summary}
            description={(item.kind === 'new-board' || item.change.lab) ? <Input size="small" style={{ maxWidth: 260 }} placeholder={item.change.name ? String(item.change.name) : '板名'} value={names[item.id] ?? ''} onChange={event => setNames({ ...names, [item.id]: event.target.value })} /> : undefined} />
        </List.Item>
      )} />
    </Card>
  )
}

export function DiscoverPage({ state, onJobStarted }: { state: PageState, onJobStarted: () => void }) {
  const labs = state.labs.filter(lab => lab.enabled && lab.canDiscover)
  const scans = viewsFor(state, 'scan'), results = viewsFor(state, 'scan-result')
  if (!labs.length && !scans.length && !state.proposals.length) return <Empty description="没有能发现板子的实验室或模块" />
  return (
    <Flex vertical gap={20}>
      <Proposals proposals={state.proposals} />
      {labs.map(lab => <LabCard key={lab.id} lab={lab} state={state} />)}
      {(scans.length > 0 || results.length > 0) && (
        <Row gutter={[20, 20]}>
          <Col xs={24} xl={12}><Flex vertical gap={20}>{scans.map(view => <ViewCard key={view.id} view={view} onJobStarted={onJobStarted} />)}</Flex></Col>
          <Col xs={24} xl={12}><Flex vertical gap={20}>{results.map(view => <ViewCard key={view.id} view={view} onJobStarted={onJobStarted} />)}</Flex></Col>
        </Row>
      )}
    </Flex>
  )
}

export const canDiscover = (state: PageState) => state.labs.some(lab => lab.enabled && lab.canDiscover) || viewsFor(state, 'scan').length > 0 || state.proposals.length > 0
