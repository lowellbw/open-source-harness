import { createRequire } from 'node:module'

/**
 * Loads `node:sqlite` at runtime rather than through a static import.
 *
 * The module is new enough that bundlers do not recognise it: Vite strips the
 * `node:` prefix and then fails to resolve a package called `sqlite`, and Next's
 * bundler has the same blind spot. Marking it external in each bundler's config
 * is a game of whack-a-mole across three build pipelines; going through
 * `createRequire` means no bundler ever sees it, and the runtime — which does
 * know the module — resolves it.
 *
 * The types below cover only what this package uses. They are hand-written
 * because `@types/node` does not yet ship them for the experimental module, and
 * this narrow surface is also exactly what a swap to `better-sqlite3` would
 * need to satisfy.
 */

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

export interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase
}

const require = createRequire(import.meta.url)

export function openDatabase(filePath: string): SqliteDatabase {
  const { DatabaseSync } = require('node:sqlite') as SqliteModule
  return new DatabaseSync(filePath)
}
