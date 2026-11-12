/**
 * Installing the boardlab CLI on other machines from boardd, with ssh and scp faked (scripts on PATH that act on a
 * directory standing in for the machine, as a normal user) and boardd's machine faked (where the tunnel user's
 * authorized_keys is): the release boardd runs is shipped and its installer run as that user, the machine's key is
 * authorized for the tunnel, the CLI is pointed at this boardd and `boardlab status` checked there.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EventStream } from 'boardlab-core/core/api.ts'
import { openDatabase } from 'boardlab-core/core/db.ts'
import { BoardLab } from 'boardlab-core/core/lab.ts'
import { Hosts } from '../src/modules/hosts/ssh.ts'
import { clients, releaseAt, type ClientsView } from '../src/modules/clients/index.ts'
import { authorize, deauthorize, tunnelLine, type Hub } from '../src/modules/clients/install.ts'
import { ui } from '../src/modules/clients/ui.ts'
import { dir, useTempDir } from './fakes.ts'

useTempDir()

/**
 * Fake ssh as in provision.spec.ts: `-i <key>` gets in when that key is in the machine's authorized_keys, a password
 * when it is "opensesame". Commands run with $HOME the machine's home, /tmp/ mapped into it, and `id -u` saying
 * $FAKE_UID (1000 by default); with $FAKE_OLD_NODE its `node` is a Node 10.
 */
function fakeMachine() {
  const remote = join(dir, 'machine'), bin = join(dir, 'bin'), tools = join(remote, 'bin')
  for (const path of [bin, tools, join(remote, 'home/.ssh'), join(remote, 'tmp')]) mkdirSync(path, { recursive: true })
  const log = join(dir, 'ssh.log')
  writeFileSync(join(tools, 'id'), '#!/bin/sh\n[ "$1" = -u ] && { echo "${FAKE_UID:-1000}"; exit 0; }; exec /usr/bin/id "$@"\n')
  writeFileSync(join(remote, 'old-node'), '#!/bin/sh\necho 10\n')
  writeFileSync(join(bin, 'ssh'), `#!/bin/bash
key=""; args=()
while [[ $# -gt 0 ]]; do case $1 in -i) key=$2; shift 2;; -o|-p|-J) shift 2;; -*) shift;; *) args+=("$1"); shift;; esac; done
target=\${args[0]}; cmd=\${args[@]:1}
echo "ssh $target key=\${key:+yes} askpass=\${SSH_ASKPASS:+yes} :: $cmd" >> ${log}
ok=""
if [[ -n $FAKE_DOWN ]]; then echo "ssh: connect to host: Connection timed out" >&2; exit 255; fi
if [[ -n $key ]] && grep -qF "$(cat $key.pub)" ${remote}/home/.ssh/authorized_keys 2>/dev/null; then ok=1; fi
if [[ -n $SSH_ASKPASS && "$($SSH_ASKPASS)" == opensesame ]]; then ok=1; fi
[[ -n $ok ]] || { echo "Permission denied (publickey,password)." >&2; exit 255; }
cd ${remote}; export HOME=${remote}/home XDG_CONFIG_HOME=${remote}/home/.config PATH=${tools}:$PATH
[[ -n $FAKE_OLD_NODE ]] && cp ${remote}/old-node ${tools}/node && chmod 755 ${tools}/node
cmd=\${cmd//\\/tmp\\//${remote}/tmp/}
bash -c "$cmd"
`)
  writeFileSync(join(bin, 'scp'), `#!/bin/bash
args=(); while [[ $# -gt 0 ]]; do case $1 in -i|-o|-P|-J) shift 2;; -*) shift;; *) args+=("$1"); shift;; esac; done
dest=\${args[1]#*:}; dest=\${dest//\\/tmp\\//${remote}/tmp/}; mkdir -p "$(dirname "$dest")"; cp "\${args[0]}" "$dest"
`)
  for (const file of [join(bin, 'ssh'), join(bin, 'scp'), join(tools, 'id'), join(remote, 'old-node')]) chmodSync(file, 0o755)
  process.env.PATH = `${bin}:${process.env.PATH}`
  const home = join(remote, 'home')
  return { home, log: () => existsSync(log) ? readFileSync(log, 'utf8') : '', file: (path: string) => join(home, path) }
}

