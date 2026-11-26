/**
 * Setting up a boardctrl board host from boardd, with ssh and scp faked (scripts on PATH that act on a directory standing in
 * for the remote machine): the ways in are tried in order, a password puts boardd's key there, the boardctrl tree is shipped
 * and its installer run as root, and the lab is pointed at the boardctrld it started.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hosts } from 'boardlab-core/shared/ssh.ts'
import { installHost } from '../src/modules/boardctrl/provision.ts'
import { hostArch, readHostTools } from '../src/modules/boardctrl/host-tools.ts'
import { statePath } from '../src/modules/boardctrl/address.ts'
import { dir, useTempDir } from './fakes.ts'

useTempDir()

/**
 * Fake ssh: `-i <key>` logs in when that key is in the remote's authorized_keys; no key (inherit) never does; a
 * password (SSH_ASKPASS) logs in when it is "opensesame". The command runs with $HOME and / mapped to the remote directory.
 */
function fakeSsh(remote: string) {
  const bin = join(dir, 'bin'); mkdirSync(bin, { recursive: true }); mkdirSync(join(remote, 'root/.ssh'), { recursive: true })
  const log = join(dir, 'ssh.log')
  writeFileSync(join(bin, 'ssh'), `#!/bin/bash
key=""; args=()
while [[ $# -gt 0 ]]; do case $1 in -i) key=$2; shift 2;; -o|-p|-J) shift 2;; -*) shift;; *) args+=("$1"); shift;; esac; done
target=\${args[0]}; cmd=\${args[@]:1}
echo "ssh $target key=\${key:+yes} askpass=\${SSH_ASKPASS:+yes} :: $cmd" >> ${log}
ok=""
if [[ -n $key ]] && grep -qF "$(cat $key.pub)" ${remote}/root/.ssh/authorized_keys 2>/dev/null; then ok=1; fi
if [[ -n $SSH_ASKPASS && "$($SSH_ASKPASS)" == opensesame ]]; then ok=1; fi
if [[ -z $key && -z $SSH_ASKPASS && -n $FAKE_SSH_INHERIT ]]; then ok=1; fi
[[ -n $ok ]] || { echo "Permission denied (publickey,password)." >&2; exit 255; }
# The machine stands in for a remote host, where the login is root: say so whatever runs the tests here.
case "$cmd" in "id -u") echo 0; exit 0 ;; "sudo -n true") exit 0 ;; esac
cd ${remote}; export HOME=${remote}/root
cmd=\${cmd//\\/tmp\\//${remote}/tmp/}
cmd=\${cmd//\\/opt\\//${remote}/opt/}
mkdir -p ${remote}/tmp
bash -c "$cmd"
`)
  writeFileSync(join(bin, 'scp'), `#!/bin/bash
args=(); while [[ $# -gt 0 ]]; do case $1 in -i|-o|-P|-J) shift 2;; -*) shift;; *) args+=("$1"); shift;; esac; done
dest=\${args[1]#*:}; dest=\${dest//\\/tmp\\//${remote}/tmp/}; mkdir -p "$(dirname "$dest")"; cp "\${args[0]}" "$dest"
`)
  for (const name of ['ssh', 'scp']) chmodSync(join(bin, name), 0o755)
  return { bin, log: () => existsSync(log) ? readFileSync(log, 'utf8') : '' }
}

/** A boardctrl tree whose installer only says it is ready (and that it ran as root with the token given), after `steps`. */
function fakeBoardctrlTree(steps = '', ready = 'BSPD-READY $id 8765 f61b6f8') {
  const tree = join(dir, 'boardctrl'); mkdirSync(join(tree, 'deploy'), { recursive: true })
  writeFileSync(join(tree, 'deploy/install.sh'), `#!/bin/bash
id=""; token=""; while [[ $# -gt 0 ]]; do case $1 in --id) id=$2; shift 2;; --token) token=$2; shift 2;; --no-token) echo "no-token"; shift;; *) shift;; esac; done
echo "--> installing $id"; echo "token-len \${#token}"
${steps}
echo "${ready}"
`)
  writeFileSync(join(tree, 'REVISION'), 'f61b6f8\n')
  return tree
}

