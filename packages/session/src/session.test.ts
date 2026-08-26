import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { WorkspaceEvent } from '@workspace/protocol'
import { LocalWorkspace } from '@workspace/workspace'
import { ApprovalGate } from './approvals.js'
import { buildWorkspaceTools } from './tools.js'

/**
 * The approval gate had no unit tests before this package existed — it was only
 * ever exercised by driving the running app with curl. It is the mechanism
 * standing between an agent and destroying someone's files, so it gets tested
 * directly, without a model in the loop.
 */

const tmpDirs: string[] = []

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function harness(options: { timeoutMs?: number } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-test-'))
  tmpDirs.push(root)

  const workspace = new LocalWorkspace({ root })
  await workspace.start()

  const events: WorkspaceEvent[] = []
  const emit = (event: WorkspaceEvent) => events.push(event)
  const approvals = new ApprovalGate(emit, options.timeoutMs)
  const tools = buildWorkspaceTools({ workspace, approvals, emit })

  const call = (name: string, args: unknown) =>
    (tools[name]!.execute as (a: unknown, o: unknown) => Promise<unknown>)(args, {})

  return { root, workspace, events, approvals, tools, call }
}

describe('approval gate: what interrupts and what does not', () => {
  it('does NOT prompt when creating a new file', async () => {
    // Creating destroys nothing. Prompting here would be the start of teaching
    // people to click through without reading.
    const { call, events, workspace } = await harness()

    const result = await call('writeFile', { path: '/new.txt', contents: 'hello' })

    expect(result).toMatchObject({ ok: true })
    expect(events.some((e) => e.type === 'approval.requested')).toBe(false)
    expect(await workspace.read('/new.txt')).toBe('hello')
  })

  it('DOES prompt when overwriting an existing file', async () => {
    const { call, events, approvals, workspace } = await harness()
    await workspace.write('/existing.txt', 'original')

    const pending = call('writeFile', { path: '/existing.txt', contents: 'replacement' })
    await vi.waitFor(() => expect(approvals.list()).toHaveLength(1))

    const request = events.find((e) => e.type === 'approval.requested')
    expect(request).toMatchObject({ irreversible: true, reason: 'Overwrite /existing.txt' })

    approvals.resolve(approvals.list()[0]!.approvalId, 'allow')
    expect(await pending).toMatchObject({ ok: true })
    expect(await workspace.read('/existing.txt')).toBe('replacement')
  })

  it('leaves the file untouched when an overwrite is denied', async () => {
    // The safety-critical path. A denial that still wrote would be worse than
    // no gate at all, because it would look safe.
    const { call, approvals, workspace } = await harness()
    await workspace.write('/precious.txt', 'do not lose me')

    const pending = call('writeFile', { path: '/precious.txt', contents: 'clobbered' })
    await vi.waitFor(() => expect(approvals.list()).toHaveLength(1))
    approvals.resolve(approvals.list()[0]!.approvalId, 'deny')

    expect(await pending).toMatchObject({ ok: false, reason: 'Denied by user' })
    expect(await workspace.read('/precious.txt')).toBe('do not lose me')
  })

  it('always prompts before running a command', async () => {
    // Unlike a write, there is no cheap way to tell in advance whether a shell
    // command destroys something, so every one is gated.
    const { call, approvals } = await harness()

    const pending = call('runCommand', { command: 'echo hi' })
    await vi.waitFor(() => expect(approvals.list()).toHaveLength(1))
    approvals.resolve(approvals.list()[0]!.approvalId, 'allow')

    expect(await pending).toMatchObject({ ok: true, exitCode: 0 })
  })

  it('does not run the command at all when denied', async () => {
    const { call, approvals, workspace } = await harness()

    const pending = call('runCommand', { command: 'echo written > sentinel.txt' })
    await vi.waitFor(() => expect(approvals.list()).toHaveLength(1))
    approvals.resolve(approvals.list()[0]!.approvalId, 'deny')

    expect(await pending).toMatchObject({ ok: false })
    expect(await workspace.exists('/sentinel.txt')).toBe(false)
  })

  it('never prompts for reads or listings', async () => {
    const { call, events, workspace } = await harness()
    await workspace.write('/readable.txt', 'contents')

    await call('readFile', { path: '/readable.txt' })
    await call('listFiles', { path: '/' })

    expect(events.some((e) => e.type === 'approval.requested')).toBe(false)
  })
})

