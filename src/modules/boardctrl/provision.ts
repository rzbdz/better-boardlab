/**
 * Setting up a boardctrl board host from boardd: reach it over ssh (any way in that works; see the hosts library), ship the
 * boardctrl tree this distribution carries, and run its `deploy/bspd-install.sh`, which makes boardctrld's config from what the
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
/** `noToken`: the host takes every request (no token anywhere), for a lab whose port only trusted machines reach. */
/**
 * `force`: restart the host's bspd even while it runs jobs. Without it, the installer waits for them right before the
 * restart and refuses, naming them, when they outlast its wait; with it, they end `interrupted by a service restart`.
 */
export interface HostSetup { id: string, access: Access, port?: number, board?: string, ca?: string | null, noToken?: boolean, force?: boolean }
/** A host config the site carries (`<site>/hosts/<id>.yaml`): its provider sections are merged into the host's own file. */
export interface SiteHostConfig { id: string, file: string }
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

/**
 * Where a host keeps its site, and what boardd ships into it (its `hosts/` stays the host's own): what its installer
 * writes. A host installed before the names changed keeps its site under `/etc/bsp` until it is installed on again.
 */
export const HOST_SITE = '/etc/boardctrl/site', OLD_SITE = '/etc/bsp/site'
/**
 * The first line of every script that works on the site: `$S` is the host's site (the new place, unless only the old
 * one is there), and `$I` and `$P` beside it — a new site unpacked before it goes in, and the parts the last swap
 * replaced, kept until the host has taken it.
 */
const SITE = `S=${HOST_SITE}; if [ ! -d "$S" ] && [ -d ${OLD_SITE} ]; then S=${OLD_SITE}; fi; I="$S.incoming"; P="$S.previous"`

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

/** Unpack a site bundle (a gzipped tar of `socs/ sdk/ hooks/ duts/ providers/ modules/ .blobs/`) beside the host's site, not in it. */
async function stageSite(exec: Executor, sudo: string, bundle: string, progress: (line: string) => void): Promise<void> {
  const remote = `/tmp/boardlab-site-${randomBytes(4).toString('hex')}`
  progress('传站点过去…')
  await exec.run(`mkdir -p ${remote}`)
  await exec.put(bundle, `${remote}/site.tgz`)
  const failed = await script(exec, sudo, [
    'set -e', SITE, `mkdir -p "$S"`, `rm -rf "$I"`, `mkdir -p "$I"`,
    `tar -xzf ${remote}/site.tgz -C "$I" --no-same-owner`, `rm -rf ${remote}`,
  ], 600_000)
  if (failed) { await exec.run(`${sudo}sh -c '${SITE}; rm -rf "$I" ${remote}'`); throw new SiteSyncError(`放站点到 ${exec.target} 失败：${failed}`) }
}

/**
 * Put the staged site in, each part by rename: `socs/`, `sdk/`, `hooks/`, `duts/`, `providers/` and `modules/` are
 * replaced by the bundle's (gone when it has none), the ones replaced kept beside the site for `restoreSite`;
 * `.blobs/` is added to (images are kept by sha256, and the host may have fetched more); `hosts/` and anything else
 * there is left alone.
 */
async function swapSite(exec: Executor, sudo: string): Promise<void> {
  const failed = await script(exec, sudo, [
    'set -e', SITE, `rm -rf "$P"`, `mkdir -p "$P"`,
    // A part is listed before it is touched, so a swap stopped at any point — the connection dropped, the process
    // killed between two commands — is put back: a part listed but not yet swapped is simply moved back in place.
    `for d in socs sdk hooks duts providers modules; do echo $d >> "$P/.swapped"; if [ -e "$S/$d" ]; then mv "$S/$d" "$P/$d"; fi; if [ -e "$I/$d" ]; then mv "$I/$d" "$S/$d"; fi; done`,
    `if [ -d "$I/.blobs" ]; then mkdir -p "$S/.blobs"; cp -R "$I/.blobs/." "$S/.blobs/"; fi`,
    `rm -rf "$I"`,
  ], 600_000)
  if (!failed) return
  const back = await restoreSite(exec, sudo)
  throw new SiteSyncError(`换上新站点失败：${failed}${back ? `；放回原来的也失败了：${back}` : '；原来的站点放回去了'}`, back ? 'unknown' : 'previous')
}

