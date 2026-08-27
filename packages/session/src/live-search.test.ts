import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { WorkspaceEvent } from '@workspace/protocol'
import { SessionManager } from './manager.js'

const run = process.env.RUN_LIVE ? describe : describe.skip

run('provider-native web search, live', () => {
  it('searches, cites, and lands on the meter', { timeout: 120_000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-search-'))
    const manager = new SessionManager({
      workspaceRoot: path.join(dir, 'ws'),
      connectors: { approvalsPath: path.join(dir, 'a.json') },
      searchProvider: undefined,
      defaultModelAlias: 'Light',
    })

    const session = await manager.get('s1', 'Light')
    const events: WorkspaceEvent[] = []
    session.listeners.add((e) => events.push(e))

    const result = await session.agent.send(
      'Search the web: what is the current stable version of LibreOffice? One sentence, cite the URL.',
    )

    const sources = events.filter((e) => e.type === 'source.cited') as unknown as {
      url: string
      title: string
    }[]
    console.log('  reply:', result.text.slice(0, 200).replace(/\n/g, ' '))
    for (const s of sources) console.log('  cited:', s.title, '—', s.url)

    const cost = events.find((e) => e.type === 'cost.updated') as
      | { delta: { webSearches: number; usd: number } }
      | undefined
    console.log('  searches metered:', cost?.delta.webSearches, ' cost: $' + cost?.delta.usd.toFixed(5))

    expect(result.stoppedBy).toBe('complete')
    // The whole point of the citation event: without it a searched answer is
    // indistinguishable from an asserted one.
    expect(sources.length).toBeGreaterThan(0)
    expect(sources[0]!.url).toMatch(/^https?:\/\//)
    expect(cost?.delta.webSearches).toBeGreaterThan(0)
    // The search is billed per call, so it must dominate a cheap-tier turn.
    expect(cost?.delta.usd).toBeGreaterThan(0.003)

    await manager.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  })
})
