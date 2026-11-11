/**
 * Putting the boardlab CLI on another machine (a compile server, a laptop) from boardd, and pointing it at this boardd.
 * boardd reaches the machine over ssh as a normal user (any way in that works; see the hosts library), ships the release
 * it runs itself and runs that release's install.sh there, which as a normal user installs only the CLI, under
 * ~/.local. Then the CLI is set to `ssh://<tunnel>@<hub>`: it reaches boardd through an ssh tunnel to boardd's loopback
 * port, logging in to boardd's machine as the tunnel user with the machine's own ssh key.
 *
 * boardd authorizes that key for the tunnel user itself when it may (it runs as root, or as the tunnel user), only for
 * forwarding to boardd's port (`restrict,port-forwarding,permitopen=…`); otherwise it says what to run.
 */
import { execFile } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DEFAULT_PORT } from 'boardlab-core/shared/client.ts'
import type { Access, Executor, Hosts } from '../hosts/ssh.ts'

/** The release this boardd runs: its directory (VERSION, REVISION, dist/, install.sh). */
export interface Release { root: string, version: string, revision: string }
/** How a CLI elsewhere reaches this boardd: ssh to `address` as `user`, then boardd's loopback `port`. */
export interface Tunnel { address: string, user: string, sshPort?: number, port: number }

/** This machine, as far as authorizing a tunnel key goes. */
export interface Hub {
  /** Who boardd runs as. */
  user: string
  root: boolean
  /** A user's home directory, or null when there is no such user. */
  home(user: string): Promise<string | null>
  /** Make a user that only opens tunnels (root only). */
  addUser(user: string): Promise<void>
  /** Give a directory and what is in it to a user (root only). */
  own(path: string, user: string): Promise<void>
}

const run = (command: string, args: string[]) => new Promise<string>((resolve, reject) =>
  execFile(command, args, { timeout: 30_000 }, (error, stdout, stderr) => error ? reject(new Error((stderr || error.message).trim())) : resolve(stdout)))

export function localHub(): Hub {
  const self = userInfo().username
  return {
    user: self, root: process.getuid?.() === 0,
    async home(user) {
      const line = await run('getent', ['passwd', user]).catch(() => '')
      const home = line.trim().split(':')[5]
      return home || (user === self ? homedir() : null)
    },
    async addUser(user) {
      const shell = ['/usr/sbin/nologin', '/sbin/nologin'].find(path => existsSync(path)) ?? '/bin/false'
      await run('useradd', ['--create-home', '--shell', shell, user])
    },
    async own(path, user) { await run('chown', ['-R', `${user}:`, path]) },
  }
}

const ADDRESS = /^[A-Za-z0-9_.-]+$/
const USER = /^[a-z_][a-z0-9_-]{0,31}$/
const PUBLIC_KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) ([A-Za-z0-9+/]+={0,3})(?:\s|$)/

export function checkTunnel(tunnel: Tunnel) {
  if (!ADDRESS.test(tunnel.address)) throw new Error(`不合法的 boardd 地址：${tunnel.address}`)
  if (!USER.test(tunnel.user)) throw new Error(`不合法的隧道用户：${tunnel.user}`)
}

/** What `boardlab remote set` is given there. */
export function tunnelUrl(tunnel: Tunnel): string {
  return `ssh://${tunnel.user}@${tunnel.address}${tunnel.sshPort && tunnel.sshPort !== 22 ? `:${tunnel.sshPort}` : ''}${tunnel.port !== DEFAULT_PORT ? `?boardd=${tunnel.port}` : ''}`
}

/** A machine's public key as the tunnel user's authorized_keys line: only forwarding to boardd's port, no commands. */
export function tunnelLine(publicKey: string, port: number, comment: string): string {
  const key = PUBLIC_KEY.exec(publicKey.trim())
  if (!key) throw new Error(`读不懂那台机器的公钥：${publicKey.slice(0, 60)}`)
  return `restrict,port-forwarding,permitopen="127.0.0.1:${port}",command="/bin/false" ${key[1]} ${key[2]} ${comment}`
}
export const keyBody = (line: string) => / ((?:ssh|ecdsa|sk)-\S+) ([A-Za-z0-9+/]+={0,3})(?:\s|$)/.exec(` ${line}`)?.[2] ?? null
/** The tunnel line boardd made for machine `id` with key `body`: that key, forwarding only, tagged with the machine. */
const ownLine = (item: string, body: string, id: string) =>
  item.includes('permitopen=') && keyBody(item) === body && item.trimEnd().endsWith(` boardlab-cli:${id}`)

