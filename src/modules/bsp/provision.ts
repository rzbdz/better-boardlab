/**
 * Setting up a bsp board host from boardd: reach it over ssh (any way in that works; see the hosts library), ship the
 * bsp tree this distribution carries, and run its `deploy/bspd-install.sh`, which makes bspd's config from what the
 * machine is. The lab then drives that bspd through an ssh tunnel to its loopback port (on boardd's own machine,
 * that port directly), with the token made here.
 * Installing again updates it in place; uninstalling takes it away. The site boardd keeps (site.ts) goes along, and
 * is synced to every host when it changes: swapped in only while nothing runs on the host's boards, and put back
 * when the host's bspd does not take it.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Access, Executor, Hosts } from '../hosts/ssh.ts'
import { shipHostTools } from './host-tools.ts'

/** `ca`: a certificate the host must trust (the network's own CA), installed before anything is downloaded there. */
export interface HostSetup { id: string, access: Access, port?: number, board?: string, ca?: string | null }
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

/** Where a host keeps its site, and what boardd ships into it (its `hosts/` stays the host's own). */
export const HOST_SITE = '/etc/bsp/site'
/** Beside it: a new site unpacked before it goes in, and the parts it replaced, kept until the host has taken it. */
const INCOMING = `${HOST_SITE}.incoming`, PREVIOUS = `${HOST_SITE}.previous`

/** A failed sync, and the host's site after it: the one it had (put back), or not known. */
export class SiteSyncError extends Error {
  constructor(message: string, readonly left: 'previous' | 'unknown' = 'previous') { super(message) }
}

/** A shell script there, as root; its last lines when it does not get to its end, null when it does. */
async function script(exec: Executor, sudo: string, lines: string[], timeoutMs = 120_000): Promise<string | null> {
  const run = await exec.run(`${sudo}sh -s`, { stdin: `${lines.join('\n')}\necho SCRIPT-DONE\n`, timeoutMs })
  if (run.code === 0 && run.stdout.includes('SCRIPT-DONE')) return null
  return (run.stderr || run.stdout).trim().split('\n').slice(-3).join(' / ') || `退出码 ${run.code}`
}

/** Unpack a site bundle (a gzipped tar of `socs/ sdk/ hooks/ .blobs/`) beside the host's site, not in it yet. */
async function stageSite(exec: Executor, sudo: string, bundle: string, progress: (line: string) => void): Promise<void> {
  const remote = `/tmp/boardlab-site-${randomBytes(4).toString('hex')}`
  progress('传站点过去…')
  await exec.run(`mkdir -p ${remote}`)
  await exec.put(bundle, `${remote}/site.tgz`)
  const failed = await script(exec, sudo, [
    'set -e', `mkdir -p ${HOST_SITE}`, `rm -rf ${INCOMING}`, `mkdir -p ${INCOMING}`,
    `tar -xzf ${remote}/site.tgz -C ${INCOMING} --no-same-owner`, `rm -rf ${remote}`,
  ], 600_000)
  if (failed) { await exec.run(`${sudo}rm -rf ${INCOMING} ${remote}`); throw new SiteSyncError(`放站点到 ${exec.target} 失败：${failed}`) }
}

/**
 * Put the staged site in, each part by rename: `socs/`, `sdk/` and `hooks/` are replaced by the bundle's (gone when it
 * has none), the ones replaced kept beside the site for `restoreSite`; `.blobs/` is added to (images are kept by
 * sha256, and the host may have fetched more); `hosts/` and anything else there is left alone.
 */
async function swapSite(exec: Executor, sudo: string): Promise<void> {
  const s = HOST_SITE, i = INCOMING, p = PREVIOUS
  const failed = await script(exec, sudo, [
    'set -e', `rm -rf ${p}`, `mkdir -p ${p}`,
    // A part is listed once it is out of the way, so a swap stopped half way is put back as far as it went.
    `for d in socs sdk hooks; do if [ -e ${s}/$d ]; then mv ${s}/$d ${p}/$d; fi; echo $d >> ${p}/.swapped; if [ -e ${i}/$d ]; then mv ${i}/$d ${s}/$d; fi; done`,
    `if [ -d ${i}/.blobs ]; then mkdir -p ${s}/.blobs; cp -R ${i}/.blobs/. ${s}/.blobs/; fi`,
    `rm -rf ${i}`,
  ], 600_000)
  if (!failed) return
  const back = await restoreSite(exec, sudo)
  throw new SiteSyncError(`换上新站点失败：${failed}${back ? `；放回原来的也失败了：${back}` : '；原来的站点放回去了'}`, back ? 'unknown' : 'previous')
}

