/** Offers the local module to boardd: boards on this machine, through serial-mux and this machine's USB and fastboot. */
import type { CatalogEntry } from 'boardlab-core/server/catalog.ts'
import { SerialMux, startAlias, stopAlias, stopAll } from '../serial-mux/client.ts'
import { fastbootTool, listSerialAdapters, listUsb } from './hardware.ts'
import { local, type Mux } from './index.ts'
import { DEFAULT_TIMING, type ScanTiming } from './scan.ts'

/** serial-mux on this machine, as the local module uses it. */
function serialMux(): Mux {
  const mux = new SerialMux()
  return {
    open: (alias, token) => mux.open(alias, { token }), gate: (alias, gate) => mux.gate(alias, gate),
    online: alias => mux.daemons().some(daemon => daemon.alias === alias && !!daemon.device),
    stopAll: () => stopAll(mux), start: (adapter, alias) => startAlias(mux, adapter, alias), stop: alias => stopAlias(mux, alias),
  }
}

export const entry: CatalogEntry = {
  id: 'local', about: '接在本机上的板子：槽位、serial-mux 串口、本机 fastboot、扫描',
  create: (_settings, context) => local({
    mux: serialMux(),
    hardware: { usb: () => listUsb(), serialAdapters: () => listSerialAdapters(), fastboot: fastbootTool },
    scanTiming: { ...DEFAULT_TIMING, ...(context.timing.scan as Partial<ScanTiming> | undefined) },
  }),
}
