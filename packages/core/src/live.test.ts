import { describe, expect, it } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import type { WorkspaceEvent } from '@workspace/protocol'
import { ModelGateway } from '@workspace/gateway-model'
import { LocalWorkspace } from '@workspace/workspace'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Agent } from './agent.js'

/**
 * Live end-to-end test against a real provider.
 *
 * Opt-in: needs OPENROUTER_API_KEY and RUN_LIVE=1. Skipped by default so CI
 * neither spends money nor fails on someone else's rate limit.
 *
 * It runs against the catalog's cheapest tier and under the budget ceiling, so
 * a full pass costs a fraction of a cent. That it can run at all is the point:
 * the mocked tests prove the logic, this proves the wiring.
 */
const live = Boolean(process.env.OPENROUTER_API_KEY) && process.env.RUN_LIVE === '1'

const policy = {
  orgId: 'org_test',
  userId: 'user_test',
  role: 'learner',
  scope: ['/work'],
  permissions: ['read', 'write'],
  constraints: ['Answer briefly.'],
}

describe.skipIf(!live)('live provider integration', () => {
  it('completes a turn, streams text, and meters real cost', async () => {
    const gateway = new ModelGateway({ limits: { perRunUsd: 0.25, perSessionUsd: 0.5 } })
    const events: WorkspaceEvent[] = []

    const agent = new Agent({
      gateway,
      policy,
      modelAlias: 'Light',
      role: 'learner',
      onEvent: (e) => events.push(e),
    })

    const result = await agent.send('Reply with exactly the word: pong')

    expect(result.stoppedBy).toBe('complete')
    expect(result.text.toLowerCase()).toContain('pong')

    // The stream actually streamed rather than arriving in one lump.
    expect(events.filter((e) => e.type === 'message.delta').length).toBeGreaterThan(0)

    // Real usage came back and priced to something above zero.
    const cost = events.find((e) => e.type === 'cost.updated')
    expect(cost).toBeDefined()
    expect(gateway.totals().session.usd).toBeGreaterThan(0)
    expect(gateway.totals().session.usd).toBeLessThan(0.25)
  }, 120_000)

  it('runs a tool against a real workspace and feeds the result back', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'live-ws-'))
    const ws = new LocalWorkspace({ root })
    await ws.start()
    // Deliberately mundane. An earlier version of this test asked the model to
    // read "secret.txt" and report the "passphrase", and the model refused —
    // correctly, since that reads like an exfiltration request. The refusal
    // looked exactly like broken tool wiring. Test the plumbing with content
    // no reasonable model objects to handling.
    await ws.mkdir('/work')
    await ws.write('/work/config.txt', 'region = eu-west-2')

    const gateway = new ModelGateway({ limits: { perRunUsd: 0.25, perSessionUsd: 0.5 } })
    const events: WorkspaceEvent[] = []

    const agent = new Agent({
      gateway,
      policy,
      modelAlias: 'Light',
      role: 'learner',
      onEvent: (e) => events.push(e),
      tools: {
        readFile: tool({
          description: 'Read a file from the workspace',
          inputSchema: z.object({ path: z.string() }),
          execute: async ({ path: p }) => ({ contents: await ws.read(p) }),
        }),
      },
    })

    const result = await agent.send(
      'Use the readFile tool to read /work/config.txt, then tell me which region is configured.',
    )

    expect(events.some((e) => e.type === 'tool.call.started')).toBe(true)
    expect(events.some((e) => e.type === 'tool.call.finished')).toBe(true)
    expect(result.text.toLowerCase()).toContain('eu-west-2')

    await ws.dispose()
    await fs.rm(root, { recursive: true, force: true })
  }, 180_000)

  it('halts on the budget ceiling instead of running away', async () => {
    // A ceiling this low trips immediately, proving the guard stops the loop
    // rather than merely reporting afterwards.
    const gateway = new ModelGateway({ limits: { perRunUsd: 0.000_001, perSessionUsd: 0.000_001 } })
    gateway.recordUsage('Light', {
      inputTokens: 1000,
      inputTokenDetails: { noCacheTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokens: 100,
      outputTokenDetails: { textTokens: 100, reasoningTokens: 0 },
      totalTokens: 1100,
    })

    const agent = new Agent({ gateway, policy, modelAlias: 'Light', role: 'learner' })
    const result = await agent.send('Say anything.')

    expect(result.stoppedBy).toBe('budget_exceeded')
  }, 60_000)
})

describe('live test wiring', () => {
  it('reports whether the live suite actually ran', () => {
    if (!live) {
      console.warn(
        '[live] skipped — set OPENROUTER_API_KEY and RUN_LIVE=1 to exercise a real provider',
      )
    }
    expect(typeof live).toBe('boolean')
  })
})
