import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { WorkspaceEvent } from '@workspace/protocol'
import { SessionManager } from './manager.js'

const run = process.env.RUN_LIVE ? describe : describe.skip

/**
 * Data analysis, for real.
 *
 * The unit tests prove Python runs and files are noticed. What they cannot
 * show is whether a model, given a CSV and a question, actually reaches for
 * the tool, writes correct pandas, and comes back with the right number —
 * which is the whole of what "can it do data analysis" means.
 */
run('data analysis, live', () => {
  it('answers a question about a CSV and draws a chart', { timeout: 300_000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-py-'))
    const manager = new SessionManager({
      workspaceRoot: path.join(dir, 'ws'),
      connectors: { approvalsPath: path.join(dir, 'a.json') },
      defaultModelAlias: 'Standard',
      subagents: false,
      documents: false,
      images: false,
    })

    const session = await manager.get('s1', 'Standard')

    // A deliberate answer: Northern total is 310, which is not the largest row
    // and not guessable from the shape of the question.
    await session.workspace.write(
      '/sales.csv',
      [
        'region,quarter,revenue',
        'Northern,Q1,120',
        'Northern,Q2,190',
        'Southern,Q1,300',
        'Southern,Q2,95',
        'Western,Q1,80',
        'Western,Q2,140',
      ].join('\n'),
    )

    const events: WorkspaceEvent[] = []
    session.listeners.add((e) => events.push(e))
    // Consent immediately, as a user watching would.
    session.listeners.add((e) => {
      if (e.type === 'approval.requested') {
        session.approvals.resolve((e as { approvalId: string }).approvalId, 'session')
      }
    })

    const result = await session.agent.send(
      'Read /sales.csv. What is total revenue for Northern across both quarters, and which ' +
        'region has the highest total? Also save a bar chart of total revenue by region. ' +
        'Answer in one sentence.',
    )

    const calls = events.filter((e) => e.type === 'tool.call.started') as unknown as {
      name: string
    }[]
    console.log('  tools:', calls.map((c) => c.name).join(', ') || '(none)')
    console.log('  reply:', result.text.slice(0, 220).replace(/\n/g, ' '))

    const files = await session.workspace.exec('find . -name "*.png" -not -path "./.render/*"', {
      timeoutMs: 20_000,
    })
    console.log('  charts:', files.stdout.trim().replace(/\n/g, ', ') || '(none)')

    expect(calls.some((c) => c.name === 'runPython')).toBe(true)
    // 120 + 190 = 310, and Southern totals 395.
    expect(result.text).toMatch(/310/)
    expect(result.text).toMatch(/Southern/i)
    expect(files.stdout.trim().length).toBeGreaterThan(0)

    await manager.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  })
})
