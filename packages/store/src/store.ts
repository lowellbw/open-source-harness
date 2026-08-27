import { openDatabase, type SqliteDatabase } from './sqlite.js'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  costBucketsSchema,
  messageSchema,
  zeroCost,
  addCost,
  type CostBuckets,
  type Message,
} from '@workspace/protocol'
import { migrate } from './schema.js'

/**
 * Durable conversation storage.
 *
 * Before this existed every conversation died with the process, which is the
 * difference between a demo and something you open again on Tuesday. It is also
 * what §12's cross-device continuity depends on: a session log that is a real
 * artifact rather than process memory.
 *
 * Deliberately not an ORM. The query surface is a dozen statements, and a
 * schema this small is easier to reason about written out than generated.
 */

export interface ThreadRecord {
  id: string
  title: string
  modelAlias: string
  createdAt: number
  updatedAt: number
}

export interface ThreadSummary extends ThreadRecord {
  messageCount: number
  costUsd: number
}

export interface Store {
  createThread(options?: { id?: string; title?: string; modelAlias?: string }): ThreadRecord
  listThreads(): ThreadSummary[]
  getThread(id: string): ThreadRecord | undefined
  renameThread(id: string, title: string): void
  setThreadModel(id: string, modelAlias: string): void
  deleteThread(id: string): void

  appendMessages(threadId: string, messages: Message[]): void
  loadMessages(threadId: string): Message[]

  recordCost(threadId: string, runId: string, model: string, buckets: CostBuckets): void
  threadCost(threadId: string): CostBuckets
  totalCost(): CostBuckets

  close(): void
}

export class SqliteStore implements Store {
  private readonly db: SqliteDatabase

  /** `:memory:` is accepted, and is what the tests use. */
  constructor(filePath: string) {
    if (filePath !== ':memory:') {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
    }
    this.db = openDatabase(filePath)
    migrate(this.db)
  }

  createThread(options: { id?: string; title?: string; modelAlias?: string } = {}): ThreadRecord {
    // `?? randomUUID()` would let an empty string through, and an empty id is
    // uniquely destructive: it is a valid primary key, so the row is created
    // happily, but every `if (threadId)` guard upstream reads it as absent. The
    // result is a thread that exists and can never be opened.
    if (options.id !== undefined && options.id.trim() === '') {
      throw new Error('Thread id may not be empty.')
    }

    const now = Date.now()
    const record: ThreadRecord = {
      id: options.id ?? randomUUID(),
      title: options.title ?? 'New thread',
      modelAlias: options.modelAlias ?? 'Standard',
      createdAt: now,
      updatedAt: now,
    }

    this.db
      .prepare(
        'INSERT INTO threads (id, title, model_alias, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(record.id, record.title, record.modelAlias, record.createdAt, record.updatedAt)

    return record
  }

  listThreads(): ThreadSummary[] {
    // One query rather than N+1: a thread list that fires two statements per row
    // is fine at ten threads and miserable at a thousand.
    const rows = this.db
      .prepare(
        `SELECT t.id, t.title, t.model_alias, t.created_at, t.updated_at,
                (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id)  AS message_count,
                (SELECT COALESCE(SUM(json_extract(c.buckets, '$.usd')), 0)
                   FROM costs c WHERE c.thread_id = t.id)                   AS cost_usd
         FROM threads t
         ORDER BY t.updated_at DESC`,
      )
      .all() as Record<string, unknown>[]

    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      modelAlias: String(row.model_alias),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      messageCount: Number(row.message_count),
      costUsd: Number(row.cost_usd),
    }))
  }

  getThread(id: string): ThreadRecord | undefined {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) return undefined
    return {
      id: String(row.id),
      title: String(row.title),
      modelAlias: String(row.model_alias),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  renameThread(id: string, title: string): void {
    this.db
      .prepare('UPDATE threads SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, Date.now(), id)
  }

  setThreadModel(id: string, modelAlias: string): void {
    this.db
      .prepare('UPDATE threads SET model_alias = ?, updated_at = ? WHERE id = ?')
      .run(modelAlias, Date.now(), id)
  }

  deleteThread(id: string): void {
    // Messages and costs go with it via ON DELETE CASCADE, which is why
    // foreign_keys is ON — SQLite ignores the clause otherwise and silently
    // leaves orphans.
    this.db.prepare('DELETE FROM threads WHERE id = ?').run(id)
  }

  appendMessages(threadId: string, messages: Message[]): void {
    if (messages.length === 0) return

    const nextSeq = Number(
      (this.db
        .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM messages WHERE thread_id = ?')
        .get(threadId) as { next: number }).next,
    )

    const insert = this.db.prepare(
      'INSERT INTO messages (id, thread_id, seq, role, parts, pinned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )

    // One transaction: a half-written turn is worse than a lost one, because it
    // reloads as a conversation that never happened.
    this.db.exec('BEGIN')
    try {
      const now = Date.now()
      messages.forEach((message, index) => {
        insert.run(
          message.id,
          threadId,
          nextSeq + index,
          message.role,
          JSON.stringify(message.parts),
          message.pinned ? 1 : 0,
          now,
        )
      })
      this.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(now, threadId)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  loadMessages(threadId: string): Message[] {
    const rows = this.db
      .prepare('SELECT id, role, parts, pinned FROM messages WHERE thread_id = ? ORDER BY seq')
      .all(threadId) as Record<string, unknown>[]

    return rows.map((row) =>
      // Parsed rather than cast: a row written by an older build with a
      // different part shape should fail loudly here, not halfway through a
      // model request.
      messageSchema.parse({
        id: String(row.id),
        role: String(row.role),
        parts: JSON.parse(String(row.parts)),
        pinned: Number(row.pinned) === 1,
      }),
    )
  }

  recordCost(threadId: string, runId: string, model: string, buckets: CostBuckets): void {
    this.db
      .prepare('INSERT INTO costs (thread_id, run_id, model, buckets, ts) VALUES (?, ?, ?, ?, ?)')
      .run(threadId, runId, model, JSON.stringify(buckets), Date.now())
  }

  threadCost(threadId: string): CostBuckets {
    return this.sumCosts('SELECT buckets FROM costs WHERE thread_id = ?', threadId)
  }

  totalCost(): CostBuckets {
    return this.sumCosts('SELECT buckets FROM costs')
  }

  private sumCosts(sql: string, ...params: string[]): CostBuckets {
    const rows = this.db.prepare(sql).all(...params) as { buckets: string }[]
    // Parsed, not cast. A row written before a bucket existed has no value for
    // it, and casting would make that `undefined` — which turns the whole sum
    // into NaN, silently, from one old row. The schema's defaults fill it in.
    return rows.reduce(
      (total, row) => addCost(total, costBucketsSchema.parse(JSON.parse(row.buckets))),
      zeroCost,
    )
  }

  close(): void {
    this.db.close()
  }
}
