/**
 * Help beside a part's title: "?" opens its help page; the AI hint button opens a prompt with setup context and
 * suggested instructions to copy into an AI assistant (see src/ui/help.ts).
 */
import { useEffect, useState } from 'react'
import type { View } from '../../src/ui/contract.ts'
import { copyToClipboard, help, hintPrompt, type HelpPage } from '../../src/ui/help.ts'
import { Icon, useUI } from './kit.tsx'
import { Markdown } from './markdown.tsx'

function HelpDialog({ name, close }: { name: string, close: () => void }) {
  const [page, setPage] = useState<HelpPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { help.get(name).then(setPage, failed => setError((failed as Error).message)) }, [name])
  return (
    <>
      {error ? <><h2>帮助</h2><p className="lead">读不到帮助页 {name}：{error}</p></> : page ? <Markdown text={page.text} /> : <p className="lead"><span className="spin" />读取中…</p>}
      <div className="foot"><button className="pill" onClick={close}>关闭</button></div>
    </>
  )
}

function HintDialog({ view, close }: { view: Pick<View, 'title' | 'help' | 'hint'>, close: () => void }) {
  const ui = useUI()
  const [prompt, setPrompt] = useState<string | null>(null)
  useEffect(() => { hintPrompt(view).then(setPrompt, error => setPrompt(`（生成提示失败：${(error as Error).message}）`)) }, [])
  const copy = async () => {
    try { await copyToClipboard(prompt ?? ''); ui.toast('已复制', '可将提示粘贴到 AI 助手；其中包含配置上下文和建议指令') } catch (error) { ui.fail('复制不了', error) }
  }
  return (
    <>
      <h2>AI 提示：{view.title}</h2>
      <p className="lead">可将下面的提示粘贴给 AI 助手（Claude 等）。提示提供配置上下文和建议指令，不包含密码或令牌；助手不一定遵循指令或生成正确配置，请检查后使用。</p>
      <textarea className="textarea" readOnly rows={16} aria-label="提示" value={prompt ?? '生成中…'} onFocus={e => e.currentTarget.select()} />
      <div className="foot"><button className="pill" onClick={close}>关闭</button><button className="pill dark" disabled={prompt === null} onClick={() => void copy()}><Icon name="copy" />复制</button></div>
    </>
  )
}

/** The "?" and AI hint buttons for a part with a help page (or a hint); `ai`: whether to offer the hint (a view's own). */
export function HelpButtons({ view, ai = true }: { view: Pick<View, 'title' | 'help' | 'hint'>, ai?: boolean }) {
  const ui = useUI()
  if (!view.help && !(ai && view.hint)) return null
  return (
    <span className="help-btns">
      {view.help && <button type="button" className="help-btn" aria-label="帮助" title="帮助" onClick={() => ui.layer(close => <HelpDialog name={view.help!} close={close} />, 'wide')}>?</button>}
      {ai && <button type="button" className="help-btn" aria-label="AI 提示" title="AI 提示：复制一段话给 AI 助手，让它帮你配" onClick={() => ui.layer(close => <HintDialog view={view} close={close} />, 'wide')}><Icon name="doc" /></button>}
    </span>
  )
}
