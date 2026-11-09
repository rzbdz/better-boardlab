/** The local module's commands: scanning this machine's slots. */
import type { Scan } from 'boardlab-core/shared/types.ts'
import { confirm, type Command, type CommandGroup } from 'boardlab-core/cli/command.ts'

function printScan(scan: Scan) {
  console.log(`扫描 ${scan.id.slice(0, 8)}：${scan.status}${scan.message ? `（${scan.message}）` : ''}`)
  for (const row of scan.result) {
    console.log(`  槽位 ${row.slot} ${row.board ?? '（未登记）'}`)
    for (const chip of row.chips) console.log(`    ${chip.die}${chip.pending ? '（待人确认）' : ''}: 串口 ${chip.serialPath ?? '-'}  下载口 ${chip.downloadUsbPath ?? '-'}  型号 ${chip.product ?? '未知'}`)
    for (const flag of row.flags) console.log(`    ! ${flag}`)
  }
}

const scan: Command = {
  name: 'scan', usage: ['scan [--boards a,b] [--slots 0,1] [--yes]\t扫描本机的槽位：逐个按 fastboot、读型号、找串口和下载口，结果列成改动建议'],
  async run({ client, flag, flags, json, out }) {
    const list = (name: string) => flag(name)?.split(',').map(item => item.trim()).filter(Boolean)
    const scope = { boards: list('boards'), slots: list('slots')?.map(Number) }
    if (!flags.has('yes') && !(await confirm(`扫描会逐个按 fastboot、往内存加载诊断镜像并复位${scope.boards ? ` ${scope.boards.join(', ')}` : scope.slots ? `槽位 ${scope.slots.join(', ')}` : '所有槽位'}。继续？`))) {
      throw new Error('扫描需要确认（交互确认或 --yes）')
    }
    let scan = await client.scan({ ...scope, confirmed: true })
    let shown = 0
    while (scan.status === 'running') {
      await new Promise(done => setTimeout(done, 1000))
      scan = await client.scanStatus(scan.id)
      if (!json) for (const step of scan.steps.slice(shown)) console.error(`  ${step.slot === null ? '' : `[${step.slot}] `}${step.summary}`)
      shown = scan.steps.length
    }
    out(scan, () => printScan(scan))
    if (scan.status !== 'done') process.exitCode = 1
  },
}

export const commands: CommandGroup = { title: '本机', commands: [scan] }
