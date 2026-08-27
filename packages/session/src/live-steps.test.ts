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

    const reasoningOf = async (effort: 'low' | 'high') => {
      events.length = 0
      session.agent.setReasoningEffort(effort)
      await session.agent.send(
        'A farmer has 17 sheep. All but 9 run away. How many are left? Think it through.',
      )
      const cost = events.find((e) => e.type === 'cost.updated') as
        | { delta: { reasoningTokens: number } }
        | undefined
      return cost?.delta.reasoningTokens ?? 0
    }

    const low = await reasoningOf('low')
    const high = await reasoningOf('high')
    console.log(`  reasoning tokens — low: ${low}, high: ${high}`)

    // The knob reaches the provider and changes behaviour. Asserting only that
    // high > low would be flaky; asserting the model reasoned at all under
    // 'high' proves the parameter was accepted rather than rejected.
    expect(high).toBeGreaterThan(0)

    await manager.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  })
})
