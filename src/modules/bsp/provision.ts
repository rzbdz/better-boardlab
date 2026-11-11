/**
 * Setting up a bsp board host from boardd: reach it over ssh (any way in that works; see the hosts library), ship the
 * bsp tree this distribution carries, and run its `deploy/bspd-install.sh`, which makes bspd's config from what the
 * machine is. The lab then drives that bspd through an ssh tunnel to its loopback port, with the token made here.
 * Installing again updates it in place; uninstalling takes it away.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Access, Executor, Hosts } from '../hosts/ssh.ts'

export interface HostSetup { id: string, access: Access, port?: number, board?: string }
export interface Installed { target: string, port: number, token: string, version: string, url: string }

const tar = (cwd: string, out: string) => new Promise<void>((resolve, reject) =>
  execFile('tar', ['--exclude=.git', '--exclude=__pycache__', '--exclude=*.pyc', '--exclude=.venv', '--exclude=e2e-material', '-czf', out, '.'], { cwd, maxBuffer: 1024 * 1024 }, error => error ? reject(error) : resolve()))

/** Run as root there: directly, or through sudo without a password. */
async function root(exec: Executor): Promise<string> {
  const who = await exec.run('id -u')
  if (who.stdout.trim() === '0') return ''
  const sudo = await exec.run('sudo -n true')
  if (sudo.code === 0) return 'sudo -n '
  throw new Error(`在 ${exec.target} 上不是 root，也不能免密 sudo：bspd 要装系统服务、拉 GPIO。用 root 登录，或者给这个用户免密 sudo`)
}

export async function installHost(hosts: Hosts, bspTree: string, setup: HostSetup, token: string | null, progress: (line: string) => void): Promise<Installed> {
  if (!existsSync(join(bspTree, 'deploy/bspd-install.sh'))) throw new Error(`这个 boardlab 没带 bsp（${bspTree}/deploy/bspd-install.sh 不在）`)
  progress(`连 ${setup.access.address}…`)
  const exec = await hosts.reach(setup.access, progress)
  const sudo = await root(exec)
  const facts = await exec.run('uname -m; tr -d "\\0" < /proc/device-tree/model 2>/dev/null; echo; python3 -V 2>&1')
  progress(`那台机器：${facts.stdout.trim().replace(/\n+/g, '，')}`)
  const dir = mkdtempSync(join(tmpdir(), 'boardlab-bsp-'))
  try {
    const bundle = join(dir, 'bsp.tgz')
    progress('打包 bsp…')
    await tar(bspTree, bundle)
    const remote = `/tmp/boardlab-bsp-${randomBytes(4).toString('hex')}`
    progress('传过去…')
    await exec.run(`mkdir -p ${remote}`)
    await exec.put(bundle, `${remote}/bsp.tgz`)
    const made = token ?? randomBytes(24).toString('hex')
    const port = setup.port ?? 8765
    progress('在那台机器上装 bspd（第一次要建 Python 环境，几分钟）…')
    const run = await exec.run(
      `set -e; cd ${remote}; tar -xzf bsp.tgz; ${sudo}bash deploy/bspd-install.sh --id '${setup.id}' --port ${port} --bind 127.0.0.1 --token '${made}' ${setup.board ? `--board '${setup.board}'` : ''}; cd /; rm -rf ${remote}`,
      { timeoutMs: 1_800_000, onLine: line => { if (line.trim()) progress(line) } })
    const ready = /BSPD-READY (\S+) (\d+) (\S+)/.exec(run.stdout)
    if (run.code !== 0 || !ready) throw new Error(`装 bspd 失败：${(run.stderr || run.stdout).trim().split('\n').slice(-4).join(' / ')}`)
    // Reached from here through an ssh tunnel to its loopback port, as boardd's own key gets in.
    const url = `bspd+ssh://${exec.target}:${port}`
    return { target: exec.target, port, token: made, version: ready[3]!, url }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

export async function uninstallHost(hosts: Hosts, access: Access, purge: boolean, progress: (line: string) => void): Promise<void> {
  const exec = await hosts.reach(access, progress)
  const sudo = await root(exec)
  const run = await exec.run(`set -e; d=$(mktemp -d); cd $d; if [ -x /opt/bspd/current/app/deploy/bspd-install.sh ]; then ${sudo}bash /opt/bspd/current/app/deploy/bspd-install.sh --uninstall ${purge ? '--purge' : ''}; else echo BSPD-REMOVED; fi`, { timeoutMs: 120_000 })
  if (!/BSPD-REMOVED/.test(run.stdout)) throw new Error(`卸载 bspd 失败：${(run.stderr || run.stdout).trim().split('\n').slice(-3).join(' / ')}`)
}
