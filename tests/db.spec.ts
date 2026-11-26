/** boardd's state database: written durably, copied while it runs, and restored from a copy when the file is damaged. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acknowledgeRestore, backupDatabase, checkDatabase, listBackups, openDatabase, recoverDatabase, restoreRecord, scheduleBackups } from 'boardlab-core/core/db.ts'
import { BoardLab } from 'boardlab-core/core/lab.ts'
import { startBoardd } from 'boardlab-core/server/main.ts'
import { dir, useTempDir } from './helpers.ts'

useTempDir()
afterEach(() => { vi.useRealTimers() })

const at = (minute: number) => () => new Date(Date.UTC(2026, 10, 19, 12, minute))
const actions = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true })
  try { return db.prepare('SELECT kind FROM actions ORDER BY id').all().map(row => String(row.kind)) } finally { db.close() }
}

describe('state database', () => {
  it('commits durably: WAL with synchronous=FULL, not the WAL default', () => {
    const db = openDatabase(join(dir, 'boards.sqlite'))
    expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal')
    expect(Number(db.prepare('PRAGMA synchronous').get()?.synchronous)).toBe(2)
    db.close()
  })

  it('copies the running database, with a row just written, into a whole file under the backup directory', () => {
    const file = join(dir, 'boards.sqlite'), backups = join(dir, 'backups')
    const db = openDatabase(file)
    db.prepare("INSERT INTO actions(at, actor, board, kind, detail, ok) VALUES('now', 'user:a', 'b1', 'just-written', null, 1)").run()
    const copy = backupDatabase(db, file, backups, { now: at(0) })!
    expect(copy).toBe(join(backups, 'boards-2026-11-19T12-00-00-000Z.sqlite'))
    expect(checkDatabase(copy, true).ok).toBe(true)
    expect(actions(copy)).toContain('just-written')
    // No temporary file or lock is left behind.
    expect(readdirSync(backups)).toEqual(['boards-2026-11-19T12-00-00-000Z.sqlite'])
    db.close()
  })

  it('keeps the newest five copies', () => {
    const file = join(dir, 'boards.sqlite'), backups = join(dir, 'backups')
    const db = openDatabase(file)
    for (let minute = 0; minute < 8; minute++) backupDatabase(db, file, backups, { now: at(minute) })
    const kept = listBackups(file, backups).map(path => path.slice(backups.length + 1))
    expect(kept).toEqual([7, 6, 5, 4, 3].map(minute => `boards-2026-11-19T12-0${minute}-00-000Z.sqlite`))
    db.close()
  })

  it('leaves the copying to the process holding the backup lock, and takes over a lock a dead process left', () => {
    const file = join(dir, 'boards.sqlite'), backups = join(dir, 'backups')
    const db = openDatabase(file)
    backupDatabase(db, file, backups, { now: at(0) })
    writeFileSync(join(backups, '.lock'), `${process.ppid}\n`)
    expect(backupDatabase(db, file, backups, { now: at(1) })).toBeNull()
    writeFileSync(join(backups, '.lock'), '999999999\n')
    expect(backupDatabase(db, file, backups, { now: at(2) })).not.toBeNull()
    expect(existsSync(join(backups, '.lock'))).toBe(false)
    db.close()
  })

  it('replaces a damaged file with the newest good copy at open, and keeps the damaged file aside', () => {
    const file = join(dir, 'boards.sqlite'), backups = join(dir, 'backups')
    const db = openDatabase(file)
    db.prepare("INSERT INTO actions(at, actor, board, kind, detail, ok) VALUES('then', 'user:a', 'b1', 'in-older', null, 1)").run()
    backupDatabase(db, file, backups, { now: at(0) })
    db.prepare("INSERT INTO actions(at, actor, board, kind, detail, ok) VALUES('then', 'user:a', 'b1', 'in-newest', null, 1)").run()
    backupDatabase(db, file, backups, { now: at(1) })
    db.close()
    // The newest copy is damaged too: the one before it is used.
    writeFileSync(join(backups, 'boards-2026-11-19T12-02-00-000Z.sqlite'), Buffer.alloc(8192, 0x5a))
    const garbage = Buffer.alloc(16384, 0x41)
    writeFileSync(file, garbage)
    writeFileSync(`${file}-wal`, 'stale wal')

    const said: string[] = []
    const reopened = openDatabase(file, { backups, log: message => said.push(message) })
    const kinds = reopened.prepare('SELECT kind FROM actions').all().map(row => String(row.kind))
    // The copy's rows, and the restore itself recorded after them.
    expect(kinds).toEqual(['in-older', 'in-newest', 'db-restore'])
    reopened.close()

    const aside = readdirSync(dir).filter(name => /^boards\.sqlite\.corrupt-[0-9TZ-]+$/.test(name))
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(dir, aside[0]!))).toEqual(garbage)
    expect(readFileSync(join(dir, `${aside[0]}-wal`), 'utf8')).toBe('stale wal')
    expect(said.join('\n')).toContain('boards-2026-11-19T12-01-00-000Z.sqlite')
    expect(said.join('\n')).toContain(aside[0])
  })

  it('starts with an empty database, loudly, when no copy is good, and never touches a healthy file', () => {
    const file = join(dir, 'boards.sqlite'), backups = join(dir, 'backups')
    openDatabase(file).close()
    expect(recoverDatabase(file, backups, () => { throw new Error('a healthy file says nothing') })).toEqual({ corrupt: null, restored: null })
    writeFileSync(file, Buffer.alloc(8192, 0x41))
    const said: string[] = []
    const db = openDatabase(file, { backups, log: message => said.push(message) })
    expect(db.prepare('SELECT count(*) AS n FROM boards').get()?.n).toBe(0)
    db.close()
    expect(said.join('\n')).toMatch(/没有可用的备份/)
  })

  it('keeps a restore in the database it made, reported in the state until a person acknowledges it', async () => {
    const file = join(dir, 'boards.sqlite'), backups = join(dir, 'backups')
    const db = openDatabase(file)
    backupDatabase(db, file, backups, { now: at(0) })
    db.close()
    writeFileSync(file, Buffer.alloc(16384, 0x41))
    const lab = new BoardLab({ db: openDatabase(file, { backups, log: () => {} }) })
    const restored = lab.state('user:alice').restored!
    expect(restored).toMatchObject({ backup: join(backups, 'boards-2026-11-19T12-00-00-000Z.sqlite'), aside: expect.stringMatching(/boards\.sqlite\.corrupt-/), reason: expect.any(String) })
    expect(restored.aside.endsWith(restored.at.replace(/[:.]/g, '-'))).toBe(true)
    // In the history too, as a failed action of boardd's, saying what was lost.
    expect(lab.history().actions.find(action => action.kind === 'db-restore')).toMatchObject({ actor: 'boardd', ok: false, message: expect.stringMatching(/这份备份之后的改动丢了/) })
    const call = (method: 'GET' | 'POST', path: string, holder: string) => lab.api.match(method, path)!.endpoint.handle({ body: {}, query: new URLSearchParams(), params: {}, caller: { holder, local: true }, signal: new AbortController().signal, upload: null })
    expect(await call('GET', '/api/database', 'claude:x')).toEqual({ restored })
    // Only a person acknowledges it: an agent reads it and leaves it.
    expect(() => call('POST', '/api/database/acknowledge', 'claude:x')).toThrow(/要人来确认/)
    expect(await call('POST', '/api/database/acknowledge', 'user:alice')).toEqual({ acknowledged: restored })
    expect(lab.state('user:alice').restored).toBeNull()
    expect(lab.history().actions.some(action => action.kind === 'db-restore-ack' && action.actor === 'user:alice')).toBe(true)
    // It survives a restart until then; a healthy start adds nothing.
    lab.kernel.db.close()
    const again = openDatabase(file, { backups })
    expect(restoreRecord(again)).toBeNull()
    expect(acknowledgeRestore(again)).toBeNull()
    again.close()
  })

  it('reports a start with no good copy as a restore too, to an empty database', () => {
    const file = join(dir, 'boards.sqlite'), backups = join(dir, 'backups')
    writeFileSync(file, Buffer.alloc(8192, 0x41))
    const db = openDatabase(file, { backups, log: () => {} })
    expect(restoreRecord(db)).toMatchObject({ backup: null, aside: expect.stringMatching(/corrupt-/) })
    db.close()
  })

  it('leaves a damaged file to the worker still using it: one started beside it refuses to start and changes nothing', () => {
    const file = join(dir, 'boards.sqlite'), backups = join(dir, 'backups')
    const db = openDatabase(file)
    backupDatabase(db, file, backups, { now: at(0) })
    db.close()
    const garbage = Buffer.alloc(16384, 0x41)
    writeFileSync(file, garbage)
    const said: string[] = []
    expect(() => openDatabase(file, { backups, restore: false, log: message => said.push(message) })).toThrow(/另一个 boardd 还在用它/)
    // Not moved aside, not restored: the file the other worker has open is still the one at this path.
    expect(readFileSync(file)).toEqual(garbage)
    expect(readdirSync(dir).filter(name => name.includes('corrupt'))).toEqual([])
    // The worker that is alone with the file restores it.
    const alone = openDatabase(file, { backups, log: () => {} })
    expect(restoreRecord(alone)).not.toBeNull()
    alone.close()
  })

  it('starts a worker beside a live one on a damaged database only to refuse, and lets a first start restore it', async () => {
    const stateDir = join(dir, 'state'), file = join(stateDir, 'boards.sqlite'), backups = join(stateDir, 'backups')
    const db = openDatabase(file)
    backupDatabase(db, file, backups, { now: at(0) })
    db.close()
    writeFileSync(file, Buffer.alloc(16384, 0x41))
    const options = { stateDir, catalog: [], modules: [], port: 0, uiDir: null, worker: true }
    await expect(startBoardd({ ...options, sharedDatabase: true })).rejects.toThrow(/另一个 boardd 还在用它/)
    expect(readdirSync(stateDir).filter(name => name.includes('corrupt'))).toEqual([])
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const boardd = await startBoardd(options)
    try { expect(boardd.lab.state('user:alice').restored).toMatchObject({ backup: expect.stringContaining('boards-2026-11-19T12-00-00-000Z') }) }
    finally { await boardd.close(); error.mockRestore() }
  })

  it('copies a little after start and every six hours, and a failed copy is only logged', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
    vi.setSystemTime(Date.UTC(2026, 10, 19, 0, 0))
    const file = join(dir, 'boards.sqlite'), backups = join(dir, 'backups')
    const db = openDatabase(file)
    const said: string[] = []
    const stop = scheduleBackups(db, file, backups, { log: message => said.push(message) })
    expect(listBackups(file, backups)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(listBackups(file, backups)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(6 * 3600_000)
    expect(listBackups(file, backups)).toHaveLength(2)
    db.close()
    await vi.advanceTimersByTimeAsync(6 * 3600_000)
    expect(said.join('\n')).toMatch(/没能备份数据库/)
    stop()
  })
})