/** Put back the parts the last swap replaced; what went wrong, or null. */
async function restoreSite(exec: Executor, sudo: string): Promise<string | null> {
  const s = HOST_SITE, p = PREVIOUS
  return script(exec, sudo, [
    'set -e', `rm -rf ${INCOMING}`,
    `if [ -f ${p}/.swapped ]; then while read -r d; do rm -rf ${s}/$d; if [ -e ${p}/$d ]; then mv ${p}/$d ${s}/$d; fi; done < ${p}/.swapped; fi`,
    `rm -rf ${p}`,
  ])
}

/** The host has taken the new site: the parts it replaced go. */
async function keepSite(exec: Executor, sudo: string): Promise<void> {
  await exec.run(`${sudo}rm -rf ${PREVIOUS}`)
}

/**
 * Put a site bundle into the host's site (see `swapSite`), the parts it replaced kept until `keepSite` (the host took
 * it) or `restoreSite` (it did not).
 */
export async function shipSite(exec: Executor, sudo: string, bundle: string, progress: (line: string) => void): Promise<void> {
  await stageSite(exec, sudo, bundle, progress)
  await swapSite(exec, sudo)
}

/** Ask the host's bspd, on its loopback port with the token in its env file: a tool's JSON envelope (or `health`, or the tool list). */
const ASK = `import json, os, sys, urllib.request, urllib.error
port, tool = sys.argv[1], sys.argv[2]
path = {"health": "/api/v1/health", "tools": "/api/v1/tools"}.get(tool, "/api/v1/tools/" + tool)
req = urllib.request.Request("http://127.0.0.1:%s%s" % (port, path), data=None if tool in ("health", "tools") else b"{}",
                             headers={"Content-Type": "application/json", "Authorization": "Bearer " + os.environ.get("BSP_TOKEN", "")})
try:
    with urllib.request.urlopen(req, timeout=120) as r:
        body = r.read().decode()
except urllib.error.HTTPError as e:
    body = e.read().decode()
except Exception as e:
    body = json.dumps({"ok": False, "error": {"code": "unreachable", "message": str(e)}})
sys.stdout.write(body)
`
interface Envelope { ok?: boolean, result?: unknown, tools?: Array<{ name?: string, tool_name?: string }>, error?: { code?: string, message?: string } }
async function ask(exec: Executor, sudo: string, port: number, tool: string): Promise<Envelope> {
  const run = await exec.run(`${sudo}sh -c 'set -a; if [ -f /etc/bsp/hostd.env ]; then . /etc/bsp/hostd.env; fi; set +a; exec python3 - ${port} ${tool}'`, { stdin: ASK, timeoutMs: 150_000 })
  try { return JSON.parse(run.stdout) as Envelope }
  catch { return { ok: false, error: { code: 'unreachable', message: (run.stderr || run.stdout).trim().split('\n').at(-1) || `退出码 ${run.code}` } } }
}
const said = (envelope: Envelope) => envelope.error?.message ?? '没有回答'

/**
 * Whether the host's bspd reads a new site in place (its tool list has `site_reload`; one too old to is restarted
 * instead). Refused while a board on it is busy or a job runs on it (a new site changes the hooks and profiles they
 * use), and, when it is to be restarted, while a board on it is leased (a restart drops what is running on it).
 */
async function readyFor(exec: Executor, sudo: string, port: number): Promise<{ reloads: boolean }> {
  const tools = await ask(exec, sudo, port, 'tools')
  if (!tools.ok || !Array.isArray(tools.tools)) throw new SiteSyncError(`问不到 bspd 会做什么：${said(tools)}`)
  const names = new Set(tools.tools.map(tool => tool.tool_name ?? String(tool.name ?? '').replace(/\./g, '_')))
  const reloads = names.has('site_reload')
  const duts = await ask(exec, sudo, port, 'dut_list')
  if (!duts.ok) throw new SiteSyncError(`问不到 bspd 有没有板子在用：${said(duts)}`)
  const rows = Array.isArray(duts.result) ? duts.result as Array<{ id?: string, busy?: string | null, lease?: { holder?: string } | null }> : []
  const busy = rows.filter(dut => dut.busy).map(dut => `${dut.id ?? '?'}：${dut.busy}`)
  if (names.has('job_list')) {
    const jobs = await ask(exec, sudo, port, 'job_list')
    if (!jobs.ok) throw new SiteSyncError(`问不到 bspd 有没有任务在跑：${said(jobs)}`)
    const running = (Array.isArray(jobs.result) ? jobs.result as Array<{ id?: string, title?: string, status?: string }> : []).filter(job => job.status === 'running')
    busy.push(...running.map(job => `任务 ${job.id ?? '?'}${job.title ? `：${job.title}` : ''}`))
  }
  if (busy.length) throw new SiteSyncError(`主机上有板子在忙（${busy.join('、')}），没换站点：等它们做完再同步`)
  const leased = rows.filter(dut => dut.lease)
  if (!reloads && leased.length) throw new SiteSyncError(`这个 bspd 还不会重读站点，要重启它，但有板子正被用着（${leased.map(dut => `${dut.id ?? '?'}：${dut.lease?.holder ?? '?'}`).join('、')}），没重启 bspd，也没换站点：等没人用时再同步，或重新安装这台主机`)
  return { reloads }
}