describe('approval gate: timeout and resolution', () => {
  it('denies by default when nobody answers', async () => {
    // Silence is not consent. Defaulting to allow so the agent is not blocked
    // would make the gate decorative.
    const { call, workspace } = await harness({ timeoutMs: 150 })
    await workspace.write('/f.txt', 'original')

    expect(await call('writeFile', { path: '/f.txt', contents: 'new' })).toMatchObject({
      ok: false,
      reason: 'Denied by user',
    })
    expect(await workspace.read('/f.txt')).toBe('original')
  }, 10_000)

  it('reports an unknown approval id rather than silently succeeding', async () => {
    const { approvals } = await harness()
    expect(approvals.resolve('not-a-real-id', 'allow')).toBe(false)
  })

  it('ignores a second answer to the same prompt', async () => {
    const { call, approvals, workspace } = await harness()
    await workspace.write('/f.txt', 'original')

    const pending = call('writeFile', { path: '/f.txt', contents: 'new' })
    await vi.waitFor(() => expect(approvals.list()).toHaveLength(1))
    const id = approvals.list()[0]!.approvalId

    expect(approvals.resolve(id, 'deny')).toBe(true)
    // A late "allow" must not reopen a decision already taken.
    expect(approvals.resolve(id, 'allow')).toBe(false)

    expect(await pending).toMatchObject({ ok: false })
    expect(await workspace.read('/f.txt')).toBe('original')
  })

  it('emits approval.resolved so every shell can clear its prompt', async () => {
    const { call, events, approvals, workspace } = await harness()
    await workspace.write('/f.txt', 'x')

    const pending = call('writeFile', { path: '/f.txt', contents: 'y' })
    await vi.waitFor(() => expect(approvals.list()).toHaveLength(1))
    approvals.resolve(approvals.list()[0]!.approvalId, 'allow')
    await pending

    expect(events.some((e) => e.type === 'approval.resolved')).toBe(true)
  })

  it('denies everything outstanding on shutdown', async () => {
    // Otherwise a tool awaiting an answer that will never come holds the
    // process open.
    const { call, approvals, workspace } = await harness()
    await workspace.write('/f.txt', 'x')

    const pending = call('writeFile', { path: '/f.txt', contents: 'y' })
    await vi.waitFor(() => expect(approvals.list()).toHaveLength(1))
    approvals.denyAll()

    expect(await pending).toMatchObject({ ok: false })
  })
})

describe('tools stay inside the workspace', () => {
  it('refuses a write that escapes the root', async () => {
    const { call } = await harness()
    await expect(call('writeFile', { path: '../escape.txt', contents: 'pwned' })).rejects.toThrow()
  })

  it('refuses a read that escapes the root', async () => {
    const { call } = await harness()
    await expect(call('readFile', { path: '../../../../etc/passwd' })).rejects.toThrow()
  })

  it('reports file changes so a UI can refresh without polling', async () => {
    const { call, events } = await harness()
    await call('writeFile', { path: '/tracked.txt', contents: 'x' })

    expect(events.find((e) => e.type === 'workspace.file.changed')).toMatchObject({
      path: '/tracked.txt',
      op: 'created',
    })
  })

  it('distinguishes created from modified', async () => {
    const { call, events, approvals } = await harness()
    await call('writeFile', { path: '/f.txt', contents: 'first' })

    const pending = call('writeFile', { path: '/f.txt', contents: 'second' })
    await vi.waitFor(() => expect(approvals.list()).toHaveLength(1))
    approvals.resolve(approvals.list()[0]!.approvalId, 'allow')
    await pending

    const ops = events
      .filter((e) => e.type === 'workspace.file.changed')
      .map((e) => (e as { op: string }).op)
    expect(ops).toEqual(['created', 'modified'])
  })

  it('truncates a flood of stdout rather than filling the context', async () => {
    const { call, approvals } = await harness()

    const pending = call('runCommand', { command: 'yes abcdefghij | head -c 100000' })
    await vi.waitFor(() => expect(approvals.list()).toHaveLength(1))
    approvals.resolve(approvals.list()[0]!.approvalId, 'allow')

    const result = (await pending) as { stdout: string }
    expect(result.stdout.length).toBeLessThanOrEqual(20_000)
  }, 30_000)
})
