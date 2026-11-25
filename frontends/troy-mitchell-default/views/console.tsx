/** The online console: one live terminal session per chip, kept while the page shows it, and its panel. */
import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { Board } from 'boardlab-core/shared/types.ts'
import type { PageState } from '../../../src/ui/api.ts'
import { CONSOLE_WORDS, consoleErrorText, consoleStatusText, createConsoleSession, type ConsoleSession, type ConsoleStatus } from '../../../src/ui/console-session.ts'
import { usePicker } from '../../../src/ui/picker.ts'
import { who } from '../kit.tsx'

/**
 * Open terminals, kept across board and page switches so coming back to a console shows it as it was, live, without
 * reconnecting. Each has one stream from boardd. The × closes one; beyond a few, or after a while out of sight, the
 * least recently shown is closed; all close when the page goes away.
 */
interface LiveConsole {
  key: string
  status: ConsoleStatus
  reason: string | null
  mine: boolean
  lastShown: number
  attached: boolean
  attach(host: HTMLElement, onStatus: (status: ConsoleStatus, reason: string | null) => void, onError: (text: string) => void): void
  detach(): void
  dispose(): void
}
const consoles = new Map<string, LiveConsole>()
const MAX_CONSOLES = 3
const HIDDEN_CONSOLE_MS = 10 * 60_000

