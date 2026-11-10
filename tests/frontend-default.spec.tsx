// @vitest-environment jsdom
/** TroyMitchellDefault against the mock boardd: its board cards and tabs, with the modules' views in its style. */
import { fireEvent, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'

const wait = { timeout: 4000 }

beforeAll(async () => {
  document.body.innerHTML = '<div id="root"></div>'
  const { MODULE_UIS } = await import('../src/uis.ts')
  const { mountPage } = await import('../frontends/troy-mitchell-default/main.tsx')
  mountPage(MODULE_UIS)
})

const tab = async (label: string) => fireEvent.click(await screen.findByRole('tab', { name: new RegExp(label) }, wait))

describe('TroyMitchellDefault frontend', () => {
  it('shows a card per board: this machine\'s first, a lab\'s under its tab', async () => {
    expect(await screen.findByText('desk-k1', {}, wait)).toBeTruthy()
    await tab('实验室 bsp')
    expect(await screen.findByText('bsp-k1-musecard', {}, wait)).toBeTruthy()
    expect(screen.getByText('bsp-k3-cm1')).toBeTruthy()
  })

  it('draws the modules\' settings from their views, and offers the other frontend', async () => {
    await tab('设置')
    expect(await screen.findByText('Home Assistant', {}, wait)).toBeTruthy()
    expect(await screen.findByText('自定义槽位', {}, wait)).toBeTruthy()
    expect(await screen.findByText('Ant Design', {}, wait)).toBeTruthy()
  })

  it('draws the local module\'s scan and its result', async () => {
    await tab('扫描')
    expect(await screen.findByText('扫描本机槽位', {}, wait)).toBeTruthy()
    expect(await screen.findByText('最近一次扫描', {}, wait)).toBeTruthy()
  })
})
