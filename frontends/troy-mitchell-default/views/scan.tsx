/** The scan tab: each module's way to scan, labs that find boards themselves, and the proposals waiting. */
import type { ViewProps } from '../extensions.ts'
import { ViewPanel, viewsFor } from '../render.tsx'
import { LabScan } from './labs.tsx'
import { ProposalList } from './proposals.tsx'

export function ScanTab(props: ViewProps) {
  const { state } = props
  const results = viewsFor(state, 'scan-result')
  return (
    <div className="columns">
      <div className="stack">
        {viewsFor(state, 'scan').map(view => <ViewPanel key={view.id} view={view} onRun={props.onRun} onPrompt={props.onPrompt} />)}
        {state.labs.filter(lab => lab.enabled && lab.canDiscover).map(lab => <LabScan key={lab.id} lab={lab} state={state} onPrompt={props.onPrompt} />)}
        <ProposalList proposals={state.proposals} onRun={props.onRun} />
      </div>
      {results.length > 0 && <div className="stack">{results.map(view => <ViewPanel key={view.id} view={view} onRun={props.onRun} onPrompt={props.onPrompt} />)}</div>}
    </div>
  )
}

/** Whether there is anything to scan or review: a module that scans, a lab that finds boards, or proposals waiting. */
export function canScan(props: Pick<ViewProps, 'state'>): boolean {
  const { state } = props
  return viewsFor(state, 'scan').length > 0 || state.labs.some(lab => lab.enabled && lab.canDiscover) || state.proposals.length > 0
}
