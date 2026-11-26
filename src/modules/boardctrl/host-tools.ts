/**
 * Host tools: programs a board host needs beside boardctrld (a vendor flasher, say), shipped as
 * `host-tools/<arch>/<name>` and registered in `host-tools/host-tools.json` as `[{arch, name, sha256}]`. Setting up a
 * host puts the ones for its architecture in the install's `tools/`, which boardctrld has on its PATH. A
 * distribution without host-tools/ ships none.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Executor } from 'boardlab-core/shared/ssh.ts'

export interface HostTool { arch: string, name: string, sha256: string, path: string }

// The install's `tools/` (its unit puts it first on PATH), or the old prefix's for a host installed before the rename.
export const HOST_TOOLS = '/opt/boardctrl/tools', OLD_HOST_TOOLS = '/opt/bspd/tools'

const SAFE = /^[A-Za-z0-9_.+-]+$/

/** `uname -m` as the architecture names host-tools/ uses. */
export function hostArch(machine: string): string {
  const m = machine.trim()
  if (m === 'x86_64' || m === 'amd64') return 'amd64'
  if (m === 'aarch64' || m === 'arm64') return 'arm64'
  if (m.startsWith('armv7') || m === 'armhf') return 'arm'
  if (m === 'i386' || m === 'i686') return '386'
  return m
}

/** The tools registered in `dir`, none when it or its host-tools.json is absent. */
export function readHostTools(dir: string | undefined): HostTool[] {
  if (!dir || !existsSync(join(dir, 'host-tools.json'))) return []
  const list = JSON.parse(readFileSync(join(dir, 'host-tools.json'), 'utf8')) as Array<Omit<HostTool, 'path'>>
  return list.map(item => {
    if (!SAFE.test(item.arch) || !SAFE.test(item.name) || !/^[0-9a-f]{64}$/.test(item.sha256)) throw new Error(`host-tools.json：不合法的条目 ${JSON.stringify(item)}`)
    return { ...item, path: join(dir, item.arch, item.name) }
  })
}

/**
 * Put the tools for the host's architecture (`machine`, its `uname -m`) in the install's tools directory: each
 * checked against its sha256 here before it goes and there after it arrives. `staging` is a directory on the host to
 * copy them through.
 */
export async function shipHostTools(exec: Executor, sudo: string, dir: string | undefined, machine: string, staging: string, progress: (line: string) => void): Promise<string[]> {
  const tools = readHostTools(dir).filter(tool => tool.arch === hostArch(machine))
  if (!tools.length) return []
  for (const tool of tools) {
    const sum = existsSync(tool.path) ? createHash('sha256').update(readFileSync(tool.path)).digest('hex') : 'missing'
    if (sum !== tool.sha256) throw new Error(`主机工具 ${tool.arch}/${tool.name} 和 host-tools.json 记的 sha256 不一致`)
  }
  progress(`放主机工具：${tools.map(tool => tool.name).join('、')}`)
  await exec.run(`mkdir -p ${staging}/tools`)
  for (const tool of tools) await exec.put(tool.path, `${staging}/tools/${tool.name}`)
  // Where they go: always the install's tools/, which is first on boardctrld's PATH. A host installed before the
  // rename gets them in its old tools/ too, for a service that still runs from there; the old place alone is never
  // enough, because the service is moved to the new name as it is installed.
  const install = tools.map(tool =>
    `[ "$(sha256sum ${staging}/tools/${tool.name} | cut -d' ' -f1)" = ${tool.sha256} ] || { echo "${tool.name}: sha256 mismatch" >&2; exit 1; }; ` +
    `${sudo}install -D -m 755 ${staging}/tools/${tool.name} ${HOST_TOOLS}/${tool.name}; ` +
    `if [ -d ${OLD_HOST_TOOLS} ]; then ${sudo}install -m 755 ${staging}/tools/${tool.name} ${OLD_HOST_TOOLS}/${tool.name}; fi`)
  const run = await exec.run(`set -e; ${install.join('; ')}; rm -rf ${staging}/tools`, { timeoutMs: 120_000 })
  if (run.code !== 0) throw new Error(`放主机工具失败：${(run.stderr || run.stdout).trim().split('\n').slice(-3).join(' / ')}`)
  return tools.map(tool => tool.name)
}
