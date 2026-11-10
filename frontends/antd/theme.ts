/**
 * The look: a quiet console in the manner of Apple, Google Cloud and AWS. Neutral surfaces, one accent, generous
 * spacing, hairline borders, light and dark following the system (or chosen in settings).
 */
import { theme, type ThemeConfig } from 'antd'
import { useEffect, useState } from 'react'

export type Mode = 'system' | 'light' | 'dark'
const KEY = 'boardlab.antd.mode'

export const ACCENT = '#0a66ff'

export function useMode(): [Mode, boolean, (mode: Mode) => void] {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem(KEY) as Mode | null) ?? 'system')
  const [systemDark, setSystemDark] = useState(query.matches)
  useEffect(() => {
    const on = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    query.addEventListener('change', on)
    return () => query.removeEventListener('change', on)
  }, [])
  const dark = mode === 'dark' || (mode === 'system' && systemDark)
  useEffect(() => { document.documentElement.style.colorScheme = dark ? 'dark' : 'light'; document.body.style.background = dark ? '#0e1014' : '#f5f6f8' }, [dark])
  return [mode, dark, next => { localStorage.setItem(KEY, next); setMode(next) }]
}

export function themeFor(dark: boolean): ThemeConfig {
  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: ACCENT,
      colorInfo: ACCENT,
      colorSuccess: '#16a34a',
      colorWarning: '#d97706',
      colorError: '#dc2626',
      borderRadius: 10,
      borderRadiusLG: 14,
      fontSize: 14,
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "WenQuanYi Zen Hei", sans-serif',
      colorBgLayout: dark ? '#0e1014' : '#f5f6f8',
      colorBgContainer: dark ? '#16191f' : '#ffffff',
      colorBorderSecondary: dark ? '#23272f' : '#eceef2',
      colorBorder: dark ? '#2c313b' : '#dfe2e8',
      colorTextSecondary: dark ? '#a1a8b5' : '#5f6672',
      boxShadowTertiary: dark ? '0 1px 2px rgba(0,0,0,.4)' : '0 1px 2px rgba(16,24,40,.04), 0 1px 3px rgba(16,24,40,.06)',
      controlHeight: 34,
      wireframe: false,
    },
    components: {
      Layout: { headerBg: dark ? 'rgba(14,16,20,.82)' : 'rgba(255,255,255,.82)', headerHeight: 60, headerPadding: '0 28px', siderBg: dark ? '#0e1014' : '#fbfbfc', bodyBg: dark ? '#0e1014' : '#f5f6f8' },
      Menu: { itemBg: 'transparent', itemBorderRadius: 8, itemHeight: 38, itemSelectedBg: dark ? 'rgba(10,102,255,.18)' : 'rgba(10,102,255,.08)', itemSelectedColor: ACCENT, iconSize: 16, activeBarBorderWidth: 0 },
      Card: { paddingLG: 22, headerFontSize: 15, headerHeight: 52 },
      Button: { fontWeight: 500, primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none' },
      Tag: { defaultBg: dark ? '#1d2129' : '#f2f3f5' },
      Table: { headerBg: 'transparent', headerColor: dark ? '#a1a8b5' : '#5f6672', rowHoverBg: dark ? '#1b1f26' : '#f8f9fb' },
      Segmented: { itemSelectedBg: dark ? '#262b35' : '#ffffff', trackBg: dark ? '#16191f' : '#eef0f3' },
      Drawer: { paddingLG: 20 },
      Modal: { titleFontSize: 17 },
    },
  }
}
