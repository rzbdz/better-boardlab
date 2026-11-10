/** What every view of this frontend gets: the page state and the ways to ask a person and to run something. */
import type { PageState } from '../../src/ui/api.ts'
import type { Prompt, Run } from './kit.tsx'

export interface ViewProps { state: PageState, onPrompt: (prompt: Prompt) => void, onRun: Run }
