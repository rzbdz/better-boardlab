/** The sftp market against a runner that answers for the build servers: the configuration, the folders, the images and where each is fetched from. */
import { describe, expect, it } from 'vitest'
import { sftpConfig, sftpMarket, type Root } from '../src/modules/sftp-images/index.ts'

const config = {
  roots: [
    { name: 'a-out', title: 'Build A', host: 'builder@build-a.example.org', dir: '/srv/a/output/', soc: 'soc-a' },
    { name: 'b-out', host: 'build-b.example.org', dir: '/srv/b/output', glob: 'img_*.zip' },
  ],
}
const stat = (dir: string, file: string, size: number, at: number) => `${dir}/${file}|${size}|${at}`

/** A runner that notes what it was asked and answers as the root's machine would. */
function runner(output: Record<string, { code: number, stdout?: string, stderr?: string }>, asked: string[] = []) {
  return async (root: Root, command: string) => {
    asked.push(`${root.host} ${command}`)
    const out = output[root.name]!
    return { code: out.code, stdout: out.stdout ?? '', stderr: out.stderr ?? '' }
  }
}

describe('sftp-images', () => {
  it('says what is wrong with a market setting', () => {
    expect(() => sftpConfig({})).toThrow(/roots/)
    expect(() => sftpConfig({ roots: [{ name: 'a b', host: 'x.example.org', dir: '/srv' }] })).toThrow(/name/)
    expect(() => sftpConfig({ roots: [{ name: 'a', host: 'x.example.org', dir: '/srv' }, { name: 'a', host: 'x.example.org', dir: '/srv' }] })).toThrow(/重复/)
    expect(() => sftpConfig({ roots: [{ name: 'a', host: 'x y', dir: '/srv' }] })).toThrow(/host/)
    expect(() => sftpConfig({ roots: [{ name: 'a', host: 'x.example.org', dir: 'srv/out' }] })).toThrow(/dir/)
    expect(() => sftpConfig({ roots: [{ name: 'a', host: 'x.example.org', dir: '/srv/../etc' }] })).toThrow(/dir/)
    expect(() => sftpConfig({ roots: [{ name: 'a', host: 'x.example.org', dir: "/srv/'; reboot" }] })).toThrow(/dir/)
    expect(() => sftpConfig({ roots: [{ name: 'a', host: 'x.example.org', dir: '/srv', glob: "*.zip'; reboot" }] })).toThrow(/glob/)
    expect(sftpConfig(config)[0]).toEqual({ name: 'a-out', title: 'Build A', host: 'builder@build-a.example.org', user: 'builder', address: 'build-a.example.org', dir: '/srv/a/output', glob: '*.zip', soc: 'soc-a' })
  })

  it('lists the directories as folders, and a directory as its images with sizes and times', async () => {
    const asked: string[] = []
    const market = sftpMarket(config, runner({
      'a-out': { code: 0, stdout: [stat('/srv/a/output', 'x.zip', 1234, 1767225600), stat('/srv/a/output', 'y.zip', 5678, 1767312000), stat('/srv/a/output', 'bad name.zip', 1, 1)].join('\n') + '\n' },
      'b-out': { code: 0 },
    }, asked))
    expect(await market.list('')).toEqual([
      { path: 'a-out', name: 'Build A', kind: 'folder', soc: 'soc-a', note: '/srv/a/output', order: 0 },
      { path: 'b-out', name: 'b-out', kind: 'folder', soc: null, note: '/srv/b/output', order: 1 },
    ])
    expect(asked).toEqual([])
    expect(market.scheme).toBe('ssh')
    expect(await market.list('/a-out/')).toEqual([
      { path: 'a-out/x.zip', name: 'x.zip', kind: 'image', soc: 'soc-a', size: 1234, modified: '2026-01-01T00:00:00.000Z' },
      { path: 'a-out/y.zip', name: 'y.zip', kind: 'image', soc: 'soc-a', size: 5678, modified: '2026-01-02T00:00:00.000Z' },
    ])
    expect(asked).toEqual(["builder@build-a.example.org find '/srv/a/output' -maxdepth 1 -type f -name '*.zip' -exec stat -c '%n|%s|%Y' {} +"])
    expect(await market.list('b-out')).toEqual([])
    await expect(market.list('a-out/deeper')).rejects.toThrow(/一层/)
    await expect(market.list('nowhere')).rejects.toThrow(/没有这个目录/)
  })

  it('searches the directories by name: each one read once, a folder only where something matched', async () => {
    const asked: string[] = []
    const market = sftpMarket(config, runner({
      'a-out': { code: 0, stdout: [stat('/srv/a/output', 'x.zip', 1234, 1767225600), stat('/srv/a/output', 'K3-image.zip', 5678, 1767312000)].join('\n') },
      'b-out': { code: 0, stdout: stat('/srv/b/output', 'img_k3.zip', 99, 1767225600) },
    }, asked))
    expect(await market.search!('K3')).toEqual({ partial: false, entries: [
      { path: 'a-out', name: 'Build A', kind: 'folder', soc: 'soc-a', note: '/srv/a/output', order: 0 },
      { path: 'a-out/K3-image.zip', name: 'K3-image.zip', kind: 'image', soc: 'soc-a', size: 5678, modified: '2026-01-02T00:00:00.000Z' },
      { path: 'b-out', name: 'b-out', kind: 'folder', soc: null, note: '/srv/b/output', order: 1 },
      { path: 'b-out/img_k3.zip', name: 'img_k3.zip', kind: 'image', soc: null, size: 99, modified: '2026-01-01T00:00:00.000Z' },
    ] })
    // One find per directory, and nothing for words nothing has.
    expect(asked).toHaveLength(2)
    expect(await market.search!('nothing')).toEqual({ partial: false, entries: [] })
    expect(asked).toHaveLength(4)
    // One machine down leaves the answer short, and says so; the other directories are still searched.
    const half = sftpMarket(config, runner({ 'a-out': { code: 1, stderr: 'find: gone' }, 'b-out': { code: 0, stdout: stat('/srv/b/output', 'img_k3.zip', 99, 1767225600) } }))
    expect(await half.search!('k3')).toMatchObject({ partial: true, entries: [{ path: 'b-out' }, { path: 'b-out/img_k3.zip' }] })
  })

  it('says where an image is fetched from, and refuses what is not one of the directory images', async () => {
    const market = sftpMarket(config, runner({
      'a-out': { code: 0, stdout: stat('/srv/a/output', 'x.zip', 1234, 1767225600) },
      'b-out': { code: 0, stdout: stat('/srv/b/output', 'img_1.zip', 99, 1767225600) },
    }))
    expect(await market.locate('a-out/x.zip')).toEqual({ url: 'ssh://builder@build-a.example.org/srv/a/output/x.zip', name: 'x.zip', size: 1234, sha256: null })
    expect(await market.locate('b-out/img_1.zip')).toMatchObject({ url: 'ssh://build-b.example.org/srv/b/output/img_1.zip', size: 99 })
    await expect(market.locate('b-out/other.zip')).rejects.toThrow(/不是这个市场的镜像/)
    await expect(market.locate('a-out/bad name.zip')).rejects.toThrow(/不是这个市场的镜像/)
    await expect(market.locate('a-out')).rejects.toThrow(/不是一个镜像/)
    await expect(market.locate('a-out/gone.zip')).rejects.toThrow(/没有 x.zip|没有 gone.zip/)
  })

  it('names the machine and directory when it cannot be read', async () => {
    const market = sftpMarket(config, runner({ 'a-out': { code: 1, stderr: 'find: No such file or directory\n' }, 'b-out': { code: 255, stderr: 'ssh: connection refused' } }))
    await expect(market.list('a-out')).rejects.toThrow('builder@build-a.example.org 上读不了 /srv/a/output：find: No such file or directory')
    await expect(market.list('b-out')).rejects.toThrow(/build-b.example.org 上读不了.*connection refused/)
  })
})
