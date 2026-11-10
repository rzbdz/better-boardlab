/** Choosing this browser's frontend among those boardd serves; the page reloads into the one chosen. */
import { useEffect, useState } from 'react'
import { frontends, type FrontendList } from '../../../src/ui/api.ts'
import { Section } from '../kit.tsx'

export function FrontendPicker() {
  const [list, setList] = useState<FrontendList | null>(null)
  useEffect(() => { void frontends.list().then(setList).catch(() => {}) }, [])
  if (!list || list.frontends.length < 2) return null
  return (
    <Section title="界面">
      <p className="muted">这个 boardlab 带了几套界面，各自是一整个独立的页面。换一个只影响这个浏览器，页面会刷新。</p>
      <div className="toggles">
        {list.frontends.map(item => (
          <label key={item.name} className={item.name === list.current ? 'on' : ''}>
            <input type="radio" name="frontend" checked={item.name === list.current} onChange={() => void frontends.choose(item.name)} />
            <span>{item.title}</span>{item.name === list.default && <small>默认</small>}
          </label>
        ))}
      </div>
    </Section>
  )
}
