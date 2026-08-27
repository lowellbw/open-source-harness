import type { SqliteDatabase } from './sqlite.js'

/**
 * Schema for the persistent store.
 *
 * Backed by `node:sqlite` rather than `better-sqlite3`. That is a deliberate
 * trade: the built-in module is marked experimental, but a native module would
 * need arm64 and x64 prebuilds inside the Mac `.app` bundle, and the surface
 * used here (`exec`, `prepare`, `run`, `all`, `get`) is tiny and mirrors
 * better-sqlite3 almost exactly. Everything goes through the `Store` interface,
 * so swapping is one file if the API churns.
 *
 * Migrations are versioned from the start. A store that cannot be upgraded is a
 * store that gets deleted the first time the schema changes, which for
 * conversation history means losing someone's work.
 */

export const SCHEMA_VERSION = 1

export function migrate(db: SqliteDatabase): void {
  // WAL keeps a reader from blocking the writer, which matters because the UI
  // polls thread lists while a turn is still appending messages.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)

  const current = Number(
    (db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined)?.value ?? 0,
  )

  if (current >= SCHEMA_VERSION) return

  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      model_alias TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT NOT NULL,
      thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      -- Explicit ordering. Timestamps collide at millisecond resolution when a
      -- model streams several messages inside one turn, and a conversation
      -- reloaded in the wrong order is worse than one not reloaded at all.
      seq        INTEGER NOT NULL,
      role       TEXT NOT NULL,
      parts      TEXT NOT NULL,
      pinned     INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, seq)
    );

    CREATE TABLE IF NOT EXISTS costs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      run_id     TEXT NOT NULL,
      model      TEXT NOT NULL,
      buckets    TEXT NOT NULL,
      ts         INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, seq);
    CREATE INDEX IF NOT EXISTS idx_costs_thread    ON costs(thread_id);
    CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated_at DESC);
  `)

  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'schema_version',
    String(SCHEMA_VERSION),
  )
}
