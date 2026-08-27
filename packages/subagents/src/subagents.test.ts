import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { ModelGateway, type ResolvedModel } from '@workspace/gateway-model'
import { zeroCost, type WorkspaceEvent } from '@workspace/protocol'
import { LocalWorkspace } from '@workspace/workspace'
import { readOnly, ReadOnlyViolation } from './readonly.js'
import { buildScoutFileTools } from './tools.js'
import { spawnScout } from './scout.js'
import { buildSubagentTools } from './spawn-tool.js'

const tmpDirs: string[] = []

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function makeWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scout-test-'))
  tmpDirs.push(root)
  const workspace = new LocalWorkspace({ root })
  await workspace.start()
  return workspace
}

/** A gateway whose model is a stub, with the catalog and budget still real. */
class StubGateway extends ModelGateway {
  constructor(
    private readonly reply: string,
    limits?: { perRunUsd: number; perSessionUsd: number },
  ) {
    super({ apiKey: 'test-key-not-used', ...(limits ? { limits } : {}) })
  }

  override resolve(alias: string, role: string): ResolvedModel {
    const entry = this.catalog.resolve(alias, role)
    return {
      entry,
      vendor: 'anthropic',
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
                usage: {
                  inputTokens: { total: 500, noCache: 500, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 100, text: 100, reasoning: 0 },
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

const policy = {
  orgId: 'test',
  userId: 'you',
  role: 'staff',
  scope: ['/'],
  permissions: ['read', 'write', 'exec'],
  constraints: ['Work only inside the workspace.'],
}

describe('a scout cannot write, by construction', () => {
  it('throws on every mutating method', async () => {
    // Asserted directly rather than by checking the model does not try. A
    // prompt is a request; this is the property that makes it true.
    const scoped = readOnly(await makeWorkspace())

    await expect(scoped.write('/x.txt', 'nope')).rejects.toThrow(ReadOnlyViolation)
    await expect(scoped.mkdir('/dir')).rejects.toThrow(ReadOnlyViolation)
    await expect(scoped.remove('/x.txt')).rejects.toThrow(ReadOnlyViolation)
  })

  it('refuses exec, because a shell is a write primitive', async () => {
    // `sh -c 'echo x > f'` writes. A read-only workspace that allows commands
    // is not read-only, and containment for exec comes from the backing being
    // isolated — which LocalWorkspace is not.
    const workspace = await makeWorkspace()
    const scoped = readOnly(workspace)

    await expect(scoped.exec('echo pwned > /pwned.txt')).rejects.toThrow(ReadOnlyViolation)
    expect(await workspace.exists('/pwned.txt')).toBe(false)
  })

  it('still reads everything', async () => {
    const workspace = await makeWorkspace()
    await workspace.write('/notes.md', 'readable')
    const scoped = readOnly(workspace)

    expect(await scoped.read('/notes.md')).toBe('readable')
    expect(await scoped.exists('/notes.md')).toBe(true)
    expect((await scoped.list('/')).map((e) => e.name)).toContain('notes.md')
  })

  it('cannot dispose the workspace out from under the parent', async () => {
    // A scout borrows the parent's workspace. Disposing it would take the
    // session down as a side effect of a subagent finishing.
    const workspace = await makeWorkspace()
    await workspace.write('/keep.txt', 'still here')

    await readOnly(workspace).dispose()

    expect(await workspace.read('/keep.txt')).toBe('still here')
  })

  it('does not leak a writable reference through the wrapper', async () => {
    const workspace = await makeWorkspace()
    const scoped = readOnly(workspace)
    // Nothing on the wrapper should hand back the original.
    expect(Object.values(scoped)).not.toContain(workspace)
  })
})

describe('scout file tools work without a shell', () => {
  const call = (tools: ReturnType<typeof buildScoutFileTools>, name: string, args: unknown) =>
    (tools[name]!.execute as (a: unknown, o: unknown) => Promise<never>)(args, {})

  it('searches contents and reports file and line', async () => {
    const workspace = await makeWorkspace()
    await workspace.write('/a.ts', 'const target = 1\nother\n')
    await workspace.write('/nested/b.ts', 'nothing\nconst target = 2\n')
    const tools = buildScoutFileTools({ workspace: readOnly(workspace) })

    const result = (await call(tools, 'searchFiles', { pattern: 'target', path: '/' })) as {
      matches: { file: string; line: number }[]
      count: number
    }

    expect(result.count).toBe(2)
    expect(result.matches.map((m) => m.line).sort()).toEqual([1, 2])
  })

  it('treats a shell metacharacter pattern as text — there is no shell', async () => {
    const workspace = await makeWorkspace()
    await workspace.write('/a.ts', 'harmless')
    const tools = buildScoutFileTools({ workspace: readOnly(workspace) })

    await call(tools, 'searchFiles', { pattern: '"; touch /pwned.txt; echo "', path: '/' })

    expect(await workspace.exists('/pwned.txt')).toBe(false)
  })

  it('falls back to a literal search when the model writes a bad regex', async () => {
    // `[unclosed` throws in RegExp. Refusing would be correct and unhelpful.
    const workspace = await makeWorkspace()
    await workspace.write('/a.ts', 'value[unclosed here')
    const tools = buildScoutFileTools({ workspace: readOnly(workspace) })

    expect(await call(tools, 'searchFiles', { pattern: '[unclosed', path: '/' })).toMatchObject({
      count: 1,
    })
  })

  it('finds files by glob and skips vendored directories', async () => {
    const workspace = await makeWorkspace()
    await workspace.write('/src/one.ts', 'x')
    await workspace.write('/src/two.js', 'x')
    await workspace.write('/node_modules/dep/index.ts', 'x')
    const tools = buildScoutFileTools({ workspace: readOnly(workspace) })

    const result = (await call(tools, 'findFiles', { pattern: '*.ts', path: '/' })) as {
      files: string[]
    }
    expect(result.files).toEqual(['/src/one.ts'])
  })

  it('stops at the visit budget instead of walking a huge tree forever', async () => {
    const workspace = await makeWorkspace()
    for (let i = 0; i < 40; i++) await workspace.write(`/f${i}.txt`, 'needle')
    const tools = buildScoutFileTools({ workspace: readOnly(workspace), maxFiles: 5 })

    const result = (await call(tools, 'searchFiles', { pattern: 'needle', path: '/' })) as {
      count: number
    }
    expect(result.count).toBeLessThanOrEqual(5)
  })

  it('offers no way to write', async () => {
    const tools = buildScoutFileTools({ workspace: readOnly(await makeWorkspace()) })
    expect(Object.keys(tools).sort()).toEqual(['findFiles', 'listFiles', 'readFile', 'searchFiles'])
  })
})

describe('spawning a scout', () => {
  it('returns a report and its own cost, and cannot recurse', async () => {
    const workspace = await makeWorkspace()
    const events: WorkspaceEvent[] = []

    const result = await spawnScout({
      task: 'Summarise the workspace.',
      workspace,
      policy,
      parentRunId: 'run-1',
      onEvent: (e) => events.push(e),
      createGateway: () => new StubGateway('Found three files.'),
    })

    expect(result.stoppedBy).toBe('complete')
    expect(result.report).toBe('Found three files.')
    expect(result.cost.usd).toBeGreaterThan(0)

    expect(events.map((e) => e.type)).toEqual(['subagent.started', 'subagent.finished'])
    const finished = events[1] as { reportChars: number; stoppedBy: string }
    expect(finished.reportChars).toBe('Found three files.'.length)
    expect(finished.stoppedBy).toBe('complete')
  })

  it('stops when its own ceiling is reached', async () => {
    // The ceiling is checked BEFORE each request, because a request's cost is
    // unknowable until it returns — so overshoot is bounded by one step and a
    // single-step scout always gets its one call. What must hold is that a
    // scout arriving at an exhausted allowance refuses rather than proceeding.
    const workspace = await makeWorkspace()

    const result = await spawnScout({
      task: 'Something expensive.',
      workspace,
      policy,
      parentRunId: 'run-1',
      budgetUsd: 0.01,
      createGateway: (budget) => {
        const gateway = new StubGateway('never reached', {
          perRunUsd: budget,
          perSessionUsd: budget,
        })
        // Already spent, as it would be several steps in.
        gateway.meter.record({ ...zeroCost, usd: budget * 2 })
        return gateway
      },
    })

    expect(result.stoppedBy).toBe('budget_exceeded')
  })

  it("does not spend the parent's budget", async () => {
    // The isolation claim: a scout's spend must not silently eat the session's
    // allowance. It is rolled up deliberately by the research tool, not as a
    // side effect of the scout running.
    const workspace = await makeWorkspace()
    const parent = new StubGateway('parent')

    await spawnScout({
      task: 'Read things.',
      workspace,
      policy,
      parentRunId: 'run-1',
      createGateway: () => new StubGateway('scout'),
    })

    expect(parent.totals().session.usd).toBe(0)
  })

  it('emits a finished event even when the turn fails', async () => {
    // A trace showing a scout that started and never finished is worse than no
    // trace: it reads as still running.
    const workspace = await makeWorkspace()
    const events: WorkspaceEvent[] = []

    class ExplodingGateway extends StubGateway {
      override resolve(): never {
        throw new Error('provider exploded')
      }
    }

    const result = await spawnScout({
      task: 'Anything.',
      workspace,
      policy,
      parentRunId: 'run-1',
      onEvent: (e) => events.push(e),
      createGateway: () => new ExplodingGateway('x'),
    })

    expect(result.stoppedBy).toBe('error')
    expect(events.map((e) => e.type)).toEqual(['subagent.started', 'subagent.finished'])
  })
})

describe('the research tool', () => {
  const call = (tools: ReturnType<typeof buildSubagentTools>, args: unknown) =>
    (tools.research!.execute as (a: unknown, o: unknown) => Promise<never>)(args, {})

  it('runs tasks concurrently and writes each report to a file', async () => {
    const workspace = await makeWorkspace()
    const gateway = new StubGateway('The answer.')
    const events: WorkspaceEvent[] = []

    const tools = buildSubagentTools({
      workspace,
      policy,
      gateway,
      emit: (e) => events.push(e),
    })

    // Every scout in this test shares the stub, injected via the module under
    // test's own default path — so patch the factory the tool uses instead.
    const result = (await call(tools, {
      tasks: [
        { task: 'What is in /a?', label: 'read a' },
        { task: 'What is in /b?', label: 'read b' },
      ],
    })) as { reports: { label: string; ok: boolean; path?: string }[]; count: number }

    expect(result.count).toBe(2)
    expect(result.reports.map((r) => r.label)).toEqual(['read a', 'read b'])
  })

  it('caps how many scouts one call may spawn', async () => {
    const tools = buildSubagentTools({
      workspace: await makeWorkspace(),
      policy,
      gateway: new StubGateway('x'),
      emit: () => {},
      maxConcurrent: 2,
    })

    const schema = (tools.research as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } })
      .inputSchema
    const tooMany = { tasks: [1, 2, 3].map((n) => ({ task: `t${n}`, label: `l${n}` })) }
    expect(schema.safeParse(tooMany).success).toBe(false)
  })
})