/** Put back the parts the last swap replaced; what went wrong, or null. */
async function restoreSite(exec: Executor, sudo: string): Promise<string | null> {
  return script(exec, sudo, [
    'set -e', SITE, `rm -rf "$I"`,
    `if [ -f "$P/.swapped" ]; then while read -r d; do rm -rf "$S/$d"; if [ -e "$P/$d" ]; then mv "$P/$d" "$S/$d"; fi; done < "$P/.swapped"; fi`,
    `rm -rf "$P"`,
  ])
}

/** The host has taken the new site: the parts it replaced go. */
async function keepSite(exec: Executor, sudo: string): Promise<void> {
  await exec.run(`${sudo}sh -c '${SITE}; rm -rf "$P"'`)
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
token = os.environ.get("BOARDCTRL_TOKEN") or os.environ.get("BSP_TOKEN", "")
req = urllib.request.Request("http://127.0.0.1:%s%s" % (port, path), data=None if tool in ("health", "tools") else b"{}",
                             headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
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
/**
 * The host's env file, with its token: where its installer writes it, or the old place for a host not installed on
 * since the names changed (that one's service reads both).
 */
const ENV_FILE = '/etc/boardctrl/boardctrld.env', OLD_ENV_FILE = '/etc/bsp/hostd.env'
async function ask(exec: Executor, sudo: string, port: number, tool: string): Promise<Envelope> {
  // The current installer's file, or — on a host not installed on since the names changed — the old place, which the
  // old daemon still reads. Never both: a takeover can leave the old file behind with the token of the install it
  // replaced, and that one authenticates nothing.
  const source = `set -a; if [ -f ${ENV_FILE} ]; then . ${ENV_FILE}; elif [ -f ${OLD_ENV_FILE} ]; then . ${OLD_ENV_FILE}; fi; set +a`
  const run = await exec.run(`${sudo}sh -c '${source}; exec python3 - ${port} ${tool}'`, { stdin: ASK, timeoutMs: 150_000 })
  try { return JSON.parse(run.stdout) as Envelope }
  catch { return { ok: false, error: { code: 'unreachable', message: (run.stderr || run.stdout).trim().split('\n').at(-1) || `退出码 ${run.code}` } } }
}
const said = (envelope: Envelope) => envelope.error?.message ?? '没有回答'

/**
 * Whether the host's bspd reads a new site in place (its tool list has `site_reload`; one too old to is restarted
 * instead). Refused while a board on it is busy or a job runs on it: a new site changes the hooks and SoC facts they
 * use, and the installer cuts a job off when it restarts the daemon.
 *
 * A board being **leased** is not a reason to refuse: a lock and a console live outside the daemon (locks in the
 * state directory, consoles and debug sessions as their own systemd units), so an upgrade keeps them. Only work the
 * daemon itself is doing — a job, a board in the middle of a step — cannot be handed over.
 */
async function readyFor(exec: Executor, sudo: string, port: number): Promise<{ reloads: boolean }> {
  const tools = await ask(exec, sudo, port, 'tools')
  if (!tools.ok || !Array.isArray(tools.tools)) throw new SiteSyncError(`问不到 bspd 会做什么：${said(tools)}`)
  const names = new Set(tools.tools.map(tool => tool.tool_name ?? String(tool.name ?? '').replace(/\./g, '_')))
  const reloads = names.has('site_reload')
  const duts = await ask(exec, sudo, port, 'dut_list')
  if (!duts.ok) throw new SiteSyncError(`问不到 bspd 有没有板子在忙：${said(duts)}`)
  const rows = Array.isArray(duts.result) ? duts.result as Array<{ id?: string, busy?: string | null }> : []
  const busy = rows.filter(dut => dut.busy).map(dut => `${dut.id ?? '?'}：${dut.busy}`)
  if (names.has('job_list')) {
    const jobs = await ask(exec, sudo, port, 'job_list')
    if (!jobs.ok) throw new SiteSyncError(`问不到 bspd 有没有任务在跑：${said(jobs)}`)
    const running = (Array.isArray(jobs.result) ? jobs.result as Array<{ id?: string, title?: string, status?: string }> : []).filter(job => job.status === 'running')
    busy.push(...running.map(job => `任务 ${job.id ?? '?'}${job.title ? `：${job.title}` : ''}`))
  }
  if (busy.length) {
    throw new SiteSyncError(`主机上有板子在忙（${busy.join('、')}），没换站点：等它们做完再同步（重装同样要等，重启会把它正在做的事截断）`)
  }
  return { reloads }
}

/**
 * Whether the staged site carries different provider code than the host runs (`providers/`, or its old `modules/`):
 * providers are loaded when the host starts, so new code is a restart, not a site reload. Their caches do not count.
 */
async function providerCodeChanged(exec: Executor, sudo: string): Promise<boolean> {
  const probe = `digest() { if [ -d "$1" ]; then (cd "$1" && find . -type f ! -path '*/__pycache__/*' ! -name '*.pyc' -print0 | sort -z | xargs -0 -r sha256sum | sha256sum); else echo none; fi; }
[ "$(digest "$S/providers")" = "$(digest "$I/providers")" ] && [ "$(digest "$S/modules")" = "$(digest "$I/modules")" ] && echo SAME || echo CHANGED`
  const run = await exec.run(`${sudo}sh -c '${SITE}; ${probe}'`, { timeoutMs: 300_000 })
  if (run.code !== 0 || !/SAME|CHANGED/.test(run.stdout)) throw new SiteSyncError(`看不出站点的 provider 代码有没有变：${(run.stderr || run.stdout).trim().split('\n').slice(-2).join(' / ') || `退出码 ${run.code}`}`)
  return run.stdout.includes('CHANGED')
}

/**
 * Which unit a host runs bspd as: the new name, or the old one for a host not installed on since the names changed.
 * `$U` is set to it (and nothing else is done) for `systemctl` and `journalctl`.
 */
const UNIT = `U=boardctrld; if ! systemctl cat boardctrld 2>/dev/null && systemctl cat bsp-hostd 2>/dev/null; then U=bsp-hostd; fi`

/** Restart bspd and wait for it to answer; what went wrong when it does not. */
async function restart(exec: Executor, sudo: string, port: number, waitSeconds: number): Promise<string | null> {
  const run = await exec.run(`${sudo}sh -c '${UNIT}; systemctl restart "$U"'`, { timeoutMs: 60_000 })
  if (run.code !== 0) return `重启 bspd 失败：${(run.stderr || run.stdout).trim()}`
  for (let attempt = 0; attempt < waitSeconds; attempt++) {
    if ((await ask(exec, sudo, port, 'health')).ok) return null
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  const journal = await exec.run(`${sudo}sh -c '${UNIT}; journalctl -u "$U" --no-pager -n 5 -o cat 2>/dev/null'`, { timeoutMs: 30_000 })
  const tail = journal.code === 0 ? journal.stdout.trim().split('\n').filter(Boolean).slice(-3).join(' / ') : ''
  return `重启了 bspd，但它 ${waitSeconds} 秒内没起来${tail ? `：${tail}` : ''}`
}

/**
 * Have the host's bspd take the site just swapped in: `site.reload` for the data, and a restart when the provider code
 * changed (modules are read when the host starts) — or, on a bspd too old to reload, a restart for both. When it does
 * not take it, the site it had is put back (and read again, or bspd restarted on it), and what went wrong is the
 * error: a host never keeps a site its bspd refused. Says what it did.
 */
async function takeSite(exec: Executor, sudo: string, port: number, reloads: boolean, newProviders: boolean, progress: (line: string) => void, waitSeconds: number): Promise<string> {
  let why: string
  if (reloads) {
    const reloaded = await ask(exec, sudo, port, 'site_reload')
    if (reloaded.ok) {
      const result = (reloaded.result ?? {}) as { sdks?: string[], socs?: string[] }
      const read = `boardctrld 重新读了站点：${result.sdks?.length ?? 0} 个 SDK，${result.socs?.length ?? 0} 个 SoC`
      // New provider code is new Python: the host has to start again to run it (`site.reload` is data only).
      if (!newProviders) { await keepSite(exec, sudo); return read }
      progress('站点的 provider 代码变了：重启 bspd 让新代码生效…')
      const failed = await restart(exec, sudo, port, waitSeconds)
      if (!failed) { await keepSite(exec, sudo); return `${read}；provider 代码变了，重启了 bspd` }
      why = failed
    } else why = `bspd 没读进新站点：${said(reloaded)}`
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
  let newProviders: boolean
  try {
    ({ reloads } = await readyFor(exec, sudo, where.port))
    // Before the swap: the staged copy is what the host does not run yet. A restart is safe now: readyFor refused
    // while anything was busy, and a leased board loses nothing to one (its lock and console live outside the daemon).
    newProviders = await providerCodeChanged(exec, sudo)
  } catch (error) { await exec.run(`${sudo}sh -c '${SITE}; rm -rf "$I"'`); throw error }
  await swapSite(exec, sudo)
  return takeSite(exec, sudo, where.port, reloads, newProviders, progress, waitSeconds)
}

/**
 * `site`: makes the site bundle in the directory given, or says there is none to ship; shipped before bspd starts.
 * `hostTools`: the host tools this distribution carries (host-tools.ts), beside the boardctrl tree; none when it is absent.
 */
export async function installHost(hosts: Hosts, bspTree: string, setup: HostSetup, token: string | null, progress: (line: string) => void, site?: (dir: string) => Promise<string | null>, hostTools = join(bspTree, '../../host-tools'), siteHosts?: SiteHostConfig | null): Promise<Installed> {
  if (!existsSync(join(bspTree, 'deploy/bspd-install.sh'))) throw new Error(`这个 boardlab 没带 bsp（${bspTree}/deploy/bspd-install.sh 不在）`)
  progress(`连 ${setup.access.address}…`)
  const exec = await hosts.reach(setup.access, progress)
  const sudo = await root(exec)
  const facts = await exec.run('uname -m; tr -d "\\0" < /proc/device-tree/model 2>/dev/null; echo; python3 -V 2>&1')
  progress(`那台机器：${facts.stdout.trim().replace(/\n+/g, '，')}`)
  const dir = mkdtempSync(join(tmpdir(), 'boardlab-boardctrl-'))
  try {
    const bundle = join(dir, 'boardctrl.tgz')
    progress('打包 boardctrl…')
    await tar(bspTree, bundle)
    const remote = `/tmp/boardlab-boardctrl-${randomBytes(4).toString('hex')}`
    progress('传过去…')
    await exec.run(`mkdir -p ${remote}`)
    await exec.put(bundle, `${remote}/boardctrl.tgz`)
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
    // The site's copy of this host's config carries its provider sections (an EC's pins and ports): beside the tree, for
    // the installer to merge into the host's own file.
    let siteHostsArg = ''
    if (siteHosts && existsSync(siteHosts.file)) {
      await exec.run(`mkdir -p ${remote}/site-hosts`)
      await exec.put(siteHosts.file, `${remote}/site-hosts/${siteHosts.id}.yaml`)
      siteHostsArg = `--site-hosts ${remote}/site-hosts`
      progress('带上站点里这台主机的插件配置')
    }
    const made = setup.noToken ? '' : token ?? randomBytes(24).toString('hex')
    const port = setup.port ?? 8765
    progress('在那台机器上装 bspd（第一次要建 Python 环境，几分钟）…')
    // The installer starts each stage with `--> [n/N] <what>`: passed on as `[n/N] <what>` (the page shows step n of N
    // and a bar), and the lines under it carry the stage too, so the lab's busy line stays at the latest stage.
    let stage: string | null = null
    const run = await exec.run(
      `set -e; cd ${remote}; tar -xzf boardctrl.tgz; ${sudo}bash deploy/bspd-install.sh --id '${setup.id}' --port ${port} --bind 0.0.0.0 ${made ? `--token '${made}'` : '--no-token'} ${setup.board ? `--board '${setup.board}'` : ''} ${ca} ${siteHostsArg} ${setup.force === true ? '--force' : ''}; cd /; rm -rf ${remote}`,
      {
        timeoutMs: 1_800_000, onLine: line => {
          if (!line.trim()) return
          const step = /^--> (\[\d+\/\d+\] .+)$/.exec(line.trim())
          if (step) progress(stage = step[1]!)
          else progress(stage && !/^(?:BSPD|BOARDCTRLD)-READY /.test(line) ? `${stage} · ${line.trim()}` : line)
        },
      })
    // `BOARDCTRLD-READY` is what the installer says now; `BSPD-READY` is the same line for older boardds (and older
    // hosts, whose installer only says that).
    const ready = /(?:BOARDCTRLD|BSPD)-READY (\S+) (\d+) (\S+)/.exec(run.stdout)
    if (run.code !== 0 || !ready) {
      const failed = `装 bspd 失败：${(run.stderr || run.stdout).trim().split('\n').slice(-4).join(' / ')}`
      if (!siteBundle) throw new Error(failed)
      // It may be the new site bspd could not start on: the one the host had goes back, and a bspd that is down
      // starts again on it.
      const back = await restoreSite(exec, sudo)
      if (back) throw new Error(`${failed}；放回原来的站点也失败了：${back}`)
      await exec.run(`sh -c '${UNIT}; if systemctl cat "$U" >/dev/null 2>&1 && ! systemctl is-active -q "$U"; then ${sudo}systemctl restart "$U"; fi'`, { timeoutMs: 60_000 })
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
  // The installer where it is installed now, else where it was before the names changed (an older host's tree has
  // the same file under /opt/bspd): either one uninstalls cleanly.
  const run = await exec.run(`set -e; d=$(mktemp -d); cd $d; ` +
    `if [ -x /opt/boardctrl/current/app/deploy/bspd-install.sh ]; then ${sudo}bash /opt/boardctrl/current/app/deploy/bspd-install.sh --uninstall ${purge ? '--purge' : ''}; ` +
    `elif [ -x /opt/bspd/current/app/deploy/bspd-install.sh ]; then ${sudo}bash /opt/bspd/current/app/deploy/bspd-install.sh --uninstall ${purge ? '--purge' : ''}; ` +
    // The installer waits for running jobs first (BOARDCTRL_UPGRADE_WAIT, 600 s by default) and says so line by
    // line: the timeout outlasts that wait, and the lines are the progress.
    `else echo BOARDCTRLD-REMOVED; fi`, { timeoutMs: 900_000, onLine: line => { if (line.trim() && !/(?:BOARDCTRLD|BSPD)-REMOVED/.test(line)) progress(line.trim()) } })
  if (!/(?:BOARDCTRLD|BSPD)-REMOVED/.test(run.stdout)) throw new Error(`卸载 boardctrld 失败：${(run.stderr || run.stdout).trim().split('\n').slice(-3).join(' / ')}`)
}
