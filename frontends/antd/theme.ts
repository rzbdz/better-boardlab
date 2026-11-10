/**
 * The look: a sharp, quiet console in the manner of AWS, Google Cloud and Apple's developer tools. Small radii,
 * hairline borders instead of shadows, compact controls, one accent, tabular numbers. Light and dark follow the system
 * unless chosen in settings.
 */
import { theme, type ThemeConfig } from 'antd'
import { useEffect, useState } from 'react'

export type Mode = 'system' | 'light' | 'dark'
const KEY = 'boardlab.antd.mode'
export const ACCENT = '#0b6bff'

/** Surfaces, lines and text, light and dark: the page's CSS variables use the same values. */
export const palette = (dark: boolean) => dark
  ? { bg: '#0b0c0f', panel: '#111317', raised: '#16191e', line: '#24282f', line2: '#2e333b', text: '#e7e9ee', text2: '#9aa1ad', text3: '#6b7280', hover: '#181b21', select: 'rgba(11,107,255,.16)' }
  : { bg: '#f6f7f9', panel: '#ffffff', raised: '#ffffff', line: '#e4e7ec', line2: '#d0d5dd', text: '#101828', text2: '#475467', text3: '#98a2b3', hover: '#f4f6f8', select: 'rgba(11,107,255,.07)' }

export function useMode(): [Mode, boolean, (mode: Mode) => void] {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const [mode, setMode] = useState<Mode>(() => { try { return (localStorage.getItem(KEY) as Mode | null) ?? 'system' } catch { return 'system' } })
  const [systemDark, setSystemDark] = useState(query.matches)
  useEffect(() => {
    const on = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    query.addEventListener?.('change', on)
    return () => query.removeEventListener?.('change', on)
  }, [])
  const dark = mode === 'dark' || (mode === 'system' && systemDark)
  useEffect(() => {
    const p = palette(dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    document.body.style.background = p.bg
  }, [dark])
  return [mode, dark, next => { try { localStorage.setItem(KEY, next) } catch {} setMode(next) }]
}

const FONT = '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "WenQuanYi Zen Hei", sans-serif'

export function themeFor(dark: boolean): ThemeConfig {
  const p = palette(dark)
  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: ACCENT, colorInfo: ACCENT, colorSuccess: '#12b76a', colorWarning: '#f79009', colorError: '#f04438',
      colorBgLayout: p.bg, colorBgContainer: p.panel, colorBgElevated: p.raised,
      colorBorder: p.line2, colorBorderSecondary: p.line, colorSplit: p.line,
      colorText: p.text, colorTextSecondary: p.text2, colorTextTertiary: p.text3,
      borderRadius: 4, borderRadiusSM: 3, borderRadiusLG: 6, borderRadiusXS: 2,
      fontFamily: FONT, fontSize: 13, fontSizeSM: 12, lineHeight: 1.5,
      controlHeight: 30, controlHeightSM: 24, controlHeightLG: 36,
      boxShadow: dark ? '0 8px 24px rgba(0,0,0,.5)' : '0 8px 24px rgba(16,24,40,.12)',
      boxShadowSecondary: dark ? '0 6px 16px rgba(0,0,0,.45)' : '0 6px 16px rgba(16,24,40,.10)',
      wireframe: false, motionDurationMid: '0.12s', motionDurationSlow: '0.18s',
    },
    components: {
      Layout: { headerBg: p.panel, headerHeight: 48, headerPadding: '0 20px', siderBg: p.panel, bodyBg: p.bg },
      Menu: { itemBg: 'transparent', itemBorderRadius: 4, itemHeight: 32, itemMarginInline: 8, itemSelectedBg: p.select, itemSelectedColor: ACCENT, itemHoverBg: p.hover, iconSize: 15, activeBarBorderWidth: 0, fontSize: 13 },
      Card: { paddingLG: 16, headerFontSize: 13, headerHeight: 44, headerFontSizeSM: 13 },
      Button: { fontWeight: 500, primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none', paddingInline: 12 },
      Table: { headerBg: dark ? '#14161b' : '#f9fafb', headerColor: p.text2, headerSplitColor: 'transparent', rowHoverBg: p.hover, rowSelectedBg: p.select, rowSelectedHoverBg: p.select, cellPaddingBlockSM: 6, cellPaddingInlineSM: 10, cellPaddingBlock: 8, cellPaddingInline: 12, fontSize: 13 },
      Tag: { defaultBg: dark ? '#1a1d23' : '#f2f4f7', borderRadiusSM: 3 },
      Segmented: { itemSelectedBg: p.panel, trackBg: dark ? '#16191e' : '#eef0f3', borderRadius: 4, borderRadiusSM: 3 },
      Tabs: { horizontalItemPadding: '10px 2px', horizontalItemGutter: 22, titleFontSize: 13, cardHeight: 32 },
      Input: { activeShadow: '0 0 0 2px rgba(11,107,255,.15)' },
      Select: { optionSelectedBg: p.select },
      Modal: { titleFontSize: 15, borderRadiusLG: 6 },
      Drawer: { paddingLG: 16 },
      Descriptions: { labelBg: 'transparent', itemPaddingBottom: 6, titleMarginBottom: 8 },
      Statistic: { contentFontSize: 22, titleFontSize: 12 },
      Alert: { borderRadiusLG: 4, withDescriptionPadding: '10px 12px' },
    },
  }
}
