import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { WorkspaceEvent } from '@workspace/protocol'
import { SessionManager } from './manager.js'

const run = process.env.RUN_LIVE ? describe : describe.skip

run('scouts and Brave search, live', () => {
  it('dispatches scouts that read but cannot write', { timeout: 180_000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-scout-'))
    const manager = new SessionManager({
      workspaceRoot: path.join(dir, 'ws'),
      connectors: { approvalsPath: path.join(dir, 'a.json') },
      defaultModelAlias: 'Light',
    })

    const session = await manager.get('s1', 'Light')
    const events: WorkspaceEvent[] = []
    session.listeners.add((e) => events.push(e))

    // Give the scouts something real to find.
    await session.workspace.write('/alpha/config.ts', 'export const TIMEOUT_MS = 4321\n')
    await session.workspace.write('/beta/notes.md', '# Beta\n\nOwner: Priya\n')

    const result = await session.agent.send(
      'Use the research tool with exactly two subagents: one to find the numeric value of ' +
        'TIMEOUT_MS anywhere in the workspace, one to find who owns Beta. Then tell me both ' +
        'answers in one short sentence.',
    )

    const started = events.filter((e) => e.type === 'subagent.started')
    const finished = events.filter((e) => e.type === 'subagent.finished') as unknown as {
      cost: { usd: number }
      stoppedBy: string
      reportChars: number
    }[]

    console.log('  scouts started:', started.length, ' finished:', finished.length)
    for (const f of finished) {
      console.log(`    ${f.stoppedBy}, ${f.reportChars} chars, $${f.cost.usd.toFixed(5)}`)
    }
    console.log('  reply:', result.text.slice(0, 220).replace(/\n/g, ' '))

    const reports = await session.workspace.list('/.research').catch(() => [])
    console.log('  reports written:', reports.map((r) => r.name).join(', ') || '(none)')

    expect(started.length).toBeGreaterThanOrEqual(2)
    expect(finished.length).toBe(started.length)
    // Reports land on disk as files, not pasted into the parent's context.
    expect(reports.length).toBeGreaterThanOrEqual(2)
    expect(result.text).toMatch(/4321/)
    expect(result.text).toMatch(/Priya/i)

    await manager.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('uses Brave when the key is present', { timeout: 120_000 }, async () => {
    expect(process.env.BRAVE_API_KEY, 'BRAVE_API_KEY not set').toBeTruthy()

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-brave-'))
    const manager = new SessionManager({
      workspaceRoot: path.join(dir, 'ws'),
      connectors: { approvalsPath: path.join(dir, 'a.json') },
      defaultModelAlias: 'Light',
    })

    const session = await manager.get('s1', 'Light')
    const events: WorkspaceEvent[] = []
    session.listeners.add((e) => events.push(e))

    const result = await session.agent.send(
      'Search the web for the current stable LibreOffice version. One short sentence.',
    )

    const calls = events.filter((e) => e.type === 'tool.call.started') as unknown as {
      name: string
      args: unknown
    }[]
    const search = calls.find((c) => c.name === 'webSearch')
    console.log('  tools called:', calls.map((c) => c.name).join(', ') || '(none)')
    console.log('  query:', JSON.stringify(search?.args))
    console.log('  reply:', result.text.slice(0, 200).replace(/\n/g, ' '))

    // With a key, search becomes an explicit tool call with a visible query —
    // which is the whole reason to prefer it over the provider-native path.
    expect(search, 'expected an explicit webSearch tool call').toBeDefined()

    await manager.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  })
})
