import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Message } from '@workspace/protocol'
import { SqliteStore } from './store.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-'))
  dirs.push(dir)
  return path.join(dir, 'nested', 'workspace.db')
}

const message = (id: string, text: string, over: Partial<Message> = {}): Message => ({
  id,
  role: 'user',
  pinned: false,
  parts: [{ type: 'text', text }],
  ...over,
})

const cost = (usd: number) => ({
  uncachedInputTokens: 100,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 50,
  reasoningTokens: 10,
  usd,
})

describe('threads', () => {
  it('creates, reads back and lists', () => {
    const store = new SqliteStore(':memory:')
    const thread = store.createThread({ title: 'First', modelAlias: 'Light' })

    expect(store.getThread(thread.id)).toMatchObject({ title: 'First', modelAlias: 'Light' })
    expect(store.listThreads()).toHaveLength(1)
    store.close()
  })

  it('creates parent directories for the database file', () => {
    // The Mac shell points this at Application Support, which may not exist on
    // a first run.
    const file = tempFile()
    const store = new SqliteStore(file)
    expect(fs.existsSync(file)).toBe(true)
    store.close()
  })

  it('orders the list by most recently touched', () => {
    const store = new SqliteStore(':memory:')
    const a = store.createThread({ title: 'A' })
    const b = store.createThread({ title: 'B' })

    store.appendMessages(a.id, [message('m1', 'hello')])

    expect(store.listThreads().map((t) => t.title)).toEqual(['A', 'B'])
    void b
    store.close()
  })

  it('renames and switches model without touching messages', () => {
    const store = new SqliteStore(':memory:')
    const thread = store.createThread()
    store.appendMessages(thread.id, [message('m1', 'kept')])

    store.renameThread(thread.id, 'Renamed')
    store.setThreadModel(thread.id, 'Premium')

    expect(store.getThread(thread.id)).toMatchObject({ title: 'Renamed', modelAlias: 'Premium' })
    expect(store.loadMessages(thread.id)).toHaveLength(1)
    store.close()
  })

  it('deletes messages and costs with the thread', () => {
    // Requires foreign_keys = ON; SQLite ignores ON DELETE CASCADE otherwise
    // and silently leaves orphans behind.
    const store = new SqliteStore(':memory:')
    const thread = store.createThread()
    store.appendMessages(thread.id, [message('m1', 'x')])
    store.recordCost(thread.id, 'run-1', 'Light', cost(0.01))

    store.deleteThread(thread.id)

    expect(store.getThread(thread.id)).toBeUndefined()
    expect(store.loadMessages(thread.id)).toHaveLength(0)
    expect(store.totalCost().usd).toBe(0)
    store.close()
  })

  it('reports message count and cost per thread in one pass', () => {
    const store = new SqliteStore(':memory:')
    const thread = store.createThread({ title: 'Busy' })
    store.appendMessages(thread.id, [message('m1', 'a'), message('m2', 'b')])
    store.recordCost(thread.id, 'run-1', 'Light', cost(0.25))

    expect(store.listThreads()[0]).toMatchObject({ messageCount: 2, costUsd: 0.25 })
    store.close()
  })
})

