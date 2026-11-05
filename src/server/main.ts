/** How often boardd lists its labs' boards again, which also refreshes whether their consoles are up. */
const LAB_SYNC_MS = 60_000

/** `boards serve`: wire the real Home Assistant, serial-mux, USB adapters and remote labs into the service. */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PORT, socketPathFor } from '../shared/client.ts'
import { openDatabase } from './db.ts'
import { homeAssistant } from './ha.ts'
import { fastbootTool, listSerialAdapters, listUsb, scriptRunner } from './hardware.ts'
import { serve } from './http.ts'
import { spacemitBmc } from './bmc.ts'
import { fireflyAbmc } from './firefly.ts'
import { sshShell } from './labs.ts'
import { SerialMux, startAlias, stopAlias, stopAll } from './serial-mux.ts'
import { BoardService } from './service.ts'

export async function startBoardd(options: { stateDir: string, port?: number, hosts?: string[], uiDir?: string | null, firmwareDir?: string }) {
  const db = openDatabase(join(options.stateDir, 'boards.sqlite'))
  const mux = new SerialMux()
  const sshDir = join(options.stateDir, 'ssh')
  mkdirSync(sshDir, { recursive: true, mode: 0o700 })
  const service = new BoardService({
    db, ha: homeAssistant,
    mux: { open: (alias, token) => mux.open(alias, { token }), gate: (alias, gate) => mux.gate(alias, gate), online: alias => mux.daemons().some(daemon => daemon.alias === alias && !!daemon.device), stopAll: () => stopAll(mux), start: (adapter, alias) => startAlias(mux, adapter, alias), stop: alias => stopAlias(mux, alias) },
    hardware: { usb: () => listUsb(), serialAdapters: () => listSerialAdapters(), fastboot: fastbootTool, scripts: scriptRunner },
    firmwareDir: options.firmwareDir,
    labs: { bmc: spacemitBmc(sshShell(sshDir)), abmc: fireflyAbmc(sshShell(sshDir)) },
  })
  // Pick up controller changes made in HA while boardd was down.
  if (service.haSettings().hasToken) void service.syncSlots().catch(() => {})
  // Boards keep their consoles across reboots and scans boardd did not live to finish.
  void service.restoreConsoles().catch(() => {})
  void service.syncLabs()
  const labSync = setInterval(() => void service.syncLabs(), LAB_SYNC_MS)
  labSync.unref()
  const port = options.port ?? DEFAULT_PORT
  const uiDir = options.uiDir === undefined ? null : options.uiDir
  const server = await serve(service, { port, hosts: options.hosts, socketPath: socketPathFor(options.stateDir), uiDir: uiDir && existsSync(uiDir) ? uiDir : null })
  return {
    service, port, hosts: ['127.0.0.1', ...(options.hosts ?? [])],
    async close() { clearInterval(labSync); await server.close(); db.close() },
  }
}