/**
 * A release as an installed boardd has it: its installer does what install.sh does for a normal user (the CLI under
 * ~/.local), and its CLI's `remote set` and `status` work when the machine's key may open the tunnel to port 38127
 * (the line in $FAKE_HUB_KEYS).
 */
function fakeRelease(version = '0.3.0', revision = 'abc1234') {
  const root = join(dir, 'opt/boardlab/releases', `${version}-${revision}`)
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'VERSION'), `${version}\n`); writeFileSync(join(root, 'REVISION'), `${revision}\n`)
  writeFileSync(join(root, 'dist/cli.js'), '')
  writeFileSync(join(root, 'install.sh'), `#!/bin/sh
set -eu
FROM="" UNINSTALL="" CLI=""
while [ $# -gt 0 ]; do case $1 in --cli) CLI=1; shift ;; --from) FROM=$2; shift 2 ;; --uninstall) UNINSTALL=1; shift ;; *) shift ;; esac; done
P=$HOME/.local/share/boardlab B=$HOME/.local/bin
if [ -n "$UNINSTALL" ]; then rm -rf "$P" "$B/boardlab"; echo "==> boardlab removed"; exit 0; fi
[ -n "$CLI" ] || { echo "!! not --cli" >&2; exit 1; }
[ -z "\${FAKE_INSTALL_FAIL:-}" ] || { echo "!! could not fetch Node v24.13.0" >&2; exit 1; }
T=$(mktemp -d); tar -xzf "$FROM" -C "$T"; D=$(ls -d "$T"/boardlab-* | head -1); V=$(cat "$D/VERSION"); R=$(cat "$D/REVISION")
echo "==> installing boardlab $V ($R) in $P"
mkdir -p "$P/releases" "$B"; rm -rf "$P/releases/$V-$R"; mv "$D" "$P/releases/$V-$R"; rm -f "$P/current"; ln -s "releases/$V-$R" "$P/current"
cp "$P/current/install.sh" "$P/install.sh"; cp "$P/current/cli" "$B/boardlab"; chmod 755 "$B/boardlab"
`)
  writeFileSync(join(root, 'cli'), `#!/bin/bash
conf=\${XDG_CONFIG_HOME:-$HOME/.config}/boardlab/remote.json
tunnel() { k=$(cut -d' ' -f2 ~/.ssh/id_ed25519.pub); grep -F "$k" "$FAKE_HUB_KEYS" 2>/dev/null | grep -qF 'permitopen="127.0.0.1:38127"' || { echo "ssh 失败：Permission denied (publickey)." >&2; return 1; }; }
case "$1 $2" in
  "remote set") mkdir -p "$(dirname "$conf")"; printf '{"url":"%s"}' "$3" > "$conf"; tunnel || exit 1; echo "已连上 $3：2 块板子，你是 user:dev" ;;
  "remote clear") printf '{}' > "$conf"; echo "已改回本机的 boardd" ;;
  "status ") tunnel || exit 1; echo "boardd   $(cat "$conf")"; echo "板子     2 块" ;;
  *) exit 2 ;;
esac
`)
  return root
}

/** boardd's machine: boardd as root (or not), the tunnel user made on demand, its home under the test directory. */
function fakeHub(root = true) {
  const homes: Record<string, string> = {}, made: string[] = [], owned: string[] = []
  const hub: Hub = {
    user: root ? 'root' : 'alice', root,
    home: async user => homes[user] ?? null,
    addUser: async user => { made.push(user); homes[user] = join(dir, 'hub', user); mkdirSync(homes[user]!, { recursive: true }) },
    own: async (path, user) => { owned.push(`${user} ${path}`) },
  }
  process.env.FAKE_HUB_KEYS = join(dir, 'hub/boardlab/.ssh/authorized_keys')
  return { hub, made, owned, keys: () => existsSync(process.env.FAKE_HUB_KEYS!) ? readFileSync(process.env.FAKE_HUB_KEYS!, 'utf8') : '' }
}

function makeLab(options: { hub: Hub, release?: string | null, node?: { path: string, arch: string } | null }) {
  const hosts = new Hosts(join(dir, 'state'))
  const lab = new BoardLab({
    db: openDatabase(join(dir, 'b.sqlite')),
    modules: [clients({ stateDir: join(dir, 'state'), release: options.release === null ? null : releaseAt(options.release ?? fakeRelease()), hosts, machine: options.hub, node: options.node })],
  })
  return { lab, hosts }
}

