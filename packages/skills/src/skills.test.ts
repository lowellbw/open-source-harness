import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseSkill, SkillParseError } from './parse.js'
import { loadSkills, skillCatalogue } from './registry.js'
import { buildSkillTools } from './tools.js'

const tmpDirs: string[] = []

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function skillDir(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-'))
  tmpDirs.push(root)
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, contents)
  }
  return root
}

const GOOD = `---
name: board-pack
description: Formats a quarterly board pack to the house template. Use whenever someone asks for a board pack, board update or trustees' report.
requires: [createWordDocument, runPython]
version: "1.2"
---

# Board pack

Always lead with the decision being asked for, not the background.

## Structure

1. Decision requested
2. Why now
3. What it costs
`

describe('parsing a SKILL.md', () => {
  it('reads front matter and keeps the body separate', () => {
    const skill = parseSkill(GOOD, '/skills/board-pack/SKILL.md')

    expect(skill.name).toBe('board-pack')
    expect(skill.description).toContain('quarterly board pack')
    expect(skill.requires).toEqual(['createWordDocument', 'runPython'])
    expect(skill.version).toBe('1.2')
    // The body is the expensive half and must not be in the summary.
    expect(skill.body).toContain('Decision requested')
    expect(skill.description).not.toContain('Decision requested')
  })

  it('reads a block list as well as an inline one', () => {
    const skill = parseSkill(
      `---
name: x
description: d
requires:
  - alpha
  - beta
---

body
`,
      '/x.md',
    )
    expect(skill.requires).toEqual(['alpha', 'beta'])
  })

  it('refuses a file with no front matter', () => {
    expect(() => parseSkill('# Just markdown\n', '/x.md')).toThrow(SkillParseError)
  })

  it('refuses front matter with no body', () => {
    // A description pretending to be instructions, costing context every turn
    // to say nothing.
    expect(() => parseSkill('---\nname: x\ndescription: d\n---\n', '/x.md')).toThrow(/no body/i)
  })

  it('refuses a name that is not a safe slug', () => {
    // The name is what the model passes to the tool and what a directory is
    // called. Spaces and slashes in either are a bad time.
    expect(() => parseSkill('---\nname: Board Pack\ndescription: d\n---\n\nbody\n', '/x.md')).toThrow(
      /lowercase/,
    )
  })

  it('names the file in every error', () => {
    // A registry reporting "no front matter" with no path is unactionable when
    // twenty skills are installed.
    try {
      parseSkill('nope', '/skills/thing/SKILL.md')
      throw new Error('should have thrown')
    } catch (err) {
      expect(String(err)).toContain('/skills/thing/SKILL.md')
    }
  })
})

describe('loading a directory of skills', () => {
  it('finds both <name>/SKILL.md and <name>.md', async () => {
    const root = await skillDir({
      'board-pack/SKILL.md': GOOD,
      'quick.md': '---\nname: quick\ndescription: A short one.\n---\n\nBe brief.\n',
    })

    const { skills, errors } = await loadSkills(root)

    expect(errors).toEqual([])
    expect(skills.map((s) => s.name)).toEqual(['board-pack', 'quick'])
  })

  it('reports a broken skill instead of skipping it', async () => {
    // Silently skipping is a behaviour change nobody ordered: the skill is
    // installed, the model never sees it, and nothing says why.
    const root = await skillDir({
      'good.md': '---\nname: good\ndescription: d\n---\n\nbody\n',
      'broken.md': '# no front matter\n',
    })

    const { skills, errors } = await loadSkills(root)

    expect(skills.map((s) => s.name)).toEqual(['good'])
    expect(errors).toHaveLength(1)
    expect(errors[0]!.path).toContain('broken.md')
  })

  it('loads NEITHER of two skills sharing a name', async () => {
    // Picking one silently means a machine behaves differently from its
    // neighbour depending on directory order.
    const root = await skillDir({
      'a/SKILL.md': '---\nname: same\ndescription: first\n---\n\nbody\n',
      'b/SKILL.md': '---\nname: same\ndescription: second\n---\n\nbody\n',
    })

    const { skills, errors } = await loadSkills(root)

    expect(skills).toEqual([])
    expect(errors).toHaveLength(2)
    expect(errors[0]!.reason).toContain('Duplicate skill name')
  })

  it('treats a missing directory as no skills, not an error', async () => {
    expect(await loadSkills('/nonexistent/skills')).toEqual({ skills: [], errors: [] })
  })
})

describe('progressive disclosure', () => {
  it('puts only names and descriptions in the catalogue', () => {
    const skill = parseSkill(GOOD, '/x.md')
    const catalogue = skillCatalogue([skill])

    expect(catalogue).toContain('board-pack')
    expect(catalogue).toContain('quarterly board pack')
    // The whole point: bodies are not paid for until they are wanted.
    expect(catalogue).not.toContain('Decision requested')
  })

  it('is empty when nothing is installed, rather than a heading with no list', () => {
    expect(skillCatalogue([])).toBe('')
  })

  it('registers no tool at all when nothing is installed', () => {
    // An offer to open skills that do not exist is a tool the model will call
    // once and learn nothing from.
    expect(buildSkillTools({ skills: [] })).toEqual({})
  })
})

describe('the skill tool', () => {
  const call = (tools: ReturnType<typeof buildSkillTools>, args: unknown) =>
    (tools.skill!.execute as (a: unknown, o: unknown) => Promise<never>)(args, {})

  it('returns the body only when asked', async () => {
    const skill = parseSkill(GOOD, '/x.md')
    const loaded: string[] = []
    const tools = buildSkillTools({ skills: [skill], onLoad: (s) => loaded.push(s.name) })

    const result = (await call(tools, { name: 'board-pack' })) as {
      ok: boolean
      instructions: string
    }

    expect(result.ok).toBe(true)
    expect(result.instructions).toContain('Decision requested')
    expect(loaded).toEqual(['board-pack'])
  })

  it('says which required tools are missing', async () => {
    // A model following instructions for a tool it does not have will report
    // work it did not do.
    const skill = parseSkill(GOOD, '/x.md')
    const tools = buildSkillTools({
      skills: [skill],
      availableTools: () => ['createWordDocument'],
    })

    const result = (await call(tools, { name: 'board-pack' })) as { unavailable: string[] }
    expect(result.unavailable).toEqual(['runPython'])
  })

  it('says nothing about requirements when they are all present', async () => {
    const skill = parseSkill(GOOD, '/x.md')
    const tools = buildSkillTools({
      skills: [skill],
      availableTools: () => ['createWordDocument', 'runPython'],
    })
    expect(await call(tools, { name: 'board-pack' })).not.toHaveProperty('unavailable')
  })

  it('lists what does exist when asked for a skill that does not', async () => {
    const tools = buildSkillTools({ skills: [parseSkill(GOOD, '/x.md')] })
    expect(await call(tools, { name: 'nope' })).toMatchObject({
      ok: false,
      available: ['board-pack'],
    })
  })
})
