import { describe, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Message } from '@workspace/protocol'
import { SqliteStore } from './store.js'
import { condense, defaultCondenserOptions, estimateTokens } from '@workspace/core'

const msg = (i: number, size = 400): Message => ({
  id: `m${i}`,
  role: i % 2 ? 'assistant' : 'user',
  pinned: false,
  parts: [{ type: 'text', text: 'x'.repeat(size) }],
})

const time = async (label: string, fn: () => unknown | Promise<unknown>) => {
  const t0 = performance.now()
  await fn()
  console.log(`  ${label.padEnd(46)} ${(performance.now() - t0).toFixed(1)} ms`)
}

/**
 * Where our own time goes.
 *
 * Opt-in via RUN_BENCH=1 — it prints rather than asserts, and a suite that
 * prints on every run trains people to ignore its output.
 *
 * The point is not to make these numbers smaller. It is to know whether they
 * matter at all: a model call is roughly a second, so anything here in the tens
 * of milliseconds is noise. Optimising a hot path that is one percent of the
 * budget is how you spend a week making nothing faster.
 */
describe.skipIf(process.env.RUN_BENCH !== '1')('measurements', () => {
  it('where our own time goes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'))
    const store = new SqliteStore(path.join(dir, 'w.db'))
    const thread = store.createThread()

    const thousand = Array.from({ length: 1000 }, (_, i) => msg(i))
    await time('store: append 1000 messages', () => store.appendMessages(thread.id, thousand))
    await time('store: load 1000 messages (schema-parsed)', () => store.loadMessages(thread.id))
    await time('store: list threads', () => store.listThreads())

    for (let t = 0; t < 50; t++) store.createThread({ title: `t${t}` })
    await time('store: list 51 threads (counts + cost)', () => store.listThreads())

    const big = Array.from({ length: 500 }, (_, i) => msg(i, 800))
    await time('estimateTokens over 500 messages', () => estimateTokens(big))
    await time('condense 500 messages (summarise path)', () =>
      condense(big, { ...defaultCondenserOptions, maxTokens: 2_000, summarise: async () => 's' }),
    )

    const huge = Array.from({ length: 5000 }, (_, i) => msg(i, 800))
    await time('condense 5000 messages', () =>
      condense(huge, { ...defaultCondenserOptions, maxTokens: 2_000, summarise: async () => 's' }),
    )

    store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }, 120_000)
})
