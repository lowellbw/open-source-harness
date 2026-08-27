import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { WorkspaceEvent } from '@workspace/protocol'
import { SessionManager } from './manager.js'

/**
 * The step trace against a real model.
 *
 * Multi-step is asserted here rather than in `packages/core/src/steps.test.ts`
 * because `MockLanguageModelV4` will not advance the tool loop in ai@7.0.79 —
 * see the note there. A live provider does, so this is where the numbering,
 * the per-step cost and the "no double counting" property are actually proved.
 */

const run = process.env.RUN_LIVE ? describe : describe.skip

run('step trace, live', () => {
  it('numbers every step and prices each without double-counting', { timeout: 120_000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-steps-'))
    const manager = new SessionManager({
      workspaceRoot: path.join(dir, 'ws'),
      connectors: { approvalsPath: path.join(dir, 'a.json') },
      defaultModelAlias: 'Light',
      subagents: false,
    })

    const session = await manager.get('s1', 'Light')
    await session.workspace.write('/data.txt', 'the answer is 77')

    const events: WorkspaceEvent[] = []
    session.listeners.add((e) => events.push(e))

    const result = await session.agent.send(
      'Read /data.txt with the readFile tool, then tell me the number it contains.',
    )

    const started = events.filter((e) => e.type === 'step.started') as unknown as {
      stepNumber: number
      activeTools?: string[]
    }[]
    const finished = events.filter((e) => e.type === 'step.finished') as unknown as {
      stepNumber: number
      toolCalls: number
      durationMs?: number
      cost: { usd: number }
    }[]

    for (const step of finished) {
      console.log(
        `  step ${step.stepNumber}: ${step.toolCalls} tool calls, ` +
          `${step.durationMs?.toFixed(0)}ms, $${step.cost.usd.toFixed(6)}`,
      )
    }
    console.log('  reply:', result.text.slice(0, 140).replace(/\n/g, ' '))

    // A turn that reads a file is at least two requests.
    expect(started.length).toBeGreaterThanOrEqual(2)
    expect(finished.length).toBe(started.length)
    expect(finished.map((s) => s.stepNumber)).toEqual(finished.map((_, i) => i))
    expect(finished.some((s) => s.toolCalls > 0)).toBe(true)
    expect(finished.every((s) => (s.durationMs ?? 0) > 0)).toBe(true)

    // The per-step numbers must add up to the turn, not to twice the turn.
    const stepTotal = finished.reduce((sum, s) => sum + s.cost.usd, 0)
    const sessionTotal = session.gateway.totals().session.usd
    console.log(`  steps sum to $${stepTotal.toFixed(6)}, session says $${sessionTotal.toFixed(6)}`)
    expect(sessionTotal).toBeCloseTo(stepTotal, 6)

    expect(result.text).toMatch(/77/)

    await manager.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('sends thinking effort where the model honours it', { timeout: 120_000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-effort-'))
    const manager = new SessionManager({
      workspaceRoot: path.join(dir, 'ws'),
      connectors: { approvalsPath: path.join(dir, 'a.json') },
      defaultModelAlias: 'Light',
      subagents: false,
    })

    const session = await manager.get('s1', 'Light')
    const events: WorkspaceEvent[] = []
    session.listeners.add((e) => events.push(e))

    const runAt = async (effort: 'low' | 'high') => {
      events.length = 0
      session.agent.setReasoningEffort(effort)
      const turn = await session.agent.send(
        'A farmer has 17 sheep. All but 9 run away. How many are left? Think it through.',
      )
      const cost = events.find((e) => e.type === 'cost.updated') as
        | { delta: { reasoningTokens: number } }
        | undefined
      return { turn, reasoning: cost?.delta.reasoningTokens ?? 0 }
    }

    const low = await runAt('low')
    const high = await runAt('high')
    console.log(`  reasoning tokens — low: ${low.reasoning}, high: ${high.reasoning}`)

    /*
     * What is asserted is that the provider ACCEPTS the parameter, because
     * that is the thing that can break: an unsupported knob comes back as a
     * request error, not as a quieter answer.
     *
     * How much the model then chooses to think is its business, and asserting
     * on it makes the test flaky — a model can answer a riddle with no
     * reasoning tokens at all under any setting, which it did here on a run
     * that had produced 19 the time before. That the value is SENT is checked
     * deterministically in packages/core/src/steps.test.ts.
     */
    expect(low.turn.stoppedBy).toBe('complete')
    expect(high.turn.stoppedBy).toBe('complete')
    expect(high.turn.text.length).toBeGreaterThan(0)

    await manager.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  })
})

run('a tool that throws, live', () => {
  it('still reports finished, marked as an error', { timeout: 120_000 }, async () => {
    /*
     * `tool-error` is its own stream part, not a `tool-result` with a flag.
     * Handling only `tool-result` left a failed tool with NO finished event, so
     * its card stayed on "running" for the rest of the session — the user
     * watching something that had already thrown, with nothing to say so.
     *
     * Found by counting cards against steps in the browser: three tool calls,
     * two finished. Asserted live because the mock model will not execute a
     * tool at all, so it cannot produce a tool error.
     */
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-toolerr-'))
    const manager = new SessionManager({
      workspaceRoot: path.join(dir, 'ws'),
      connectors: { approvalsPath: path.join(dir, 'a.json') },
      defaultModelAlias: 'Light',
      subagents: false,
      documents: false,
      images: false,
    })

    const session = await manager.get('s1', 'Light')
    const events: WorkspaceEvent[] = []
    session.listeners.add((e) => events.push(e))

    // readFile on a path that does not exist rejects inside the tool.
    await session.agent.send('Call readFile on the path /definitely-not-here.txt exactly once.')

    const started = events.filter((e) => e.type === 'tool.call.started')
    const finished = events.filter((e) => e.type === 'tool.call.finished') as unknown as {
      isError: boolean
    }[]

    console.log(`  started ${started.length}, finished ${finished.length}`)
    // Every start must have an end. That is the invariant the UI relies on to
    // stop showing a spinner.
    expect(started.length).toBeGreaterThan(0)
    expect(finished.length).toBe(started.length)
    expect(finished.some((f) => f.isError)).toBe(true)

    await manager.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  })
})
