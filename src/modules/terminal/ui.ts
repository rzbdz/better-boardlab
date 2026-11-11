/**
 * The terminal module's part of the page: a page of its own, a list of terminals beside the open one. Frontends that
 * know the `terminal.page` element draw it with src/ui/terminal.tsx; the rest show the fallback.
 */
import { custom, text, type ModuleUi } from '../../ui/contract.ts'

export const ui: ModuleUi = {
  module: 'terminal',
  views: () => [{
    id: 'terminals', slot: 'page', title: '终端',
    body: [custom('terminal.page', { api: 'api/terminals' }, [text('这个页面风格不支持网页终端，换 Modern 风格。')])],
  }],
}