async function call(lab: BoardLab, method: 'GET' | 'POST', path: string, body: Record<string, unknown> = {}): Promise<any> {
  const found = lab.api.match(method, path)
  if (!found) throw new Error(`no ${method} ${path}`)
  return found.endpoint.handle({ query: new URLSearchParams(), params: found.params, body, caller: { holder: 'user:alice', local: true }, signal: new AbortController().signal } as never)
}

/** An event-stream endpoint run to its end: its `out` lines and its `exit`. */
async function install(lab: BoardLab, body: Record<string, unknown>) {
  const reply = await call(lab, 'POST', '/api/clients/install', body) as EventStream
  const lines: string[] = []
  let exit: { ok: boolean, message: string } | null = null
  await new Promise<void>(resolve => reply.start((event, data) => {
    if (event === 'out') lines.push((data as { text: string }).text)
    if (event === 'exit') exit = data as typeof exit
  }, resolve, new AbortController().signal))
  return { lines, exit: exit! }
}

const env = (values: Record<string, string>) => { for (const [key, value] of Object.entries(values)) process.env[key] = value; return () => { for (const key of Object.keys(values)) delete process.env[key] } }

describe('installing the CLI on a compile machine', () => {
  it('installs as the user, authorizes its key for the tunnel, points the CLI here and checks boardlab status', async () => {
    const machine = fakeMachine(), boardd = fakeHub()
    const { lab, hosts } = makeLab({ hub: boardd.hub })
    const done = await install(lab, { id: 'build1', address: 'build1.example.test', user: 'dev', password: 'opensesame', hub: 'boardd.example.test' })
    expect(done.exit).toMatchObject({ ok: true, message: '装好了：build1 上的 boardlab 0.3.0（abc1234）连上了这台 boardd' })
    expect(done.lines).toEqual(expect.arrayContaining([
      '用密码连上了 dev@build1.example.test，放 boardd 的密钥上去', '在那台机器上装命令行…', '==> installing boardlab 0.3.0 (abc1234) in ' + machine.file('.local/share/boardlab'),
      '那台机器上没有 ssh 密钥：生成了 ~/.ssh/id_ed25519（没有密码）', '这台机器上没有用户 boardlab：建一个只能开隧道的',
      '给 boardlab 授权了那台机器的密钥（只能转发到 boardd 的端口）', '设成连这台 boardd：boardlab remote set ssh://boardlab@boardd.example.test',
      '检查：boardlab status', '板子     2 块',
    ]))
    // The machine's own key, for forwarding to boardd's port only, given to the tunnel user boardd made.
    const key = readFileSync(machine.file('.ssh/id_ed25519.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ')
    expect(boardd.keys().trim()).toBe(`restrict,port-forwarding,permitopen="127.0.0.1:38127",command="/bin/false" ${key} boardlab-cli:build1`)
    expect(boardd.made).toEqual(['boardlab'])
    expect(boardd.owned).toEqual([`boardlab ${join(dir, 'hub/boardlab/.ssh')}`])
    expect(JSON.parse(readFileSync(machine.file('.config/boardlab/remote.json'), 'utf8'))).toEqual({ url: 'ssh://boardlab@boardd.example.test' })
    expect(readFileSync(machine.file('.ssh/authorized_keys'), 'utf8')).toContain(await hosts.publicKey())

    const view = await call(lab, 'GET', '/api/clients') as ClientsView
    expect(view.hub).toMatchObject({ address: 'boardd.example.test', tunnel: 'boardlab', url: 'ssh://boardlab@boardd.example.test' })
    expect(view.machines).toEqual([expect.objectContaining({ id: 'build1', user: 'dev', busy: false, status: expect.objectContaining({ reachable: true, version: '0.3.0', revision: 'abc1234', remote: 'ssh://boardlab@boardd.example.test', error: null }) })])
    expect((lab.state('user:alice') as unknown as { clients: ClientsView }).clients.machines).toHaveLength(1)

    // Updating needs no password now, and keeps one tunnel line for the key.
    const again = await install(lab, { id: 'build1' })
    expect(again.exit.ok).toBe(true)
    expect(again.lines).toContain('用boardd 自己的密钥连上了 dev@build1.example.test')
    expect(boardd.keys().trim().split('\n')).toHaveLength(1)
    expect(machine.log()).not.toMatch(/askpass=yes.*remote set/)
  })

  it('says what to run on boardd\'s machine when boardd may not authorize the key itself', async () => {
    const machine = fakeMachine(), boardd = fakeHub(false)
    const { lab } = makeLab({ hub: boardd.hub })
    // boardd runs as alice; machines are to come in as a tunnel user of their own.
    expect((await call(lab, 'GET', '/api/clients') as ClientsView).hub.tunnel).toBe('alice')
    expect((await call(lab, 'POST', '/api/clients/settings', { tunnel: 'boardlab' }) as ClientsView).hub.tunnel).toBe('boardlab')
    const done = await install(lab, { address: 'build2.example.test', user: 'dev', password: 'opensesame', hub: 'boardd.example.test' })
    expect(done.exit.ok).toBe(false)
    expect(done.exit.message).toMatch(/boardd 不是 root，也不是 boardlab/)
    expect(done.exit.message).toContain('sudo -u boardlab -H tee -a ~boardlab/.ssh/authorized_keys')
    expect(done.exit.message).toContain('restrict,port-forwarding,permitopen="127.0.0.1:38127"')
    // The CLI is set up all the same: it works once the key is authorized.
    expect(JSON.parse(readFileSync(machine.file('.config/boardlab/remote.json'), 'utf8')).url).toBe('ssh://boardlab@boardd.example.test')
    const view = await call(lab, 'GET', '/api/clients') as ClientsView
    expect(view.machines[0]).toMatchObject({ id: 'build2.example.test', status: { version: '0.3.0', error: expect.stringMatching(/不能自己授权/) } })

    // A check does not take the problem for solved while the tunnel still does not work…
    let checked = await call(lab, 'POST', '/api/clients/check', {}) as ClientsView
    expect(checked.machines[0]!.status).toMatchObject({ reachable: true, error: expect.stringMatching(/boardlab status 在那台机器上失败：.*Permission denied/) })
    // …and clears it once it does (someone ran the commands).
    const line = /echo '([^']*)'/.exec(done.exit.message)![1]!
    mkdirSync(join(dir, 'hub/boardlab/.ssh'), { recursive: true })
    writeFileSync(process.env.FAKE_HUB_KEYS!, `${line}\n`)
    checked = await call(lab, 'POST', '/api/clients/check', {}) as ClientsView
    expect(checked.machines[0]!.status).toMatchObject({ reachable: true, error: null })
    expect(machine.log().match(/boardlab" status/g)).toHaveLength(2)
    await call(lab, 'POST', '/api/clients/check', {})
    expect(machine.log().match(/boardlab" status/g)).toHaveLength(2)
  })

  it('gives a machine with an old Node the Node boardd runs on, so it needs no internet', async () => {
    const machine = fakeMachine(), boardd = fakeHub()
    const node = join(dir, 'node'); writeFileSync(node, '#!/bin/sh\necho v24.13.0\n', { mode: 0o755 })
    const { lab } = makeLab({ hub: boardd.hub, node: { path: node, arch: (await import('node:child_process')).execSync('uname -m').toString().trim() } })
    const restore = env({ FAKE_OLD_NODE: '1' })
    try {
      const done = await install(lab, { address: 'old.example.test', user: 'dev', password: 'opensesame', hub: 'boardd.example.test' })
      expect(done.exit.ok).toBe(true)
      expect(done.lines.some(line => line.startsWith('那台机器上没有 Node 24 以上：传这台 boardd 用的 Node'))).toBe(true)
      expect(readFileSync(machine.file('.local/share/boardlab/node/bin/node'), 'utf8')).toContain('v24.13.0')
    } finally { restore() }
  })

  it('refuses what would not be a CLI for a normal user, and says why an install failed', async () => {
    fakeMachine()
    const boardd = fakeHub()
    const fromSource = makeLab({ hub: boardd.hub, release: null })
    await expect(call(fromSource.lab, 'POST', '/api/clients/install', { address: 'a.example.test', user: 'dev', hub: 'boardd.example.test' })).rejects.toThrow(/从源码跑的/)
    const { lab } = makeLab({ hub: boardd.hub })
    await expect(call(lab, 'POST', '/api/clients/install', { address: 'a.example.test', user: 'root', hub: 'boardd.example.test' })).rejects.toThrow(/不能是 root/)
    await expect(call(lab, 'POST', '/api/clients/install', { address: 'a.example.test', user: 'dev' })).rejects.toThrow(/这台 boardd 的地址/)
    await expect(call(lab, 'POST', '/api/clients/install', { address: 'a.example.test', user: 'dev', hub: 'boardd; rm -rf /' })).rejects.toThrow(/不合法/)
    expect((await install(lab, { address: 'b.example.test', user: 'dev', hub: 'boardd.example.test' })).exit.message).toMatch(/连不上 dev@b.example.test.*给出密码试试/)

    let restore = env({ FAKE_UID: '0' })
    try { expect((await install(lab, { address: 'a.example.test', user: 'admin', password: 'opensesame', hub: 'boardd.example.test' })).exit.message).toMatch(/是 root：命令行要装给普通用户/) } finally { restore() }
    restore = env({ FAKE_INSTALL_FAIL: '1' })
    try { expect((await install(lab, { address: 'a.example.test', user: 'dev', hub: 'boardd.example.test' })).exit).toEqual({ ok: false, message: '装命令行失败：!! could not fetch Node v24.13.0' }) } finally { restore() }
  })

  it('checks what each machine has, cheaply, and says when one is unreachable', async () => {
    fakeMachine()
    const boardd = fakeHub()
    const { lab } = makeLab({ hub: boardd.hub })
    await install(lab, { id: 'build1', address: 'build1.example.test', user: 'dev', password: 'opensesame', hub: 'boardd.example.test' })
    let view = await call(lab, 'POST', '/api/clients/check', { id: 'build1' }) as ClientsView
    expect(view.machines[0]!.status).toMatchObject({ reachable: true, version: '0.3.0', remote: 'ssh://boardlab@boardd.example.test' })
    const restore = env({ FAKE_DOWN: '1' })
    try { view = await call(lab, 'POST', '/api/clients/check', {}) as ClientsView } finally { restore() }
    // What was found before stays, with why it could not be checked now.
    expect(view.machines[0]!.status).toMatchObject({ reachable: false, version: '0.3.0', error: expect.stringMatching(/连不上 dev@build1.example.test/) })
  })

  it('removes a machine: its CLI no longer comes here, the tunnel key and boardd\'s key are taken away', async () => {
    const machine = fakeMachine(), boardd = fakeHub()
    const { lab, hosts } = makeLab({ hub: boardd.hub })
    await install(lab, { id: 'build1', address: 'build1.example.test', user: 'dev', password: 'opensesame', hub: 'boardd.example.test' })
    const result = await call(lab, 'POST', '/api/clients/remove', { id: 'build1', uninstall: true })
    expect(result.message).toBe('删除了 build1：卸掉了那台机器上的命令行；收回了它的隧道授权')
    expect(readFileSync(machine.file('.config/boardlab/remote.json'), 'utf8')).toBe('{}')
    expect(existsSync(machine.file('.local/bin/boardlab'))).toBe(false)
    expect(boardd.keys().trim()).toBe('')
    expect(readFileSync(machine.file('.ssh/authorized_keys'), 'utf8')).not.toContain(await hosts.publicKey())
    expect((await call(lab, 'GET', '/api/clients') as ClientsView).machines).toEqual([])
  })
})

describe('the tunnel user\'s authorized_keys', () => {
  const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK0+tunnel/key=='
  const own = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK0+tunnel/key== dev@laptop'
  const other = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ+other someone@else'

  it('touches only the line made for that machine, never the user\'s own or another machine\'s with the same key', async () => {
    const boardd = fakeHub()
    await boardd.hub.addUser('boardlab')
    const file = join(dir, 'hub/boardlab/.ssh/authorized_keys')
    mkdirSync(join(dir, 'hub/boardlab/.ssh'), { recursive: true })
    writeFileSync(file, `${own}\n${other}\n`)
    // Two machines with one key (a home directory shared between them): a line each, the user's own login kept.
    await authorize(boardd.hub, 'boardlab', 'build1', tunnelLine(KEY, 38127, 'boardlab-cli:build1'), () => {})
    await authorize(boardd.hub, 'boardlab', 'build.2', tunnelLine(KEY, 38127, 'boardlab-cli:build.2'), () => {})
    await authorize(boardd.hub, 'boardlab', 'build1', tunnelLine(KEY, 40000, 'boardlab-cli:build1'), () => {})   // its own line, for another port
    const lines = () => boardd.keys().split('\n').filter(Boolean)
    expect(lines()).toEqual([own, other, tunnelLine(KEY, 40000, 'boardlab-cli:build1'), tunnelLine(KEY, 38127, 'boardlab-cli:build.2')])
    // Removing one leaves the other's line and the user's own.
    expect(await deauthorize(boardd.hub, 'boardlab', 'build1', KEY, true)).toEqual({ todo: null, kept: false })
    expect(lines()).toEqual([own, other, tunnelLine(KEY, 38127, 'boardlab-cli:build.2')])
    // A line another machine with that key may still come in by (made before there was one per machine) stays.
    writeFileSync(file, `${own}\n${tunnelLine(KEY, 38127, 'boardlab-cli:build.2')}\n`)
    expect(await deauthorize(boardd.hub, 'boardlab', 'build.2', KEY, true)).toEqual({ todo: null, kept: true })
    expect(lines()).toHaveLength(2)
    expect(await deauthorize(boardd.hub, 'boardlab', 'build.2', KEY)).toEqual({ todo: null, kept: false })
    expect(lines()).toEqual([own])
  })

  it('prints a command to run by hand that removes only that machine\'s line', async () => {
    const { hub } = fakeHub(false)
    const { todo } = await deauthorize(hub, 'boardlab', 'build.2', KEY)
    const sed = /sed -i '(.*)' ~boardlab\/\.ssh\/authorized_keys$/.exec(todo ?? '')?.[1]
    expect(sed).toBeTruthy()
    const before = [own, tunnelLine(KEY, 38127, 'boardlab-cli:build1'), tunnelLine(KEY, 38127, 'boardlab-cli:build.2'), tunnelLine(KEY, 38127, 'boardlab-cli:buildx2'), other].join('\n')
    const after = execFileSync('sed', [sed!], { input: `${before}\n`, encoding: 'utf8' }).trim().split('\n')
    expect(after).toEqual([own, tunnelLine(KEY, 38127, 'boardlab-cli:build1'), tunnelLine(KEY, 38127, 'boardlab-cli:buildx2'), other])
    expect(await deauthorize(hub, 'boardlab', 'build.2', KEY, true)).toEqual({ todo: null, kept: true })
  })
})

describe('the CLI machines on the page', () => {
  const clientsView = (machines: ClientsView['machines']): ClientsView => ({
    hub: { address: 'boardd.example.test', tunnel: 'boardlab', sshPort: null, port: 38127, url: 'ssh://boardlab@boardd.example.test' },
    release: { version: '0.3.0', revision: 'abc1234' }, machines,
  })
  const status = (version: string | null, revision: string | null, extra = {}) => ({ reachable: true, version, revision, remote: 'ssh://boardlab@boardd.example.test', checkedAt: '2026-11-11T00:00:00Z', error: null, ...extra })
  const machine = (id: string, s: ReturnType<typeof status>) => ({ id, address: `${id}.example.test`, user: 'dev', addedAt: '', addedBy: '', status: s, busy: false })

  it('shows each machine\'s version against this boardd\'s', () => {
    const views = ui.views({ clients: clientsView([machine('a', status('0.3.0', 'abc1234')), machine('b', status('0.2.0', 'old0000')), machine('c', status(null, null, { reachable: false }))]) } as never, {})
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({ id: 'cli-machines', slot: 'settings', title: '客户端配置', help: 'clients', status: { tone: 'warn', text: '3 台' } })
    const list = views[0]!.body.find(element => element.kind === 'list') as { items: Array<{ key: string, status: { text: string } }> }
    expect(list.items.map(item => [item.key, item.status.text])).toEqual([['a', '0.3.0'], ['b', '旧版 0.2.0'], ['c', '连不上']])
    expect(ui.views({} as never, {})).toEqual([])
  })
})