describe('a machine that had the module under its earlier name', () => {
  it('keeps the site it already has, under the directory the module reads now', () => {
    // boardd's state held the site clone at `bsp/site`: an upgrade must keep serving the site the hosts were synced
    // from, not start a second one beside it.
    mkdirSync(join(dir, 'state', 'bsp', 'site'), { recursive: true })
    mkdirSync(join(dir, 'state', 'bsp', 'site', 'sdk'), { recursive: true })
    expect(statePath(join(dir, 'state'), 'boardctrl')).toBe(join(dir, 'state', 'boardctrl'))
    expect(statePath(join(dir, 'state'), 'boardctrl/site')).toBe(join(dir, 'state', 'boardctrl', 'site'))
    expect(existsSync(join(dir, 'state', 'bsp'))).toBe(false)
    expect(existsSync(join(dir, 'state', 'boardctrl', 'site', 'sdk'))).toBe(true)
    // Once moved, it stays where it is; and a machine that never had the old directory is not given one.
    mkdirSync(join(dir, 'fresh', 'bsp'), { recursive: true })
    expect(statePath(join(dir, 'fresh'), 'boardctrl-holders')).toBe(join(dir, 'fresh', 'boardctrl-holders'))
    expect(statePath(join(dir, 'state'), 'boardctrl/site')).toBe(join(dir, 'state', 'boardctrl', 'site'))
  })
})

