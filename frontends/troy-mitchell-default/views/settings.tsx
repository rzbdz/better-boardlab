/** The settings tab: each module's settings, the labs, and the firmware boardd ships. */
import type { ViewProps } from '../extensions.ts'
import { ViewPanel, viewsFor } from '../render.tsx'
import { FrontendPicker } from './frontends.tsx'
import { Section } from '../kit.tsx'
import { LabSection } from './labs.tsx'

export function SettingsTab(props: ViewProps) {
  const { state } = props
  return (
    <div className="stack narrow">
      {viewsFor(state, 'settings').map(view => <ViewPanel key={view.id} view={view} onRun={props.onRun} onPrompt={props.onPrompt} />)}

      {state.labs.map(lab => <LabSection key={lab.id} lab={lab} onRun={props.onRun} onPrompt={props.onPrompt} />)}

      <FrontendPicker />

      <Section title="固件">
        <p className="muted">boardd 只加载清单（发行版的 <code>firmware/</code>，或模块带来的）里列出、且 sha256 仍然一致的固件。扫描固定用 minor-board-info，只改内核时 <code>boardlab boot</code> 用 fsbl 和 u-boot-opensbi。</p>
        <ul className="images">
          {state.firmware.map(item => (
            <li key={`${item.soc}/${item.purpose}`}>
              <span className="kind">{item.soc.toUpperCase()}</span>
              <div className="grow"><b>{item.purpose}</b><code className="path">{item.path}</code><small>sha256 {item.sha256.slice(0, 16)}…{item.note ? ` · ${item.note}` : ''}</small></div>
            </li>
          ))}
        </ul>
        {!state.firmware.length && <p className="warn">这个 boardlab 没有可加载的固件。</p>}
      </Section>
    </div>
  )
}
