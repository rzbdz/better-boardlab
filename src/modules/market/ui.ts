/**
 * The market module's part of the page: the module markets this boardlab reads modules from, what each offers, and one
 * button to pull their newest versions. Adding or removing a market is a git URL and a delete — the CLI's job
 * (`boardlab market add <名称> <git 地址>`), which needs no boardd and is where the URL is easy to paste.
 *
 * What a market offers is its manifest, never code that has run: id, title, tags, and what a module needs and offers.
 * The page says which of them boardd has loaded, so a person can tell "in the shop" from "installed".
 */
import { call } from '../../ui/api.ts'
import { action, notice, text, type ModuleUi, type PageState, type View } from '../../ui/contract.ts'

interface Offered { id: string, title: string, about: string, tags: string[], inject: string[], provide: string[], version: string | null }
interface Market { id: string, url: string, branch: string | null, commit: string | null, modules: Offered[], problems: string[] }
interface Markets { markets: Market[], problems: string[] }

let known: Markets | null = null
const load = async () => { known = await call<Markets>('GET', 'api/market'); return known }
void load().catch(() => {})

const edges = (module: Offered) => [module.inject.length ? `要 ${module.inject.join('、')}` : '', module.provide.length ? `给 ${module.provide.join('、')}` : '', module.version ? module.version : ''].filter(Boolean).join(' · ')

export const ui: ModuleUi = {
  module: 'market',
  views(state: PageState): View[] {
    const data = known
    const loaded = new Set(state.modules.map(module => module.id))
    const installed = [...loaded].filter(id => data?.markets.some(market => market.modules.some(module => module.id === id)))
    return [{
      id: 'market', slot: 'settings', title: '模块市场', order: 90, help: 'modules',
      status: data ? { tone: data.problems.length ? 'warn' : 'ok', text: data.markets.length ? `${data.markets.length} 个市场` : '没有市场' } : undefined,
      body: [
        text('模块市场是 git 仓库，里面每个目录是一个模块包。装着哪个模块由 boardd 的配置决定（modules），市场本身只是货架：装了市场不等于装了它里面的模块。'),
        text(['加一个市场用命令行：', { code: 'boardlab market add <名称> <git 地址>' }, '；删掉它用', { code: 'boardlab market remove <名称>' }, '。']),
        ...(data ? [] : [text('读取中…')]),
        ...(data?.problems ?? []).map(problem => notice(problem)),
        ...(data?.markets ?? []).map(market => ({
          kind: 'group' as const,
          title: `${market.id}  ${market.commit ? market.commit.slice(0, 12) : '还没拉取'}`,
          body: [
            text([{ code: market.url }, market.branch ? `（${market.branch}）` : '']),
            ...market.problems.map(problem => notice(problem)),
            {
              kind: 'list' as const, empty: '这个市场没有提供模块',
              items: market.modules.map(module => ({
                key: module.id,
                title: module.title,
                description: [module.id, module.about, edges(module)].filter(Boolean).join('  ·  '),
                tag: loaded.has(module.id) ? '装了' : '市场里',
                status: loaded.has(module.id) ? { tone: 'ok' as const, text: '装了' } : { tone: 'neutral' as const, text: '没装' },
              })),
            },
          ],
        })),
        ...(data?.markets.length ? [{
          kind: 'actions' as const, actions: [
            action('update', '拉取新版本', async () => (await call<{ message: string }>('POST', 'api/market/update', {})).message, { intent: 'primary' }),
          ],
        }] : []),
        ...(installed.length ? [text(`从市场装的模块（boardd 已加载）：${installed.join('、')}`)] : []),
        ...(data?.markets.length ? [text([{ muted: '拉取只是把仓库更新到最新提交；重启 boardd 后新的代码才生效。' }])] : []),
      ],
    }]
  },
}