function liveConsole(board: string, die: string | undefined): LiveConsole {
  const key = `${board}\0${die ?? ''}`
  const known = consoles.get(key)
  if (known) return known
  const el = document.createElement('div')
  el.className = 'xterm-box'
  const term = new Terminal({ convertEol: false, cursorBlink: true, fontSize: 13, scrollback: 20_000, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', theme: { background: '#11151c' } })
  const fit = new FitAddon()
  term.loadAddon(fit)
  let opened = false, onStatus: (status: ConsoleStatus, reason: string | null) => void = () => {}, onError: (text: string) => void = () => {}
  const observer = new ResizeObserver(() => { try { fit.fit() } catch {} })
  let session!: ConsoleSession
  const live: LiveConsole = {
    key, status: 'connecting', reason: null, mine: false, lastShown: Date.now(), attached: false,
    attach(host, status, error) {
      onStatus = status
      onError = error
      host.appendChild(el)
      if (!opened) { term.open(el); opened = true }
      observer.observe(el)
      live.attached = true
      live.lastShown = Date.now()
      requestAnimationFrame(() => { try { fit.fit() } catch {} ; term.focus() })
      status(live.status, live.reason)
    },
    detach() {
      observer.disconnect()
      el.remove()
      live.attached = false
      live.lastShown = Date.now()
      onStatus = () => {}
    },
    dispose() {
      session.dispose()
      observer.disconnect()
      el.remove()
      term.dispose()
      consoles.delete(key)
    },
  }
  session = createConsoleSession({
    board, die,
    onOutput: data => term.write(data),
    onStatus: (status, reason) => { live.status = status; live.reason = reason; onStatus(status, reason) },
    onError: error => onError(consoleErrorText(error)),
  })
  term.onData(session.input)
  consoles.set(key, live)
  // Keep only a few streams open: browsers allow few connections to one site, and the page needs some for itself.
  const hidden = [...consoles.values()].filter(item => item !== live && !item.attached).sort((a, b) => a.lastShown - b.lastShown)
  while (consoles.size > MAX_CONSOLES && hidden.length) hidden.shift()!.dispose()
  return live
}

const closeConsoles = (match: (live: LiveConsole) => boolean) => { for (const live of [...consoles.values()]) if (match(live)) live.dispose() }
window.addEventListener('pagehide', () => closeConsoles(() => true))
window.setInterval(() => closeConsoles(live => !live.attached && Date.now() - live.lastShown > HIDDEN_CONSOLE_MS), 60_000)

/** A board whose console can be opened: one with a port online, or in a lab (asked on opening). */
const hasConsole = (board: Board) => board.chips.some(chip => chip.online) || (!!board.lab && board.chips.length > 0)

/** Where a board is, as its card says it: the lab and its slot, or this machine's slot. */
const placeOf = (board: Board) => board.lab
  ? `实验室 ${board.lab.id} · ${board.slotRef ? board.slotRef.split('/').slice(1).join('/') : board.lab.device}`
  : `槽位 ${board.slot ?? '—'}`
const stateOf = (board: Board, you: string) => board.lab?.empty ? '空槽位' : board.lease ? (board.lease.holder === you ? '你在使用' : `${who(board.lease.holder)} 在用`) : board.lab?.heldBy ? '实验室占用' : '空闲'

/**
 * The console's title, which also switches it to another board's console: it looks like a field on hover (always on a
 * touch or narrow screen) and lists the boards with a console, each with where it is and who has it.
 */
function BoardSwitch({ board, state, onSwitch }: { board: Board, state: PageState, onSwitch: (board: string) => void }) {
  const boards = state.boards.filter(item => hasConsole(item) || item.name === board.name)
  const p = usePicker({
    items: boards, key: item => item.name, current: board.name,
    text: item => [item.name, placeOf(item), item.product, stateOf(item, state.you)].join(' '),
    onPick: item => onSwitch(item.name),
  })
  return (
    <div className={`board-switch${p.open ? ' open' : ''}`} {...p.rootProps}>
      <h3><span className="board-switch-t" {...p.triggerProps} title={`${board.name} · 换一块板子的串口`} aria-label={`${board.name}，换一块板子的串口`}>
        {board.name}<span className="caret" aria-hidden="true" />
      </span></h3>
      {p.open && <div className="board-switch-pop">
        {p.filtering && <input {...p.inputProps} placeholder="找板子" aria-label="找板子" />}
        <ul {...p.listProps} aria-label="换一块板子的串口">
          {p.shown.map((item, index) => (
            <li key={item.name} {...p.optionProps(item, index)}>
              <span className={`dot ${item.chips.some(chip => chip.online) ? 'dot-ok' : 'dot-off'}`} />
              <b>{item.name}</b>
              <small>{placeOf(item)} · {stateOf(item, state.you)}</small>
            </li>
          ))}
          {!p.shown.length && <li className="none">没有匹配的板子</li>}
        </ul>
      </div>}
    </div>
  )
}

/**
 * The online console: a terminal on the chip's serial port. Output streams from boardd; while you hold the lock, what you
 * type goes to the board as you type it, through boardd, the same way for boards here and in labs.
 */
export function Console({ board, state, onClose, onError, onSwitch }: { board: Board, state: PageState, onClose: () => void, onError: (text: string) => void, onSwitch: (board: string) => void }) {
  const dies = board.chips.filter(chip => chip.online || board.lab)
  const [die, setDie] = useState(dies[0]?.die)
  const [status, setStatus] = useState<ConsoleStatus>('connecting')
  const [reason, setReason] = useState<string | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const mine = board.lease?.holder === state.you
  const current = useRef<LiveConsole | null>(null)
  // The page re-renders on every board change; only the board and chip pick the terminal, never a new callback.
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  useEffect(() => {
    const live = liveConsole(board.name, die)
    current.current = live
    live.mine = mine
    live.attach(host.current!, (next, why) => { setStatus(next); setReason(why) }, text => onErrorRef.current(text))
    return () => live.detach()
  }, [board.name, die])
  useEffect(() => { if (current.current) current.current.mine = mine }, [mine])
  const label = consoleStatusText(status, reason, CONSOLE_WORDS)
  const close = () => { current.current?.dispose(); onClose() }
  return (
    <aside className="console" aria-label="串口控制台">
      <header>
        <div className="title">
          <BoardSwitch board={board} state={state} onSwitch={onSwitch} />
          <span className="muted" data-testid="console-status"><span className={`dot ${status === 'live' ? 'dot-ok' : 'dot-off'}`} />{label} · 直接输入{board.lease && !mine ? `（锁在 ${who(board.lease.holder)} 手里，你的输入会和它的混在一起）` : ''}</span>
        </div>
        {dies.length > 1 && (
          <select value={die} onChange={event => setDie(event.target.value)} aria-label="芯片">
            {dies.map(chip => <option key={chip.die} value={chip.die}>{chip.die}</option>)}
          </select>
        )}
        <button className="icon" onClick={() => onClose()} title="收起（串口保持连接，回来时原样显示）" aria-label="收起控制台">–</button>
        <button className="icon" onClick={close} title="关闭这个串口" aria-label="关闭控制台">×</button>
      </header>
      <div ref={host} className="terminal xterm-host" data-testid="console-output" />
    </aside>
  )
}
