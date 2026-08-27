import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { WorkspaceEvent } from '@workspace/protocol'
import { SessionManager } from './manager.js'

const run = process.env.RUN_LIVE ? describe : describe.skip

/**
 * A skill has to actually change what the model does.
 *
 * The unit tests prove the file is parsed and the body is withheld until asked
 * for. Neither shows the thing that matters: that a one-line description in
 * the instructions is enough to make a model open the skill, and that opening
 * it changes the answer. That needs a real model, and a skill whose
 * instructions contradict what the model would otherwise do — otherwise a pass
 * proves nothing.
 */
run('skills, live', () => {
  it('opens the relevant skill and follows it', { timeout: 180_000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-skills-'))
    const skillsPath = path.join(dir, 'skills', 'board-pack')
    await fs.mkdir(skillsPath, { recursive: true })

    // The instruction is deliberately contrary: no model writes a board update
    // starting with a line like this unless it read the skill.
    await fs.writeFile(
      path.join(skillsPath, 'SKILL.md'),
      `---
name: board-pack
description: The house format for any board update, board pack or trustees' report. Use whenever one is asked for.
---

# House format

Every board update MUST begin with a single line, exactly:

ASK: <the one decision being requested>

Then a section headed "Why now". Never open with background.
`,
    )

    const manager = new SessionManager({
      workspaceRoot: path.join(dir, 'ws'),
      connectors: { approvalsPath: path.join(dir, 'a.json') },
      skillsPath: path.join(dir, 'skills'),
      defaultModelAlias: 'Light',
      subagents: false,
      documents: false,
      images: false,
    })

    const session = await manager.get('s1', 'Light')
    const events: WorkspaceEvent[] = []
    session.listeners.add((e) => events.push(e))

    const result = await session.agent.send(
      'Write a short board update about our pilot going well and needing another £40k to continue.',
    )

    const opened = events.filter(
      (e) => e.type === 'tool.call.started' && (e as { name: string }).name === 'skill',
    )
    console.log('  skill opened:', opened.length > 0)
    console.log('  reply starts:', result.text.slice(0, 120).replace(/\n/g, ' '))

    // The description alone made it open the skill.
    expect(opened.length).toBeGreaterThan(0)
    // And the instructions changed the output.
    expect(result.text).toMatch(/ASK:/)

    await manager.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  })
})
