/** boardd's own SQLite database. It is the authority once the hand-written inventory has been imported. */
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA_VERSION = 4

export function openDatabase(file: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  chmodSync(file, 0o600)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;')
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version)
  if (version > SCHEMA_VERSION) throw new Error('数据库版本高于当前程序，请使用匹配版本。')
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS slots (
      slot INTEGER PRIMARY KEY, reset_entity TEXT, fastboot_entity TEXT, device TEXT, confirmed_at TEXT,
      kind TEXT NOT NULL DEFAULT 'ha', label TEXT, reset_script TEXT, fastboot_script TEXT
    );
    CREATE TABLE IF NOT EXISTS boards (
      name TEXT PRIMARY KEY, slot INTEGER UNIQUE, serial TEXT, product TEXT, base_mac TEXT, soc TEXT,
      notes TEXT, source TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'unknown', last_seen_at TEXT, lab TEXT, lab_device TEXT
    );
    CREATE TABLE IF NOT EXISTS chips (
      board TEXT NOT NULL REFERENCES boards(name) ON DELETE CASCADE ON UPDATE CASCADE, die TEXT NOT NULL,
      serial_path TEXT, baud INTEGER NOT NULL DEFAULT 115200, alias TEXT, download_usb_path TEXT,
      usb_id TEXT, last_seen_at TEXT, PRIMARY KEY(board, die)
    );
    CREATE TABLE IF NOT EXISTS leases (
      id TEXT PRIMARY KEY, board TEXT NOT NULL, holder TEXT NOT NULL, purpose TEXT NOT NULL,
      token_hash TEXT NOT NULL, started_at TEXT NOT NULL, status TEXT NOT NULL,
      ended_at TEXT, end_reason TEXT, gate_token TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS lease_held ON leases(board) WHERE status = 'held';
    CREATE TABLE IF NOT EXISTS lease_waiters (
      id TEXT PRIMARY KEY, board TEXT NOT NULL, holder TEXT NOT NULL, purpose TEXT NOT NULL, queued_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, board TEXT,
      kind TEXT NOT NULL, detail TEXT, ok INTEGER NOT NULL, message TEXT
    );
    CREATE INDEX IF NOT EXISTS action_board ON actions(board, id);
    CREATE TABLE IF NOT EXISTS scans (
      id TEXT PRIMARY KEY, holder TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT, message TEXT, result TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS scan_steps (
      scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE, seq INTEGER NOT NULL, at TEXT NOT NULL,
      slot INTEGER, kind TEXT NOT NULL, summary TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scan_id, seq)
    );
    CREATE TABLE IF NOT EXISTS scan_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
      slot INTEGER, kind TEXT NOT NULL, label TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY, scan_id TEXT NOT NULL, kind TEXT NOT NULL, board TEXT, slot INTEGER,
      summary TEXT NOT NULL, change TEXT NOT NULL, status TEXT NOT NULL
    );
    -- Firmware used to be registered here; it now ships in firmware/.
    DROP TABLE IF EXISTS images;
  `)
  const addColumn = (table: string, column: string, declaration: string) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name))
    if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`)
  }
  // Version 2 gives each lease the token boardd sets as its serial ports' serial-mux input gate.
  addColumn('leases', 'gate_token', 'TEXT')
  // Version 3 adds slots driven by scripts instead of Home Assistant.
  addColumn('slots', 'kind', "TEXT NOT NULL DEFAULT 'ha'")
  addColumn('slots', 'label', 'TEXT')
  addColumn('slots', 'reset_script', 'TEXT')
  addColumn('slots', 'fastboot_script', 'TEXT')
  // Version 4 adds boards listed from remote labs, with the lab's own name for each.
  addColumn('boards', 'lab', 'TEXT')
  addColumn('boards', 'lab_device', 'TEXT')
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`)
  return db
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try { const result = fn(); db.exec('COMMIT'); return result }
  catch (error) { db.exec('ROLLBACK'); throw error }
}