describe('setting up a boardctrl board host', () => {
  it('gets in with a password once, puts boardd\'s key there, ships boardctrl and installs boardctrld', async () => {
    const remote = join(dir, 'remote')
    const ssh = fakeSsh(remote)
    process.env.PATH = `${ssh.bin}:${process.env.PATH}`
    const hosts = new Hosts(join(dir, 'state'))
    const lines: string[] = []
    // Without a password nothing gets in, and the error says what was tried.
    await expect(hosts.reach({ address: 'lab-1', user: 'root' })).rejects.toThrow(/boardd 自己的密钥.*继承.*给出密码试试/)
    const done = await installHost(hosts, fakeBoardctrlTree(), { id: 'lab1', access: { address: 'lab-1', user: 'root', password: 'opensesame' } }, null, line => lines.push(line))
    expect(done).toMatchObject({ target: 'root@lab-1', port: 8765, version: 'f61b6f8', url: 'boardctrld+ssh://root@lab-1:8765' })
    expect(done.token).toMatch(/^[0-9a-f]{48}$/)
    expect(lines).toContain('用密码连上了 root@lab-1，放 boardd 的密钥上去')
    expect(lines).toContain('--> installing lab1')
    expect(lines).toContain('token-len 48')
    // boardd's key is there now: the next time gets in with it, no password.
    expect(readFileSync(join(remote, 'root/.ssh/authorized_keys'), 'utf8')).toContain(await hosts.publicKey())
    const again = await hosts.reach({ address: 'lab-1', user: 'root' })
    expect(again.target).toBe('root@lab-1')
    expect(ssh.log().split('\n').filter(line => line.includes('key=yes')).length).toBeGreaterThan(2)
  })

  it('passes the installer\'s stages on as step n of N, the lines under a stage carrying it', async () => {
    const remote = join(dir, 'remote')
    const ssh = fakeSsh(remote)
    process.env.PATH = `${ssh.bin}:${process.env.PATH}`
    const hosts = new Hosts(join(dir, 'state'))
    const lines: string[] = []
    const steps = [
      'echo "--> [1/3] creating the Python environment (a few minutes the first time)"', 'echo "    ... 5s"',
      'echo "--> [2/3] installing boardctrl"', 'echo "    Collecting pyyaml"', 'echo "--> [3/3] checking health"',
    ].join('\n')
    await installHost(hosts, fakeBoardctrlTree(steps), { id: 'lab1', access: { address: 'lab-1', user: 'root', password: 'opensesame' } }, null, line => lines.push(line))
    expect(lines.slice(lines.indexOf('token-len 48'))).toEqual([
      'token-len 48',
      '[1/3] creating the Python environment (a few minutes the first time)',
      '[1/3] creating the Python environment (a few minutes the first time) · ... 5s',
      '[2/3] installing boardctrl',
      '[2/3] installing boardctrl · Collecting pyyaml',
      '[3/3] checking health',
      'BSPD-READY lab1 8765 f61b6f8',
    ])
  })

  it('gets in by this machine\'s own ssh setup and puts boardd\'s key there too', async () => {
    const remote = join(dir, 'remote')
    const ssh = fakeSsh(remote)
    process.env.PATH = `${ssh.bin}:${process.env.PATH}`
    process.env.FAKE_SSH_INHERIT = '1'
    try {
      const hosts = new Hosts(join(dir, 'state'))
      const lines: string[] = []
      const exec = await hosts.reach({ address: 'lab-2', user: 'root' }, line => lines.push(line))
      expect(lines).toEqual(['用这台机器上的 ssh 设置（继承）连上了 root@lab-2', '放好了 boardd 的密钥，以后用它登录'])
      expect(readFileSync(join(remote, 'root/.ssh/authorized_keys'), 'utf8')).toContain(await hosts.publicKey())
      expect((await exec.run('echo hi')).stdout.trim()).toBe('hi')
    } finally { delete process.env.FAKE_SSH_INHERIT }
  })

  it('installs a host that takes every request when asked for no token', async () => {
    const remote = join(dir, 'remote')
    const ssh = fakeSsh(remote)
    process.env.PATH = `${ssh.bin}:${process.env.PATH}`
    const lines: string[] = []
    const done = await installHost(new Hosts(join(dir, 'state')), fakeBoardctrlTree(), { id: 'lab1', access: { address: 'lab-1', user: 'root', password: 'opensesame' }, noToken: true }, null, line => lines.push(line))
    expect(done.token).toBe('')
    expect(lines).toContain('no-token')
    expect(lines).toContain('token-len 0')
  })

  it('restarts a host that runs jobs only when asked to force it, and passes the installer\'s refusal on', async () => {
    const remote = join(dir, 'remote')
    const ssh = fakeSsh(remote)
    process.env.PATH = `${ssh.bin}:${process.env.PATH}`
    const hosts = new Hosts(join(dir, 'state'))
    const access = { address: 'lab-1', user: 'root', password: 'opensesame' }
    // The installer as it is on a host running a flash: it refuses unless forced, naming the job.
    const tree = fakeBoardctrlTree(`force=""; [[ " $ALL " == *" --force "* ]] && force=1
if [[ -z $force ]]; then
  echo "!! jobs still run after 600s of waiting, so not restarting boardctrld (it would cut them off):" >&2
  echo "!!   job flash-1-1 (flash, board board-1): board-1: flash, 700s, 40%" >&2
  echo "!! let them finish or cancel them (\\\`boardctrl job cancel <id>\\\`), then install again; --force goes ahead anyway." >&2
  exit 1
fi
echo "--> --force: restarting boardctrld although these run"`)
    // The fake installer parses its arguments away; keep them all for the check above.
    const script = join(tree, 'deploy/install.sh')
    writeFileSync(script, readFileSync(script, 'utf8').replace('#!/bin/bash\n', '#!/bin/bash\nALL="$*"\n'))
    await expect(installHost(hosts, tree, { id: 'lab1', access }, null, () => {})).rejects.toThrow(/job flash-1-1 .*boardctrl job cancel/)
    expect(ssh.log()).not.toContain('--force')
    const lines: string[] = []
    const done = await installHost(hosts, tree, { id: 'lab1', access, force: true }, null, line => lines.push(line))
    expect(done.version).toBe('f61b6f8')
    expect(ssh.log()).toMatch(/install\.sh .*--force/)
    expect(lines.some(line => line.includes('--force: restarting boardctrld'))).toBe(true)
  })

  it.skipIf(process.getuid?.() !== 0)('installs on this very machine without ssh, and reaches it on its loopback port', async () => {
    const hosts = new Hosts(join(dir, 'state'))
    const done = await installHost(hosts, fakeBoardctrlTree(), { id: 'here', access: { address: 'localhost', user: 'root' } }, 'a'.repeat(48), () => {})
    expect(done).toMatchObject({ target: 'local', url: 'boardctrld+http://127.0.0.1:8765', token: 'a'.repeat(48) })
  })

  it('puts the host tools for the host\'s architecture in the install\'s tools dir, and none when there are none', async () => {
    const remote = join(dir, 'remote')
    const ssh = fakeSsh(remote)
    // The host says it is a riscv64 machine.
    writeFileSync(join(ssh.bin, 'uname'), '#!/bin/bash\n[[ $1 == -m ]] && { echo riscv64; exit 0; }\nexec command -p uname "$@"\n')
    chmodSync(join(ssh.bin, 'uname'), 0o755)
    process.env.PATH = `${ssh.bin}:${process.env.PATH}`
    process.env.FAKE_SSH_INHERIT = '1'
    try {
      const tools = join(dir, 'host-tools')
      const entries = ['amd64', 'riscv64'].map(arch => {
        mkdirSync(join(tools, arch), { recursive: true })
        writeFileSync(join(tools, arch, 'flasher'), `#!/bin/sh\necho ${arch}\n`)
        return { arch, name: 'flasher', sha256: createHash('sha256').update(`#!/bin/sh\necho ${arch}\n`).digest('hex') }
      })
      writeFileSync(join(tools, 'host-tools.json'), JSON.stringify(entries))
      const hosts = new Hosts(join(dir, 'state'))
      const setup = { id: 'lab3', access: { address: 'lab-3', user: 'root' } }
      const lines: string[] = []
      await installHost(hosts, fakeBoardctrlTree(), setup, null, line => lines.push(line), undefined, tools)
      expect(lines).toContain('放主机工具：flasher')
      // The new install's tools dir (the fake host has no old one).
      const shipped = join(remote, 'opt/boardctrl/tools/flasher')
      expect(readFileSync(shipped, 'utf8')).toContain('echo riscv64')
      expect(statSync(shipped).mode & 0o777).toBe(0o755)
      // A host installed before the rename has only the old tools/: they go to the new one, on the service's PATH,
      // and to the old one as well, never to the old one alone.
      rmSync(join(remote, 'opt'), { recursive: true })
      mkdirSync(join(remote, 'opt/bspd/tools'), { recursive: true })
      await installHost(hosts, fakeBoardctrlTree(), setup, null, () => {}, undefined, tools)
      expect(readFileSync(shipped, 'utf8')).toContain('echo riscv64')
      expect(readFileSync(join(remote, 'opt/bspd/tools/flasher'), 'utf8')).toContain('echo riscv64')
      // A file that is not what host-tools.json says does not go.
      rmSync(join(remote, 'opt'), { recursive: true })
      writeFileSync(join(tools, 'riscv64/flasher'), 'something else')
      await expect(installHost(hosts, fakeBoardctrlTree(), setup, null, () => {}, undefined, tools)).rejects.toThrow(/riscv64\/flasher.*sha256/)
      expect(existsSync(join(remote, 'opt/boardctrl/tools'))).toBe(false)
      // Without host-tools/ nothing is put there.
      const quiet: string[] = []
      await installHost(hosts, fakeBoardctrlTree(), setup, null, line => quiet.push(line), undefined, join(dir, 'absent'))
      expect(quiet.some(line => line.includes('主机工具'))).toBe(false)
      expect(existsSync(join(remote, 'opt/boardctrl/tools'))).toBe(false)
    } finally { delete process.env.FAKE_SSH_INHERIT }
  })

  it('ships host tools that match their sha256 in host-tools.json', () => {
    for (const tool of readHostTools(join(import.meta.dirname, '../host-tools'))) {
      expect(createHash('sha256').update(readFileSync(tool.path)).digest('hex')).toBe(tool.sha256)
      expect(statSync(tool.path).mode & 0o111).toBeTruthy()
    }
    expect(['x86_64', 'aarch64', 'riscv64'].map(hostArch)).toEqual(['amd64', 'arm64', 'riscv64'])
  })

  it('refuses addresses that would reach the shell', async () => {
    const hosts = new Hosts(join(dir, 'state'))
    await expect(hosts.reach({ address: 'lab-1; rm -rf /', user: 'root' })).rejects.toThrow(/不合法/)
    await expect(hosts.reach({ address: 'lab-1', user: '$(id)' })).rejects.toThrow(/不合法/)
  })
})

describe('the names before boardctrl', () => {
  it('installs from a tree that prints the new ready line, and from one that prints only the old', async () => {
    const remote = join(dir, 'remote')
    const ssh = fakeSsh(remote)
    process.env.PATH = `${ssh.bin}:${process.env.PATH}`
    const hosts = new Hosts(join(dir, 'state'))
    const access = { address: 'lab-1', user: 'root', password: 'opensesame' }
    const lines: string[] = []
    const now = await installHost(hosts, fakeBoardctrlTree('', 'BOARDCTRLD-READY $id 8765 abc123'), { id: 'lab1', access }, null, line => lines.push(line))
    expect(now.version).toBe('abc123')
    expect(lines).toContain('--> installing lab1')      // the new ready line is not passed on as a stage line
    const older = await installHost(hosts, fakeBoardctrlTree('', 'BSPD-READY $id 8765 def456'), { id: 'lab1', access }, null, () => {})
    expect(older.version).toBe('def456')
  })
})
