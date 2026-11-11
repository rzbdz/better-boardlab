/**
 * Setting up a bsp board host from boardd, with ssh and scp faked (scripts on PATH that act on a directory standing in
 * for the remote machine): the ways in are tried in order, a password puts boardd's key there, the bsp tree is shipped
 * and its installer run as root, and the lab is pointed at the bspd it started.
 */
import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hosts } from '../src/modules/hosts/ssh.ts'
import { installHost } from '../src/modules/bsp/provision.ts'
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
[[ -n $ok ]] || { echo "Permission denied (publickey,password)." >&2; exit 255; }
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

/** A bsp tree whose installer only says it is ready (and that it ran as root with the token given). */
function fakeBspTree() {
  const tree = join(dir, 'bsp'); mkdirSync(join(tree, 'deploy'), { recursive: true })
  writeFileSync(join(tree, 'deploy/bspd-install.sh'), `#!/bin/bash
id=""; token=""; while [[ $# -gt 0 ]]; do case $1 in --id) id=$2; shift 2;; --token) token=$2; shift 2;; *) shift;; esac; done
echo "--> installing $id"; echo "token-len \${#token}"; echo "BSPD-READY $id 8765 f61b6f8"
`)
  writeFileSync(join(tree, 'REVISION'), 'f61b6f8\n')
  return tree
}

describe('setting up a bsp board host', () => {
  it('gets in with a password once, puts boardd\'s key there, ships bsp and installs bspd', async () => {
    const remote = join(dir, 'remote')
    const ssh = fakeSsh(remote)
    process.env.PATH = `${ssh.bin}:${process.env.PATH}`
    const hosts = new Hosts(join(dir, 'state'))
    const lines: string[] = []
    // Without a password nothing gets in, and the error says what was tried.
    await expect(hosts.reach({ address: 'lab-1', user: 'root' })).rejects.toThrow(/boardd 自己的密钥.*继承.*给出密码试试/)
    const done = await installHost(hosts, fakeBspTree(), { id: 'lab1', access: { address: 'lab-1', user: 'root', password: 'opensesame' } }, null, line => lines.push(line))
    expect(done).toMatchObject({ target: 'root@lab-1', port: 8765, version: 'f61b6f8', url: 'bspd+ssh://root@lab-1:8765' })
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

  it('refuses addresses that would reach the shell', async () => {
    const hosts = new Hosts(join(dir, 'state'))
    await expect(hosts.reach({ address: 'lab-1; rm -rf /', user: 'root' })).rejects.toThrow(/不合法/)
    await expect(hosts.reach({ address: 'lab-1', user: '$(id)' })).rejects.toThrow(/不合法/)
  })
})
