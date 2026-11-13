/**
 * The Ant Design frontend: a console in the manner of Apple, Google Cloud and AWS. A left navigation, a frosted top bar,
 * pages of quiet cards, and a drawer for each board with its live console. Module views (src/ui/contract.ts) render
 * through render.tsx; boardd's events keep everything current.
 */
import { ApiOutlined, AppstoreOutlined, BellOutlined, HistoryOutlined, RadarChartOutlined, SettingOutlined, UnorderedListOutlined } from '@ant-design/icons'
import { App as AntApp, Avatar, Badge, Button, ConfigProvider, Flex, Input, Layout, Menu, Modal, Result, Space, Spin, Tooltip, Typography } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api, identity, type PageState } from '../../src/ui/api.ts'
import type { ModuleUi } from '../../src/ui/contract.ts'
import { changes, prefs, show as notifySystem } from '../../src/ui/notify.ts'
import { who } from '../../src/ui/format.ts'
import { JobDrawer, registerModuleUis, useJobs, ViewCard, viewsFor } from './render.tsx'
import { themeFor, useMode } from './theme.ts'
import { ApiPage } from './views/api.tsx'
import { BoardsPage } from './views/boards.tsx'
import { canDiscover, DiscoverPage } from './views/discover.tsx'
import { HistoryPage } from './views/history.tsx'
import { SettingsPage } from './views/settings.tsx'

/** A fixed page, or `p/<id>` for a module's own page (the module views boardd loads). */
type Page = string
const PAGES: Record<string, string> = { boards: '板子', discover: '发现', history: '历史', api: 'API', settings: '设置' }

