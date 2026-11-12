/**
 * Help for the page's parts, shared by every frontend: the help pages boardd serves (`api/docs`), the prompt a person
 * copies into an AI assistant to get help setting a part up (its help page, where boardd is, the CLI commands, how it is
 * set up now), and copying text on pages served over plain http, where the clipboard API is not there.
 */
import { call } from './api.ts'
import type { View } from './contract.ts'

export interface HelpPage { name: string, title: string, text: string }

export const help = {
  list: () => call<{ docs: Array<{ name: string, title: string }> }>('GET', 'api/docs').then(out => out.docs),
  get: (name: string) => call<HelpPage>('GET', `api/docs/${encodeURIComponent(name)}`),
}

/** Where this page's boardd is: the page's address without the file or the route after `#`. */
export function boarddAddress(): string {
  if (typeof location === 'undefined') return ''
  return `${location.origin}${location.pathname.replace(/[^/]*$/, '')}`
}

const fence = (text: string) => `\`\`\`\n${text.trim()}\n\`\`\``

/** The prompt for an AI assistant about `view`: what it is, where boardd is, its commands, its help page, how it is now. */
export async function hintPrompt(view: Pick<View, 'title' | 'help' | 'hint'>): Promise<string> {
  const hint = view.hint ?? {}
  const page = view.help ? await help.get(view.help).catch(() => null) : null
  const context = hint.context ? await Promise.resolve(hint.context()).catch(error => `（读不到：${(error as Error).message}）`) : ''
  const address = boarddAddress()
  return [
    `我在配置 boardlab（开发板实验室）里的「${view.title ?? view.help ?? '这一部分'}」，请帮我把它配好。`,
    '',
    `boardlab 的服务 boardd 在 ${address || '（这台 boardd 的网页地址）'}，它的网页上就能改这些设置。在装了 boardlab 命令行的机器上，先 \`boardlab remote set ${address || '<boardd 地址>'}\`（或者 ssh://用户@主机），就能用命令行做同样的事${hint.commands?.length ? '：' : '。'}`,
    ...(hint.commands ?? []).map(command => `- \`${command}\``),
    ...(page ? ['', '这一部分的说明：', '', page.text.trim()] : []),
    ...(context.trim() ? ['', '现在的配置（不含密码、令牌）：', '', fence(context)] : []),
    '',
    `请一次只问我一个问题，弄清楚我的情况；问完以后给出${hint.produce ?? '要写的 YAML 或要跑的命令'}，并说明放在页面上哪里，或者用哪条命令放进去。不清楚的地方问我，不要猜。`,
  ].join('\n')
}

/** Put `text` on the clipboard: the clipboard API, or (plain http) a selected text area and the copy command. */
export async function copyToClipboard(text: string): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && (typeof window === 'undefined' || window.isSecureContext !== false)) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {}
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'; area.style.top = '-1000px'; area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch {}
  area.remove()
  if (!ok) throw new Error('浏览器不让写剪贴板：手动选中复制')
}
