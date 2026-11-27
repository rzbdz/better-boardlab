import { useEffect, useState } from 'react'
import { api } from './api.ts'

/** History is shared by everyone using boardd; typing or selecting is only a draft until saved. */
export function ModelPicker({ name, product, saved }: { name: string, product: string | null, saved?: () => void }) {
  const [value, setValue] = useState(product ?? '')
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => { setValue(product ?? ''); setMessage('') }, [name, product])
  const load = () => api.models().then(setModels, () => setMessage('历史型号读取失败，仍可手填'))
  useEffect(() => { void load() }, [])
  const unchanged = value.trim() === (product ?? '')
  const save = async () => {
    if (busy || unchanged) return
    setBusy(true); setMessage('')
    try {
      await api.setModel(name, value.trim() || null)
      setMessage('已保存'); saved?.(); await load()
    } catch (error) { setMessage(`型号没存上：${error instanceof Error ? error.message : String(error)}`) }
    finally { setBusy(false) }
  }
  return <span className="model-edit">
    <select className="select" aria-label="选择历史板型" value={models.includes(value) ? value : ''} disabled={busy}
      onFocus={() => void load()} onChange={e => setValue(e.target.value)}>
      <option value="" disabled>{models.length ? '选择历史板型' : '暂无历史板型'}</option>
      {models.map(model => <option key={model} value={model}>{model}</option>)}
    </select>
    <input className="input" aria-label="板型名称" value={value} placeholder="输入新板型" disabled={busy} onChange={e => setValue(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void save() } }} />
    <button type="button" className="pill sm" disabled={busy || unchanged} onClick={() => void save()}>保存</button>
    {message && <small role="status">{message}</small>}
  </span>
}