function Shell() {
  const { message, notification } = AntApp.useApp()
  const [state, setState] = useState<PageState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(true)
  const [page, setPage] = useState<Page>(() => {
    const hash = location.hash.replace(/^#/, '')
    return Object.keys(PAGES).includes(hash) || hash.startsWith('p/') ? hash : 'boards'
  })
  const [board, setBoard] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [jobsOpen, setJobsOpen] = useState(false)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState(identity.get())
  const [mode, dark, setMode] = useMode()
  const jobs = useJobs()
  const you = useRef('')

  const last = useRef<PageState | null>(null)
  const refresh = useCallback(async () => {
    try {
      const next = await api.state(); you.current = next.you
      // Tell the person what changed for them: the system's notification centre when allowed, else here.
      if (last.current) for (const note of changes(last.current.boards, next.boards, next.you, prefs.get().watched)) {
        if (!notifySystem(note, () => { setPage('boards'); setBoard(note.board) }) && prefs.get().enabled[note.topic]) {
          const open = { message: note.title, description: note.body, placement: 'bottomRight' as const, onClick: () => { setPage('boards'); setBoard(note.board) } }
          if (note.topic === 'attention') notification.warning({ ...open, key: `attention-${note.board}`, duration: 0 })
          else if (note.topic === 'stolen') notification.warning(open)
          else notification.success(open)
        }
      }
      last.current = next
      setState(next); setConnected(true); setError(null)
    }
    catch (failure) { setConnected(false); setError((failure as Error).message) }
    setRefreshKey(key => key + 1)
  }, [])

  useEffect(() => {
    void refresh()
    const source = new EventSource('api/events')
    let timer: number | undefined
    const soon = () => { window.clearTimeout(timer); timer = window.setTimeout(refresh, 150) }
    for (const name of ['changed', 'scan']) source.addEventListener(name, soon)
    source.addEventListener('lab-ports', event => {
      const data = JSON.parse((event as MessageEvent).data) as { lab: string, host?: string, added?: string[], removed?: string[] }
      if (data.host && data.added?.length) notification.info({ message: `${data.host} 接上了新线`, description: data.added.join('、'), placement: 'bottomRight' })
    })
    // Locks and requests for a person arrive as state changes; refresh() works out what to tell (notify.ts).
    for (const name of ['lease-stolen', 'lease-granted']) source.addEventListener(name, soon)
    source.addEventListener('attention', event => {
      const data = JSON.parse((event as MessageEvent).data) as { board: string, message: string | null }
      if (!data.message) notification.destroy(`attention-${data.board}`)
      soon()
    })
    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)
    const tick = window.setInterval(refresh, 30_000)
    return () => { source.close(); window.clearInterval(tick) }
  }, [refresh])

  useEffect(() => { history.replaceState(null, '', `#${page}`) }, [page])
  const running = jobs.filter(job => job.state === 'running').length
  const waiting = state?.boards.filter(item => item.lab?.attention).length ?? 0
  const modulePages = state ? viewsFor(state, 'page') : []
  const items = [
    { key: 'boards', icon: <AppstoreOutlined />, label: PAGES.boards },
    ...(!state || canDiscover(state) ? [{ key: 'discover', icon: <RadarChartOutlined />, label: <Space>{PAGES.discover}{state?.proposals.length ? <Badge count={state.proposals.length} size="small" /> : null}</Space> }] : []),
    { key: 'history', icon: <HistoryOutlined />, label: PAGES.history },
    { key: 'api', icon: <ApiOutlined />, label: PAGES.api },
    ...modulePages.map(view => ({ key: `p/${view.id}`, icon: <AppstoreOutlined />, label: view.title ?? view.id })),
    { key: 'settings', icon: <SettingOutlined />, label: PAGES.settings },
  ]
  const onJobStarted = () => setJobsOpen(true)

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider width={208} breakpoint="lg" collapsedWidth={56} theme={dark ? 'dark' : 'light'} style={{ borderRight: '1px solid var(--bl-line)', position: 'sticky', top: 0, height: '100vh' }}>
        <div className="bl-brand"><i />boardlab</div>
        <Menu mode="inline" selectedKeys={[page]} onClick={event => setPage(event.key as Page)} items={items} style={{ border: 'none', paddingTop: 8 }} />
      </Layout.Sider>
      <Layout>
        <header className="bl-page-head">
          <h1>{PAGES[page] ?? modulePages.find(view => `p/${view.id}` === page)?.title ?? 'Boardlab'}</h1>
          <Space size={14}>
            {!connected && <Typography.Text type="warning" style={{ fontSize: 12 }}>与 boardd 的连接中断，重试中…</Typography.Text>}
            {waiting > 0 && <Tooltip title="有板子在等人操作"><Badge count={waiting} size="small"><BellOutlined style={{ fontSize: 16 }} /></Badge></Tooltip>}
            <Tooltip title="任务"><Badge count={running} size="small"><Button size="small" type="text" icon={<UnorderedListOutlined />} onClick={() => setJobsOpen(true)} /></Badge></Tooltip>
            <Tooltip title="我是谁（锁和排队按名字区分）">
              <Space size={8} style={{ cursor: 'pointer' }} onClick={() => setNaming(true)} data-testid="identity">
                <Avatar size={24} style={{ background: 'var(--bl-accent)', fontSize: 12, fontWeight: 600 }}>{(state ? who(state.you) : '?').slice(0, 1).toUpperCase()}</Avatar>
                <Typography.Text style={{ fontSize: 13 }}>{state ? who(state.you) : ''}</Typography.Text>
              </Space>
            </Tooltip>
          </Space>
        </header>
        <Layout.Content className={page === 'boards' ? 'bl-content bl-wide' : 'bl-content bl-narrow'}>
          {!state ? (error ? <Result status="warning" title="连不上 boardd" subTitle={error} extra={<Button onClick={() => void refresh()}>重试</Button>} /> : <Flex justify="center" style={{ padding: 120 }}><Spin /></Flex>)
            : page === 'boards' ? <BoardsPage state={state} dark={dark} selected={board} onSelect={setBoard} />
            : page === 'discover' ? <DiscoverPage state={state} onJobStarted={onJobStarted} />
            : page === 'history' ? <HistoryPage state={state} refreshKey={refreshKey} onJobStarted={onJobStarted} />
            : page === 'api' ? <ApiPage />
            : page.startsWith('p/') && modulePages.some(view => `p/${view.id}` === page)
              ? <ViewCard view={modulePages.find(view => `p/${view.id}` === page)!} onJobStarted={onJobStarted} />
            : <SettingsPage state={state} mode={mode} onMode={setMode} onJobStarted={onJobStarted} />}
        </Layout.Content>
      </Layout>
      <JobDrawer open={jobsOpen} onClose={() => setJobsOpen(false)} />
      <Modal open={naming} title="我是谁" okText="保存" cancelText="取消" onCancel={() => setNaming(false)}
        onOk={() => { if (name && !/^[A-Za-z0-9_.@-]{1,40}$/.test(name)) return message.error('名字只能用字母、数字和 . _ - @'); identity.set(name.trim()); setNaming(false); void refresh() }}>
        <Typography.Paragraph type="secondary">几个人用同一个页面时，各自填自己的名字，排队和锁才分得清。留空则使用 boardd 所在机器的用户。</Typography.Paragraph>
        <Input autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="字母、数字、. _ - @" />
      </Modal>
    </Layout>
  )
}

function Root() {
  const [, dark] = useMode()
  return (
    <ConfigProvider theme={themeFor(dark)} locale={zhCN}>
      <AntApp>
        <Shell />
      </AntApp>
    </ConfigProvider>
  )
}

/** Start the page with the distribution's module UIs. */
export function mountPage(uis: ModuleUi[]) {
  registerModuleUis(uis)
  createRoot(document.getElementById('root')!).render(<Root />)
}
