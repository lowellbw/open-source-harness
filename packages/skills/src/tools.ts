import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { skillCatalogue, type ParsedSkill } from './registry.js'

/**
 * Opening a skill.
 *
 * One tool, and the interesting decisions are about what it returns rather
 * than what it does.
 *
 * It returns the body as DATA, framed as instructions the user's administrator
 * installed. A skill is trusted input — it comes from a curated directory, not
 * from the web — but "trusted" is a property of where it came from, and saying
 * so explicitly is what keeps that property visible if the directory ever
 * stops being curated.
 *
 * It also names the tools the skill expects and flags any that are missing,
 * because a model following instructions for a tool it does not have produces
 * a confident description of work it did not do.
 */

export interface SkillToolOptions {
  skills: ParsedSkill[]
  /** Called when a skill is opened, so the trace can show it. */
  onLoad?: (skill: ParsedSkill) => void
  /** Names of tools currently available, for the missing-requirement check. */
  availableTools?: () => string[]
}

export const SKILL_TOOL_NAME = 'skill'

export function buildSkillTools(options: SkillToolOptions): ToolSet {
  if (options.skills.length === 0) return {}

  const byName = new Map(options.skills.map((skill) => [skill.name, skill]))

  return {
    [SKILL_TOOL_NAME]: tool({
      description:
        'Read the full instructions for an installed skill. The list you have been given ' +
        'carries only one-line descriptions; the instructions themselves are here. Open the ' +
        'relevant skill BEFORE starting a task it covers, not after — a skill exists because ' +
        'the obvious approach to that task is not the wanted one.',
      inputSchema: z.object({
        name: z
          .string()
          .describe(`One of: ${[...byName.keys()].join(', ')}`),
      }),
      execute: async ({ name }) => {
        const skill = byName.get(name)
        if (!skill) {
          return {
            ok: false,
            reason: `No skill called "${name}".`,
            available: [...byName.keys()],
          }
        }

        options.onLoad?.(skill)

        const available = options.availableTools?.()
        const missing = available
          ? skill.requires.filter((required) => !available.includes(required))
          : []

        return {
          ok: true,
          name: skill.name,
          instructions: skill.body,
          ...(missing.length > 0
            ? {
                // Said plainly rather than left to be discovered. A model that
                // follows instructions for a tool it does not have reports work
                // it did not do.
                unavailable: missing,
                note:
                  `This skill expects ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} ` +
                  `not available here. Follow the parts you can and say which parts you could not.`,
              }
            : {}),
        }
      },
    }),
  }
}

/** The catalogue line for the system instructions. Empty when none installed. */
export function skillInstructions(skills: ParsedSkill[]): string {
  return skillCatalogue(skills)
}
