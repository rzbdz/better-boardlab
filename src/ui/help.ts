/**
 * Help for the page's parts, shared by every frontend: the help pages boardd serves (`api/docs`), a prompt containing
 * setup context and suggested instructions for an AI assistant (its help page, boardd address, CLI commands and current
 * configuration), and clipboard support on pages where the asynchronous clipboard API is unavailable.
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

/** Build a prompt with context and suggested instructions for an AI assistant; following them is not guaranteed. */
export async function hintPrompt(view: Pick<View, 'title' | 'help' | 'hint'>): Promise<string> {
  const hint = view.hint ?? {}
  const page = view.help ? await help.get(view.help).catch(() => null) : null
  const context = hint.context ? await Promise.resolve(hint.context()).catch(error => `（读取失败：${(error as Error).message}）`) : ''
  const address = boarddAddress()
  return [
    `以下是配置 boardlab（开发板实验室）「${view.title ?? view.help ?? '这一部分'}」的上下文和建议指令。`,
    '',
    `boardlab 的服务 boardd 地址为 ${address || '（这台 boardd 的网页地址）'}，可通过网页修改这些设置。在安装了 boardlab 命令行的机器上，先执行 \`boardlab remote set ${address || '<boardd 地址>'}\`（或者 ssh://用户@主机），即可使用对应的命令行操作${hint.commands?.length ? '：' : '。'}`,
    ...(hint.commands ?? []).map(command => `- \`${command}\``),
    ...(page ? ['', '这一部分的帮助文档：', '', page.text.trim()] : []),
    ...(context.trim() ? ['', '当前配置（不含密码、令牌）：', '', fence(context)] : []),
    '',
    `建议一次只问我一个问题，先了解实际环境，再给出${hint.produce ?? '要写的 YAML 或要执行的命令'}，并说明对应的页面位置或执行命令。信息不明确时应继续询问，不要猜测。这些指令仅是建议；AI 助手不保证遵循，也不保证生成的配置正确。`,
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
