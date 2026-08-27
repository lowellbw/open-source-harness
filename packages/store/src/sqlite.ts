/**
 * Loads `node:sqlite` at runtime rather than through a static import.
 *
 * The module is new enough that bundlers do not recognise it: Vite strips the
 * `node:` prefix and then fails to resolve a package called `sqlite`. The
 * obvious dodge — `createRequire(import.meta.url)` — fixes Vite and breaks
 * Turbopack, which follows the call anyway and then cannot represent a CommonJS
 * reference rooted at a URL. Marking the package external does not help either,
 * because the analysis happens before that.
 *
 * `process.getBuiltinModule` exists for exactly this problem. It is a plain
 * function call with a string argument, so there is nothing for a bundler to
 * resolve, and Node hands back the builtin. Available since 22.3; this
 * repository requires 22+.
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

export function openDatabase(filePath: string): SqliteDatabase {
  const sqlite = (
    process as unknown as { getBuiltinModule?: (id: string) => unknown }
  ).getBuiltinModule?.('node:sqlite') as SqliteModule | undefined

  if (!sqlite?.DatabaseSync) {
    throw new Error(
      'node:sqlite is unavailable. It needs Node 22.3 or newer; ' +
        `this process is ${process.version}.`,
    )
  }

  return new sqlite.DatabaseSync(filePath)
}
