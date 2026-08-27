import fs from 'node:fs/promises'
import path from 'node:path'
import { parseSkill, SkillParseError, type ParsedSkill } from './parse.js'

/**
 * The installed skills.
 *
 * A curated local directory, and only that. §11 is explicit that an open
 * marketplace is not on the table, and the reason is not caution about
 * quality: a skill is instructions that go into the model's context and are
 * followed. Installing one from a stranger is running their code, with the
 * difference that nothing in the system treats it as code.
 *
 * So skills come from a directory an administrator controls, they are read at
 * start-up, and a malformed one is reported rather than skipped — a skill that
 * silently fails to load is a behaviour change nobody ordered.
 */

export interface SkillLoadError {
  path: string
  reason: string
}

export interface SkillRegistryResult {
  skills: ParsedSkill[]
  errors: SkillLoadError[]
}

/**
 * Reads every skill under a directory.
 *
 * Layout follows the convention: `<root>/<skill-name>/SKILL.md`. A bare
 * `<root>/<name>.md` is also accepted, because insisting on a directory for a
 * twelve-line skill is friction with nothing behind it.
 */
export async function loadSkills(root: string): Promise<SkillRegistryResult> {
  const skills: ParsedSkill[] = []
  const errors: SkillLoadError[] = []

  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    // No directory is not an error. Most installations have no skills.
    return { skills, errors }
  }

  const candidates: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      candidates.push(path.join(root, entry.name, 'SKILL.md'))
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      candidates.push(path.join(root, entry.name))
    }
  }

  for (const candidate of candidates) {
    let source: string
    try {
      source = await fs.readFile(candidate, 'utf8')
    } catch {
      // A directory with no SKILL.md is not a skill. Silent on purpose.
      continue
    }

    try {
      skills.push(parseSkill(source, candidate))
    } catch (err) {
      errors.push({
        path: candidate,
        reason: err instanceof SkillParseError ? err.message : String(err),
      })
    }
  }

  // Two skills with the same name would make `loadSkill` ambiguous, and which
  // one won would depend on directory order. Neither is loaded: picking one
  // silently is how a machine ends up behaving differently from its neighbour
  // for a reason nobody can see.
  const byName = new Map<string, ParsedSkill[]>()
  for (const skill of skills) {
    byName.set(skill.name, [...(byName.get(skill.name) ?? []), skill])
  }

  const loaded: ParsedSkill[] = []
  for (const [name, group] of byName) {
    if (group.length === 1) {
      loaded.push(group[0]!)
      continue
    }
    for (const duplicate of group) {
      errors.push({
        path: duplicate.path,
        reason: `Duplicate skill name "${name}", also defined by ${group
          .filter((s) => s !== duplicate)
          .map((s) => s.path)
          .join(', ')}. None of them is loaded.`,
      })
    }
  }

  return {
    skills: loaded.sort((a, b) => a.name.localeCompare(b.name)),
    errors,
  }
}

/**
 * The line about each skill that goes into every request.
 *
 * This is the whole of progressive disclosure: names and descriptions are
 * cheap and always present, bodies are expensive and fetched on demand. Twenty
 * skills cost perhaps three hundred tokens here; twenty skill bodies would
 * cost tens of thousands, on every turn, to be relevant on one of them.
 */
export function skillCatalogue(skills: ParsedSkill[]): string {
  if (skills.length === 0) return ''

  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}`)
  return (
    'Available skills. Each is a set of instructions for a specific kind of task.\n' +
    'Read one with the `skill` tool BEFORE starting work it covers — the description\n' +
    'is only a summary, and the instructions matter.\n\n' +
    lines.join('\n')
  )
}