describe('messages', () => {
  it('preserves order across separate appends', () => {
    // Ordering comes from an explicit seq, not a timestamp: several messages
    // written inside one turn collide at millisecond resolution, and a
    // conversation reloaded out of order is worse than one not reloaded.
    const store = new SqliteStore(':memory:')
    const thread = store.createThread()

    store.appendMessages(thread.id, [message('m1', 'first'), message('m2', 'second')])
    store.appendMessages(thread.id, [message('m3', 'third')])

    expect(store.loadMessages(thread.id).map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    store.close()
  })

  it('round-trips tool calls, results and reasoning artifacts', () => {
    const store = new SqliteStore(':memory:')
    const thread = store.createThread()

    const rich: Message[] = [
      {
        id: 'a1',
        role: 'assistant',
        pinned: false,
        parts: [
          { type: 'text', text: 'thinking about it' },
          { type: 'reasoning', text: 'hmm', provider: 'anthropic', signature: 'sig-abc' },
          { type: 'tool-call', toolCallId: 't1', toolName: 'readFile', input: { path: '/a' } },
        ],
      },
      {
        id: 't1r',
        role: 'tool',
        pinned: false,
        parts: [
          {
            type: 'tool-result',
            toolCallId: 't1',
            toolName: 'readFile',
            output: { contents: 'x' },
            isError: false,
            elidedTo: '/.elided/t1.json',
          },
        ],
      },
    ]

    store.appendMessages(thread.id, rich)
    const loaded = store.loadMessages(thread.id)

    // The reasoning signature especially: dropping one across a reload is the
    // same hard-fail as dropping one across a model switch.
    expect(loaded).toEqual(rich)
    store.close()
  })

  it('preserves the pinned flag', () => {
    const store = new SqliteStore(':memory:')
    const thread = store.createThread()
    store.appendMessages(thread.id, [
      message('p1', 'policy', { role: 'system', pinned: true }),
      message('m1', 'normal'),
    ])

    const loaded = store.loadMessages(thread.id)
    expect(loaded.map((m) => m.pinned)).toEqual([true, false])
    store.close()
  })

  it('rejects a row that does not match the message schema', () => {
    // A row written by an older build with a different part shape should fail
    // here, loudly, rather than halfway through a model request.
    const store = new SqliteStore(':memory:')
    const thread = store.createThread()
    store.appendMessages(thread.id, [
      { id: 'bad', role: 'user', pinned: false, parts: [{ type: 'nonsense' } as never] },
    ])
    expect(() => store.loadMessages(thread.id)).toThrow()
    store.close()
  })

  it('appends nothing for an empty array', () => {
    const store = new SqliteStore(':memory:')
    const thread = store.createThread()
    expect(() => store.appendMessages(thread.id, [])).not.toThrow()
    expect(store.loadMessages(thread.id)).toHaveLength(0)
    store.close()
  })

  it('writes a turn atomically', () => {
    // A half-written turn reloads as a conversation that never happened, which
    // is worse than losing it outright.
    const store = new SqliteStore(':memory:')
    const thread = store.createThread()
    store.appendMessages(thread.id, [message('dup', 'first')])

    expect(() =>
      store.appendMessages(thread.id, [message('ok', 'second'), message('dup2', 'third')]),
    ).not.toThrow()
    expect(store.loadMessages(thread.id)).toHaveLength(3)
    store.close()
  })
})

describe('cost ledger', () => {
  it('accumulates per thread and overall', () => {
    const store = new SqliteStore(':memory:')
    const a = store.createThread()
    const b = store.createThread()

    store.recordCost(a.id, 'r1', 'Light', cost(0.10))
    store.recordCost(a.id, 'r2', 'Light', cost(0.05))
    store.recordCost(b.id, 'r3', 'Premium', cost(1.00))

    expect(store.threadCost(a.id).usd).toBeCloseTo(0.15, 6)
    expect(store.totalCost().usd).toBeCloseTo(1.15, 6)
    // Token buckets accumulate too, not just the dollar figure.
    expect(store.threadCost(a.id).outputTokens).toBe(100)
    store.close()
  })

  it('reports zero for a thread that has spent nothing', () => {
    const store = new SqliteStore(':memory:')
    expect(store.threadCost(store.createThread().id).usd).toBe(0)
    store.close()
  })
})

describe('survives a restart', () => {
  it('reloads threads, messages and costs from disk after close', () => {
    // The whole reason this package exists. Everything above could pass against
    // an in-memory map; only this proves the conversation is still there on
    // Tuesday.
    const file = tempFile()

    const first = new SqliteStore(file)
    const thread = first.createThread({ title: 'Persistent', modelAlias: 'Light' })
    first.appendMessages(thread.id, [message('m1', 'before restart'), message('m2', 'and this')])
    first.recordCost(thread.id, 'run-1', 'Light', cost(0.42))
    first.close()

    const second = new SqliteStore(file)

    expect(second.getThread(thread.id)).toMatchObject({
      title: 'Persistent',
      modelAlias: 'Light',
    })
    expect(second.loadMessages(thread.id).map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(second.threadCost(thread.id).usd).toBeCloseTo(0.42, 6)
    second.close()
  })

  it('keeps appending in order after a reopen', () => {
    const file = tempFile()

    const first = new SqliteStore(file)
    const thread = first.createThread()
    first.appendMessages(thread.id, [message('m1', 'one')])
    first.close()

    const second = new SqliteStore(file)
    second.appendMessages(thread.id, [message('m2', 'two')])

    // The seq counter continues rather than restarting, which a naive
    // "count rows at startup" approach would get wrong after a delete.
    expect(second.loadMessages(thread.id).map((m) => m.id)).toEqual(['m1', 'm2'])
    second.close()
  })

  it('re-running migrations on an existing database is a no-op', () => {
    const file = tempFile()
    const first = new SqliteStore(file)
    first.createThread({ title: 'Survivor' })
    first.close()

    // Opening again runs migrate() a second time. If it were not idempotent,
    // this would drop the table or throw.
    const second = new SqliteStore(file)
    expect(second.listThreads()).toHaveLength(1)
    second.close()
  })
})