/** Restart bspd and wait for it to answer; what went wrong when it does not. */
async function restart(exec: Executor, sudo: string, port: number, waitSeconds: number): Promise<string | null> {
  const run = await exec.run(`${sudo}systemctl restart bsp-hostd`, { timeoutMs: 60_000 })
  if (run.code !== 0) return `重启 bsp-hostd 失败：${(run.stderr || run.stdout).trim()}`
  for (let attempt = 0; attempt < waitSeconds; attempt++) {
    if ((await ask(exec, sudo, port, 'health')).ok) return null
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  const journal = await exec.run(`${sudo}journalctl -u bsp-hostd --no-pager -n 5 -o cat 2>/dev/null`, { timeoutMs: 30_000 })
  const tail = journal.code === 0 ? journal.stdout.trim().split('\n').filter(Boolean).slice(-3).join(' / ') : ''
  return `重启了 bsp-hostd，但它 ${waitSeconds} 秒内没起来${tail ? `：${tail}` : ''}`
}

/**
 * Have the host's bspd take the site just swapped in: `site.reload`, or a restart for a bspd too old to have it. When
 * it does not take it, the site it had is put back (and read again, or bspd restarted on it), and what went wrong is
 * the error: a host never keeps a site its bspd refused. Says what it did.
 */
async function takeSite(exec: Executor, sudo: string, port: number, reloads: boolean, progress: (line: string) => void, waitSeconds: number): Promise<string> {
  let why: string
  if (reloads) {
    const reloaded = await ask(exec, sudo, port, 'site_reload')
    if (reloaded.ok) {
      await keepSite(exec, sudo)
      const result = (reloaded.result ?? {}) as { sdks?: string[], socs?: string[] }
      return `bspd 重新读了站点：${result.sdks?.length ?? 0} 个 SDK，${result.socs?.length ?? 0} 个 SoC`
    }
    why = `bspd 没读进新站点：${said(reloaded)}`
  } else {
    progress('这个 bspd 还不会重读站点，改为重启它…')
    const failed = await restart(exec, sudo, port, waitSeconds)
    if (!failed) { await keepSite(exec, sudo); return '重启了 bspd，它读了新站点' }
    why = failed
  }
  progress(`${why}；放回原来的站点…`)
  const back = await restoreSite(exec, sudo)
  if (back) throw new SiteSyncError(`${why}；放回原来的站点也失败了：${back}`, 'unknown')
  if (reloads) {
    const again = await ask(exec, sudo, port, 'site_reload')
    throw new SiteSyncError(`${why}；主机上放回了原来的站点${again.ok ? '' : `（bspd 重读它也没成：${said(again)}）`}`)
  }
  const again = await restart(exec, sudo, port, waitSeconds)
  throw new SiteSyncError(`${why}；主机上放回了原来的站点，${again ? `bspd 还是没起来：${again}` : 'bspd 又起来了'}`)
}

/** A lab's way in and bspd port, from its url (`bspd+ssh://user@host:port`, or this machine's `bspd+http://127.0.0.1:port`). */
export function hostOf(url: string | null | undefined): { access: Access, port: number } | null {
  const plain = (url ?? '').replace(/^bspd\+/, '')
  if (!/^(ssh|http):\/\//.test(plain)) return null
  const parsed = new URL(plain)
  const port = Number(parsed.port) || 8765
  if (parsed.protocol === 'http:') return ['127.0.0.1', 'localhost'].includes(parsed.hostname) ? { access: { address: 'localhost' }, port } : null
  return { access: { address: parsed.hostname, user: decodeURIComponent(parsed.username) || undefined }, port }
}

/**
 * Ship a site bundle to one host and have its bspd take it: unpacked beside the host's site, swapped in once bspd is
 * free to take it, and put back when it does not (a `SiteSyncError` says what the host has then). `waitSeconds`: how
 * long a restarted bspd has to answer.
 */
export async function syncHost(hosts: Hosts, url: string | null | undefined, bundle: string, progress: (line: string) => void, waitSeconds = 30): Promise<string> {
  const where = hostOf(url)
  if (!where) throw new SiteSyncError('这台主机还没装好（不知道怎么连它）')
  const exec = await hosts.reach(where.access, progress)
  const sudo = await root(exec)
  await stageSite(exec, sudo, bundle, progress)
  let reloads: boolean
  try { ({ reloads } = await readyFor(exec, sudo, where.port)) }
  catch (error) { await exec.run(`${sudo}rm -rf ${INCOMING}`); throw error }
  await swapSite(exec, sudo)
  return takeSite(exec, sudo, where.port, reloads, progress, waitSeconds)
}

/**
 * `site`: makes the site bundle in the directory given, or says there is none to ship; shipped before bspd starts.
 * `hostTools`: the host tools this distribution carries (host-tools.ts), beside the bsp tree; none when it is absent.
 */
export async function installHost(hosts: Hosts, bspTree: string, setup: HostSetup, token: string | null, progress: (line: string) => void, site?: (dir: string) => Promise<string | null>, hostTools = join(bspTree, '../../host-tools')): Promise<Installed> {
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
    await shipHostTools(exec, sudo, hostTools, facts.stdout.split('\n')[0] ?? '', remote, progress)
    // The network's certificate, if this distribution carries one: put beside the bundle, installed by bspd-install.
    let ca = ''
    if (setup.ca && existsSync(setup.ca)) {
      await exec.put(setup.ca, `${remote}/ca.crt`)
      ca = `--ca '${remote}/ca.crt'`
      progress('带上证书：那台机器装好后信任它')
    }
    const siteBundle = site ? await site(dir) : null
    if (siteBundle) await shipSite(exec, sudo, siteBundle, progress)
    const made = token ?? randomBytes(24).toString('hex')
    const port = setup.port ?? 8765
    progress('在那台机器上装 bspd（第一次要建 Python 环境，几分钟）…')
    // The installer starts each stage with `--> [n/N] <what>`: passed on as `[n/N] <what>` (the page shows step n of N
    // and a bar), and the lines under it carry the stage too, so the lab's busy line stays at the latest stage.
    let stage: string | null = null
    const run = await exec.run(
      `set -e; cd ${remote}; tar -xzf bsp.tgz; ${sudo}bash deploy/bspd-install.sh --id '${setup.id}' --port ${port} --bind 0.0.0.0 --token '${made}' ${setup.board ? `--board '${setup.board}'` : ''} ${ca}; cd /; rm -rf ${remote}`,
      {
        timeoutMs: 1_800_000, onLine: line => {
          if (!line.trim()) return
          const step = /^--> (\[\d+\/\d+\] .+)$/.exec(line.trim())
          if (step) progress(stage = step[1]!)
          else progress(stage && !/^BSPD-READY /.test(line) ? `${stage} · ${line.trim()}` : line)
        },
      })
    const ready = /BSPD-READY (\S+) (\d+) (\S+)/.exec(run.stdout)
    if (run.code !== 0 || !ready) {
      const failed = `装 bspd 失败：${(run.stderr || run.stdout).trim().split('\n').slice(-4).join(' / ')}`
      if (!siteBundle) throw new Error(failed)
      // It may be the new site bspd could not start on: the one the host had goes back, and a bspd that is down
      // starts again on it.
      const back = await restoreSite(exec, sudo)
      if (back) throw new Error(`${failed}；放回原来的站点也失败了：${back}`)
      await exec.run(`if systemctl cat bsp-hostd >/dev/null 2>&1 && ! systemctl is-active -q bsp-hostd; then ${sudo}systemctl restart bsp-hostd; fi`, { timeoutMs: 60_000 })
      throw new Error(`${failed}；主机上放回了原来的站点`)
    }
    if (siteBundle) await keepSite(exec, sudo)
    // This very machine: its loopback port. Another: through an ssh tunnel to its loopback port, as boardd's key gets in.
    const url = exec.local ? `bspd+http://127.0.0.1:${port}` : `bspd+ssh://${exec.target}:${port}`
    return { target: exec.target, port, token: made, version: ready[3]!, url }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

export async function uninstallHost(hosts: Hosts, access: Access, purge: boolean, progress: (line: string) => void): Promise<void> {
  const exec = await hosts.reach(access, progress)
  const sudo = await root(exec)
  const run = await exec.run(`set -e; d=$(mktemp -d); cd $d; if [ -x /opt/bspd/current/app/deploy/bspd-install.sh ]; then ${sudo}bash /opt/bspd/current/app/deploy/bspd-install.sh --uninstall ${purge ? '--purge' : ''}; else echo BSPD-REMOVED; fi`, { timeoutMs: 120_000 })
  if (!/BSPD-REMOVED/.test(run.stdout)) throw new Error(`卸载 bspd 失败：${(run.stderr || run.stdout).trim().split('\n').slice(-3).join(' / ')}`)
}
