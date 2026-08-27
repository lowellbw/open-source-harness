import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { ModelGateway, type ResolvedModel } from '@workspace/gateway-model'
import { SqliteStore } from '@workspace/store'
import { SessionManager } from './manager.js'

/**
 * Persistence, tested across a manager boundary.
 *
 * Every assertion here builds a SECOND manager over the same store rather than
 * reusing the first. A test that rehydrates from the same instance passes
 * happily against an in-memory Map, which is precisely the bug this code exists
 * to fix — so it would prove nothing.
 */

const tmpDirs: string[] = []
const stores: SqliteStore[] = []

afterEach(async () => {
  stores.splice(0).forEach((s) => s.close())
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

/**
 * A gateway with the model swapped out.
 *
 * Subclassed rather than adding an injection point to ModelGateway: the catalog,
 * the role gating and the budget ceiling all still run for real, and only the
 * network call is replaced. A production seam for "use a different model" would
 * be a way around the gating, which §4 says must not exist.
 */
class StubGateway extends ModelGateway {
  constructor(private readonly reply: string) {
    super({ apiKey: 'test-key-not-used' })
  }

  override resolve(alias: string, role: string): ResolvedModel {
    const entry = this.catalog.resolve(alias, role)
    return {
      entry,
      vendor: 'anthropic',
      // No provider-run tools: this stub never reaches a provider.
      providerTools: {},
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: '1' },
              { type: 'text-delta', id: '1', delta: this.reply },
              { type: 'text-end', id: '1' },
              {
                type: 'finish',
                finishReason: 'stop',
                // The provider-level usage shape is nested; the flat
                // `LanguageModelUsage` the meter reads is what the SDK
                // normalises it into. Getting this wrong reports zero cost,
                // which is exactly the failure the ledger exists to catch.
                usage: {
                  inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 7, text: 7, reasoning: 0 },
                },
              },
            ],
            chunkDelayInMs: 0,
            initialDelayInMs: 0,
          }) as never,
        }),
      }),
    }
  }
}

async function harness(reply = 'Recorded.') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'persist-test-'))
  tmpDirs.push(dir)

  const store = new SqliteStore(path.join(dir, 'workspace.db'))
  stores.push(store)

  const build = () =>
    new SessionManager({
      workspaceRoot: path.join(dir, 'workspaces'),
      connectors: { approvalsPath: path.join(dir, 'approvals.json') },
      store,
      createGateway: () => new StubGateway(reply),
    })

  return { dir, store, build }
}

describe('threads survive the process', () => {
  it('reloads a conversation into a fresh manager', async () => {
    const { store, build } = await harness('The first answer.')

    const first = build()
    const { id } = first.createThread('Chat about ducks')
    const session = await first.get(id)
    await session.agent.send('Tell me about ducks.')
    await first.dispose()

    // The point of the test: nothing from `first` is reachable from here.
    const second = build()
    const resumed = await second.get(id)
    const history = resumed.agent.getHistory()

    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ role: 'user' })
    expect(history[1]).toMatchObject({ role: 'assistant' })
    expect(JSON.stringify(history[1]!.parts)).toContain('The first answer.')

    expect(store.listThreads()[0]).toMatchObject({ id, title: 'Chat about ducks', messageCount: 2 })
    await second.dispose()
  })

  it('keeps the user question when the assistant turn never completes', async () => {
    // The most valuable message to survive a crash is the one that caused it.
    const { store, build } = await harness()
    const manager = build()
    const { id } = manager.createThread()
    const session = await manager.get(id)

    // Refuse the model outright, the way a provider outage would.
    session.gateway.resolve = () => {
      throw new Error('provider exploded')
    }

    const result = await session.agent.send('Question that kills the turn.')

    expect(result.stoppedBy).toBe('error')
    const stored = store.loadMessages(id)
    expect(stored).toHaveLength(1)
    expect(JSON.stringify(stored[0]!.parts)).toContain('Question that kills the turn.')
    await manager.dispose()
  })

  it('writes each request to the cost ledger, not just a running total', async () => {
    const { store, build } = await harness()
    const manager = build()
    const { id } = manager.createThread()
    const session = await manager.get(id)

    await session.agent.send('one')
    await session.agent.send('two')

    const cost = store.threadCost(id)
    // Two requests at 11 in / 7 out.
    expect(cost.uncachedInputTokens).toBe(22)
    expect(cost.outputTokens).toBe(14)
    expect(cost.usd).toBeGreaterThan(0)
    await manager.dispose()
  })

  it('carries the thread model across a restart', async () => {
    const { build } = await harness()
    const first = build()
    const { id } = first.createThread('x', 'Light')
    await first.get(id)
    await first.dispose()

    const second = build()
    expect((await second.get(id)).modelAlias).toBe('Light')
    await second.dispose()
  })

  it('deletes the workspace directory along with the rows', async () => {
    // Rows without files is a leak; files without rows is a conversation you
    // deleted whose documents are still on disk.
    const { store, build } = await harness()
    const manager = build()
    const { id } = manager.createThread()
    const session = await manager.get(id)
    await session.workspace.write('/notes.txt', 'private')
    const root = session.root

    await manager.deleteThread(id)

    expect(store.getThread(id)).toBeUndefined()
    expect(store.loadMessages(id)).toHaveLength(0)
    await expect(fs.stat(root)).rejects.toThrow()
    await manager.dispose()
  })

  it('refuses an empty thread id at every layer', async () => {
    // An empty id is a valid SQLite primary key and a falsy JavaScript string,
    // so the row is created happily and then every `if (threadId)` upstream
    // reads it as absent. The result is a thread that exists and can never be
    // opened — which is exactly what a UI rendering before it has picked a
    // thread produced.
    const { store, build } = await harness()
    const manager = build()

    expect(() => store.createThread({ id: '' })).toThrow(/may not be empty/)
    expect(() => store.createThread({ id: '   ' })).toThrow(/may not be empty/)
    await expect(manager.get('')).rejects.toThrow(/may not be empty/)
    expect(store.listThreads()).toHaveLength(0)

    await manager.dispose()
  })

  it('works with no store at all, as before', async () => {
    // Persistence is additive. A manager without a store must not throw.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'persist-none-'))
    tmpDirs.push(dir)

    const manager = new SessionManager({
      workspaceRoot: path.join(dir, 'workspaces'),
      connectors: { approvalsPath: path.join(dir, 'approvals.json') },
      createGateway: () => new StubGateway('fine'),
    })

    const session = await manager.get('adhoc')
    expect((await session.agent.send('hello')).stoppedBy).toBe('complete')
    expect(manager.listThreads()).toEqual([])
    await manager.dispose()
  })
})
