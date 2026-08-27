import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { WorkspaceEvent } from '@workspace/protocol'
import { buildPptx, verifyDocument } from '@workspace/documents'
import { SessionManager, defaultPolicy } from './index.js'
import { makeSubagentJudge } from './tools-documents.js'

const run = process.env.RUN_LIVE ? describe : describe.skip

/**
 * Gate 3 with a real reviewer.
 *
 * The unit tests use a stub judge, which proves the plumbing and nothing about
 * whether a model can tell a good slide from a broken one. These two tests
 * answer that, and the second is the one that decides whether the gate is real
 * or decoration: a deck that passes gates 1 and 2 and is plainly unreadable.
 */
run('the appearance gate, live', () => {
  async function harness() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-docs-'))
    const manager = new SessionManager({
      workspaceRoot: path.join(dir, 'ws'),
      connectors: { approvalsPath: path.join(dir, 'a.json') },
      defaultModelAlias: 'Light',
    })
    const session = await manager.get('s1', 'Light')
    const events: WorkspaceEvent[] = []
    session.listeners.add((e) => events.push(e))

    const judge = makeSubagentJudge({
      workspace: session.workspace,
      policy: defaultPolicy,
      gateway: session.gateway,
      emit: (e) => events.push(e),
    })

    const cleanup = async () => {
      await manager.dispose()
      await fs.rm(dir, { recursive: true, force: true })
    }

    return { session, events, judge, cleanup }
  }

  it('passes a readable deck', { timeout: 300_000 }, async () => {
    const { session, judge, cleanup } = await harness()

    await buildPptx(session.workspace, '/good.pptx', {
      title: 'The Agentic Workspace',
      subtitle: 'An introduction',
      slides: [
        { title: 'What it is', bullets: ['Your files', 'Your tools', 'Your choice of model'] },
        { title: 'Why now', bullets: ['Parity with Cowork', 'Runs on your machine'] },
      ],
    })

    const result = await verifyDocument(session.workspace, '/good.pptx', {
      request: 'A short deck introducing a product, with a few readable bullets per slide.',
      judge,
    })

    for (const gate of result.gates) {
      console.log(`  ${gate.gate}: ${gate.passed ? 'PASS' : 'FAIL'} — ${gate.detail.slice(0, 600).replace(/\n/g, ' ')}`)
    }

    expect(result.gates.map((g) => g.gate)).toEqual(['structure', 'recalculate', 'appearance'])
    expect(result.ok).toBe(true)
    await cleanup()
  })

  it('FAILS an overflowing deck that passes gates 1 and 2', { timeout: 300_000 }, async () => {
    const { session, judge, cleanup } = await harness()

    await buildPptx(session.workspace, '/bad.pptx', {
      title: 'Too much',
      slides: [
        {
          title: 'Everything at once',
          bullets: Array.from(
            { length: 40 },
            (_, i) =>
              `Point ${i + 1}: a sentence long enough that forty of them cannot possibly fit on a single slide at any legible size.`,
          ),
        },
      ],
    })

    const result = await verifyDocument(session.workspace, '/bad.pptx', {
      request: 'A readable slide with a handful of short bullets.',
      judge,
    })

    for (const gate of result.gates) {
      console.log(`  ${gate.gate}: ${gate.passed ? 'PASS' : 'FAIL'} — ${gate.detail.slice(0, 600).replace(/\n/g, ' ')}`)
    }

    const byGate = Object.fromEntries(result.gates.map((g) => [g.gate, g.passed]))
    // Gates 1 and 2 must PASS, or the fixture is not testing what it claims.
    expect(byGate.structure).toBe(true)
    expect(byGate.recalculate).toBe(true)
    // And gate 3 must catch it. If this ever passes, the gate is decoration.
    expect(byGate.appearance).toBe(false)
    await cleanup()
  })
})
