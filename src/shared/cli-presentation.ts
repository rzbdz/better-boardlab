/** User-facing CLI presentation owned by this distribution, not by boardlab-core. */
import type { Board, Chip, State } from 'boardlab-core/shared/types.ts'
import type { CliPresentation } from 'boardlab-core/cli/command.ts'
import type { Slot } from './local.ts'

type DistributionState = State & { slots?: Slot[] }

function boardPlace(board: Board): string {
  return board.lab ? `[实验室 ${board.lab.id} ${board.lab.empty ? '空槽位' : board.lab.device}]` : board.slot === null ? '  -' : `[${board.slot}]`
}

function boardDetails(board: Board): string {
  const slot = board.lab && board.slotRef ? `  槽位 ${board.slotRef.split('/').slice(1).join('/')}` : ''
  const media = board.lab?.mediaBoot && board.lab.mediaBoot.method !== 'reset'
    ? `  复位：${board.lab.mediaBoot.available ? `经 ${board.lab.mediaBoot.method} 从介质启动` : '停在下载模式'}` : ''
  return `${board.lab?.empty ? '（只有串口）' : ''}${slot}${media}`
}

function chipDetails(board: Board, chip: Chip): string {
  if (board.lab) return `串口 ${chip.serialPath ?? '-'}（实验室那边${chip.online ? '在线' : '没有连上'}）  下载口 ${chip.downloadUsbPath ?? '-'}`
  return `串口 ${chip.serialPath ?? '-'}${chip.alias ? `（serial-mux ${chip.alias}${chip.online ? '' : '，未绑定设备'}）` : ''}  下载口 ${chip.downloadUsbPath ?? '-'}${chip.usbId ? ` (${chip.usbId})` : ''}`
}

export const presentation: CliPresentation = {
  boardPlace,
  boardDetails,
  chipDetails,
  emptyPlaces(state) {
    const local = state as DistributionState
    return (local.slots ?? []).filter(slot => !state.boards.some(board => board.slot === slot.slot)).map(slot => `[${slot.slot}] （空槽位）`)
  },
  stateDetails(state) {
    return state.proposals.length ? `\n${state.proposals.length} 条扫描改动建议待确认：boardlab proposals` : null
  },
  lockTokenHint(token) {
    return `直接用 smtty 输入时带上 --token ${token}（或设 SERIAL_MUX_TOKEN）；不带的只能看输出`
  },
}