/** How to do it by hand, for whoever may: the commands to run on boardd's machine. */
function byHand(tunnel: string, line: string): string {
  return [
    `id ${tunnel} >/dev/null 2>&1 || sudo useradd --create-home --shell /usr/sbin/nologin ${tunnel}`,
    `sudo -u ${tunnel} -H mkdir -p -m 700 ~${tunnel}/.ssh`,
    `echo '${line}' | sudo -u ${tunnel} -H tee -a ~${tunnel}/.ssh/authorized_keys >/dev/null`,
  ].join('\n')
}

/**
 * Let machine `id`'s key open the tunnel (`line`, from `tunnelLine`). Its own line, made before, is replaced (it may
 * have been for another port); every other line is left as it is, the tunnel user's own and other machines' too, even
 * those with the same key. Returns null when done, else the commands to run by hand.
 */
export async function authorize(hub: Hub, tunnel: string, id: string, line: string, progress: (line: string) => void): Promise<string | null> {
  if (!hub.root && hub.user !== tunnel) return byHand(tunnel, line)
  let home = await hub.home(tunnel)
  if (!home) {
    if (!hub.root) return byHand(tunnel, line)
    progress(`这台机器上没有用户 ${tunnel}：建一个只能开隧道的`)
    await hub.addUser(tunnel)
    home = await hub.home(tunnel)
    if (!home) throw new Error(`建了用户 ${tunnel}，却找不到它的家目录`)
  }
  const dir = join(home, '.ssh'), file = join(dir, 'authorized_keys')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const body = keyBody(line)!
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []
  if (lines.some(item => ownLine(item, body, id))) writeFileSync(file, lines.map(item => ownLine(item, body, id) ? line : item).join('\n'), { mode: 0o600 })
  else appendFileSync(file, `${lines.length && lines.at(-1) !== '' ? '\n' : ''}${line}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  if (hub.root && hub.user !== tunnel) await hub.own(dir, tunnel)
  progress(`给 ${tunnel} 授权了那台机器的密钥（只能转发到 boardd 的端口）`)
  return null
}

/**
 * Take machine `id`'s tunnel line away from the tunnel user: only the line boardd made for it (forwarding only, tagged
 * `boardlab-cli:<id>`), never the tunnel user's own lines or another machine's. `shared`: another machine has the same
 * key, so it is kept when it is the only tunnel line left for that key (one made before lines were per machine).
 * `todo`: what to run by hand, when boardd may not do it.
 */
export async function deauthorize(hub: Hub, tunnel: string, id: string, publicKey: string, shared = false): Promise<{ todo: string | null, kept: boolean }> {
  const body = keyBody(publicKey)
  if (!body) return { todo: null, kept: false }
  if (!hub.root && hub.user !== tunnel) {
    if (shared) return { todo: null, kept: true }
    // The same line, as sed matches it: forwarding only, this key, this machine's tag at the end.
    const pattern = `permitopen=.* [^ ]* ${body} boardlab-cli:${id.replace(/\./g, '\\.')}[[:space:]]*$`
    return { todo: `sudo -u ${tunnel} -H sed -i '\\|${pattern}|d' ~${tunnel}/.ssh/authorized_keys`, kept: false }
  }
  const home = await hub.home(tunnel)
  const file = home && join(home, '.ssh/authorized_keys')
  if (!file || !existsSync(file)) return { todo: null, kept: false }
  const lines = readFileSync(file, 'utf8').split('\n')
  const others = lines.filter(item => item.includes('permitopen=') && keyBody(item) === body && !ownLine(item, body, id))
  if (shared && !others.length) return { todo: null, kept: lines.some(item => ownLine(item, body, id)) }
  writeFileSync(file, lines.filter(item => !ownLine(item, body, id)).join('\n'), { mode: 0o600 })
  return { todo: null, kept: false }
}

// ---------- on the machine ----------

const PREFIX = '$HOME/.local/share/boardlab'
const CLI = '"$HOME/.local/bin/boardlab"'
const FACTS = `echo "uid=$(id -u)"; echo "arch=$(uname -m)"
major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null; }
n=$(command -v node 2>/dev/null || true); [ -n "$n" ] && echo "node=$(major "$n")"
[ -x "${PREFIX}/node/bin/node" ] && echo "ownnode=$(major "${PREFIX}/node/bin/node")"; true`
const STATUS = `d="${PREFIX}/current"; echo "version=$(cat "$d/VERSION" 2>/dev/null)"; echo "revision=$(cat "$d/REVISION" 2>/dev/null)"
c="\${XDG_CONFIG_HOME:-$HOME/.config}"; f="$c/boardlab/remote.json"; [ -f "$f" ] || f="$c/boards/remote.json"
echo "remote=$(tr -d '\\n' < "$f" 2>/dev/null)"; true`
/** The machine's own key for the tunnel: one without a passphrase (the CLI logs in with no one to type it), else made. */
const KEY = `for k in ~/.ssh/id_ed25519 ~/.ssh/id_ecdsa ~/.ssh/id_rsa; do
  [ -s "$k.pub" ] && ssh-keygen -y -P '' -f "$k" >/dev/null 2>&1 && { echo "KEY $(cat "$k.pub")"; exit 0; }
done
if [ ! -e ~/.ssh/id_ed25519 ]; then
  mkdir -p ~/.ssh && chmod 700 ~/.ssh && ssh-keygen -q -t ed25519 -N '' -C "boardlab@$(hostname)" -f ~/.ssh/id_ed25519 && echo "MADE $(cat ~/.ssh/id_ed25519.pub)"; exit 0
fi
for k in ~/.ssh/id_ed25519 ~/.ssh/id_ecdsa ~/.ssh/id_rsa; do [ -s "$k.pub" ] && { echo "LOCKED $(cat "$k.pub")"; exit 0; }; done
echo NONE`

const facts = (text: string) => Object.fromEntries(text.split('\n').map(line => /^([a-z]+)=(.*)$/.exec(line.trim())).filter(Boolean).map(match => [match![1]!, match![2]!]))
const tail = (text: string, lines = 4) => text.trim().split('\n').filter(Boolean).slice(-lines).join(' / ')

/** What is on a machine now. */
export interface Found { version: string | null, revision: string | null, remote: string | null }

async function found(exec: Executor): Promise<Found> {
  const out = facts((await exec.run(STATUS, { timeoutMs: 30_000 })).stdout)
  let remote: string | null = null
  try { remote = (JSON.parse(out.remote || '{}') as { url?: string }).url ?? null } catch {}
  return { version: out.version || null, revision: out.revision || null, remote }
}

/** A normal user on another machine: boardd's own machine, or root, would get boardd itself installed. */
async function normalUser(hosts: Hosts, access: Access, progress: (line: string) => void): Promise<{ exec: Executor, facts: Record<string, string> }> {
  progress(`连 ${access.address}…`)
  const exec = await hosts.reach(access, progress)
  if (exec.local) throw new Error('这是 boardd 自己的机器：这里的命令行随 boardd 装好了')
  const known = facts((await exec.run(FACTS, { timeoutMs: 30_000 })).stdout)
  if (known.uid === '0') throw new Error(`${exec.target} 是 root：命令行要装给普通用户（root 会把 boardd 当服务装上），换一个登录用户`)
  return { exec, facts: known }
}

const tar = (args: string[]) => new Promise<void>((resolve, reject) => execFile('tar', args, { maxBuffer: 1024 * 1024 }, error => error ? reject(error) : resolve()))

export interface Installed extends Found {
  target: string
  /** The machine's public key, as authorized for the tunnel. */
  key: string
  /** `boardlab status` there worked. */
  checked: boolean
  /** Why it is not done yet, and what to do (when not checked). */
  problem: string | null
}

/**
 * Install (or update) the CLI there and point it at this boardd. `node`: a Node binary for machines of `nodeArch`
 * (`uname -m`) that have no Node 24, so they need no internet; others fetch theirs through install.sh.
 */
export async function installCli(hosts: Hosts, hub: Hub, release: Release, setup: { id: string, access: Access, tunnel: Tunnel, node?: { path: string, arch: string } | null }, progress: (line: string) => void): Promise<Installed> {
  checkTunnel(setup.tunnel)
  const { exec, facts: known } = await normalUser(hosts, setup.access, progress)
  progress(`那台机器：${known.arch}，Node ${known.node || '没有'}`)
  const remote = `/tmp/boardlab-cli-${randomBytes(4).toString('hex')}`
  const dir = mkdtempSync(join(tmpdir(), 'boardlab-cli-'))
  try {
    await exec.run(`mkdir -p ${remote}`)
    if (Math.max(Number(known.node) || 0, Number(known.ownnode) || 0) < 24) {
      if (setup.node && setup.node.arch === known.arch) {
        progress(`那台机器上没有 Node 24 以上：传这台 boardd 用的 Node（${process.version}）过去…`)
        await exec.put(setup.node.path, `${remote}/node`)
        const moved = await exec.run(`set -e; mkdir -p "${PREFIX}/node/bin"; mv ${remote}/node "${PREFIX}/node/bin/node"; chmod 755 "${PREFIX}/node/bin/node"`)
        if (moved.code !== 0) throw new Error(`放 Node 失败：${tail(moved.stderr)}`)
        // A Node linked against the libraries of boardd's machine may not run there: then install.sh finds its own.
        const runs = await exec.run(`"${PREFIX}/node/bin/node" -v || { rm -rf "${PREFIX}/node"; exit 1; }`)
        if (runs.code !== 0) progress(`这台 boardd 的 Node 在那台机器上跑不起来（${tail(runs.stderr, 1)}）：install.sh 去下载`)
      } else progress(`那台机器上没有 Node 24 以上，也不是这台 boardd 的架构（${setup.node?.arch ?? '?'}）：install.sh 去下载（那台机器要能上网）`)
    }
    // The release as install.sh takes it: a tarball of boardlab-<version>/.
    progress(`打包 boardlab ${release.version}（${release.revision}）…`)
    const name = `boardlab-${release.version}`
    symlinkSync(release.root, join(dir, name))
    await tar(['-czhf', join(dir, 'boardlab.tar.gz'), '-C', dir, name])
    progress('传过去…')
    await exec.put(join(dir, 'boardlab.tar.gz'), `${remote}/boardlab.tar.gz`)
    await exec.put(join(release.root, 'install.sh'), `${remote}/install.sh`)
    progress('在那台机器上装命令行…')
    const installed = await exec.run(`cd ${remote} && sh install.sh --cli --from ${remote}/boardlab.tar.gz --force; code=$?; cd /; rm -rf ${remote}; exit $code`,
      { timeoutMs: 900_000, onLine: line => { if (line.trim()) progress(line) } })
    if (installed.code !== 0) throw new Error(`装命令行失败：${tail(installed.stderr || installed.stdout)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // Its key, for the tunnel.
  const keyed = (await exec.run(KEY, { timeoutMs: 30_000 })).stdout.trim().split('\n').at(-1) ?? ''
  const [how, ...rest] = keyed.split(' ')
  if (!['KEY', 'MADE', 'LOCKED'].includes(how ?? '')) throw new Error(`那台机器上没有能用的 ssh 密钥，也没能生成一个：${keyed || '没有输出'}`)
  const key = rest.join(' ')
  progress(how === 'MADE' ? '那台机器上没有 ssh 密钥：生成了 ~/.ssh/id_ed25519（没有密码）' : `用那台机器的 ssh 密钥 ${key.split(' ')[0]}`)
  const line = tunnelLine(key, setup.tunnel.port, `boardlab-cli:${setup.id}`)
  const todo = await authorize(hub, setup.tunnel.user, setup.id, line, progress)

  const url = tunnelUrl(setup.tunnel)
  progress(`设成连这台 boardd：boardlab remote set ${url}`)
  // Saved even when the tunnel does not work yet: it works once the key is authorized.
  const set = await exec.run(`${CLI} remote set '${url}'`, { timeoutMs: 60_000, onLine: line => { if (line.trim()) progress(line) } })
  const now = await found(exec)
  const result = (problem: string | null, checked = false): Installed => ({ ...now, target: exec.target, key, checked, problem })
  if (todo) return result(`命令行装好了，也设好了连 ${url}，但这台 boardd 不能自己授权它的密钥（${hub.user !== setup.tunnel.user ? `boardd 不是 root，也不是 ${setup.tunnel.user}` : `找不到 ${setup.tunnel.user} 的家目录`}）。在 boardd 的机器上运行：\n${todo}\n然后在那台机器上 boardlab status 试试`)
  if (set.code !== 0) {
    const why = tail(set.stderr || set.stdout, 2)
    if (how === 'LOCKED') return result(`那台机器的 ssh 密钥有密码，boardd 在那边用不了它（${why}）。在那台机器上把密钥加进 ssh-agent，或者生成一个没有密码的 ~/.ssh/id_ed25519 再更新`)
    return result(`那台机器连不上这台 boardd（${why}）：看看它能不能 ssh 到 ${setup.tunnel.address}${setup.tunnel.sshPort ? `:${setup.tunnel.sshPort}` : ''}，这台机器的 sshd 允不允许 ${setup.tunnel.user} 登录和 TCP 转发（AllowTcpForwarding）`)
  }
  progress('检查：boardlab status')
  const status = await exec.run(`${CLI} status`, { timeoutMs: 60_000, onLine: line => { if (line.trim()) progress(line) } })
  if (status.code !== 0) return result(`boardlab status 在那台机器上失败：${tail(status.stderr || status.stdout)}`)
  return result(null, true)
}

/**
 * What is installed there, and whether boardd gets in at all (with no password: boardd's key or this machine's ssh).
 * With `tunnel`, and a CLI there, `boardlab status` is run too: `problem` is why it failed, null when it worked
 * (undefined: not tried).
 */
export async function checkCli(hosts: Hosts, access: Access, tunnel = false): Promise<Found & { problem?: string | null }> {
  const exec = await hosts.reach({ ...access, password: undefined })
  const now = await found(exec)
  if (!tunnel || !now.version) return now
  const status = await exec.run(`${CLI} status`, { timeoutMs: 20_000 })
  return { ...now, problem: status.code === 0 ? null : `boardlab status 在那台机器上失败：${tail(status.stderr || status.stdout) || `退出码 ${status.code}`}` }
}

/**
 * Take the CLI's configuration away there (it then uses that machine's own boardd, which it has none of), and with
 * `uninstall` the CLI too; then boardd's own key, so boardd no longer gets in.
 */
export async function removeCli(hosts: Hosts, access: Access, uninstall: boolean, progress: (line: string) => void): Promise<void> {
  const { exec } = await normalUser(hosts, access, progress)
  const cleared = await exec.run(`if [ -x ${CLI} ]; then ${CLI} remote clear; fi`, { timeoutMs: 30_000 })
  if (cleared.code !== 0) throw new Error(`清不掉那台机器上的连接设置：${tail(cleared.stderr || cleared.stdout)}`)
  progress('那台机器上的命令行不再连这台 boardd')
  if (uninstall) {
    const removed = await exec.run(`if [ -f "${PREFIX}/install.sh" ]; then sh "${PREFIX}/install.sh" --uninstall; fi`, { timeoutMs: 120_000 })
    if (removed.code !== 0) throw new Error(`卸载命令行失败：${tail(removed.stderr || removed.stdout)}`)
    progress('卸掉了那台机器上的命令行')
  }
  const ours = await hosts.publicKey()
  await exec.run(`f=~/.ssh/authorized_keys; [ -f $f ] && grep -vF '${ours}' $f > $f.boardlab; [ -f $f.boardlab ] && cat $f.boardlab > $f; rm -f $f.boardlab; true`, { timeoutMs: 30_000 })
  progress('拿掉了 boardd 的密钥')
}
