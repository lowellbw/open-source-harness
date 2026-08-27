import { z } from 'zod'

/**
 * Reading a SKILL.md.
 *
 * A skill is a Markdown file with YAML front matter. The format is Anthropic's
 * and is deliberately followed rather than invented: people already have these
 * written, and a near-miss format that silently ignores half of someone's file
 * is worse than no support at all.
 *
 * Following a format is not deriving from an implementation. This parser was
 * written against the published shape — a fenced `---` block of key/value
 * pairs, then prose — and nothing here comes from Anthropic's document skills,
 * which is a separate matter and a CLAUDE.md invariant.
 */

export const skillFrontmatterSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
      'A skill name must be lowercase, with words separated by single hyphens.',
    ),
  /**
   * The one line the model sees for every installed skill, always.
   *
   * This is the entire budget for deciding whether to open a skill, so it has
   * to say when to use it, not what it is. "Formats a quarterly board pack to
   * the Apolitical template" is useful; "board pack helper" is not.
   */
  description: z.string().min(1).max(1_024),
  /** Free-form, for a registry listing. Not sent to the model. */
  version: z.string().optional(),
  license: z.string().optional(),
  /**
   * Tools this skill expects to be available.
   *
   * Advisory. Recorded so a skill that needs `runPython` can say so and the
   * loader can warn when it is missing, rather than the model following
   * instructions it has no way to carry out.
   */
  requires: z.array(z.string()).default([]),
})

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>

export interface ParsedSkill extends SkillFrontmatter {
  /** The prose after the front matter. Loaded on demand, never up front. */
  body: string
  /** Where it came from, for the UI and for error messages. */
  path: string
}

export class SkillParseError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${path}: ${message}`)
    this.name = 'SkillParseError'
  }
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function parseSkill(source: string, path: string): ParsedSkill {
  const match = FENCE.exec(source)
  if (!match) {
    throw new SkillParseError(
      'No front matter. A skill starts with a --- fenced block containing at least a name and a description.',
      path,
    )
  }

  const frontmatter = parseFrontmatter(match[1] ?? '', path)
  const body = source.slice(match[0].length).trim()

  if (!body) {
    // A skill with no body is a description pretending to be instructions,
    // and it costs context every turn to say nothing.
    throw new SkillParseError('Front matter but no body. There is nothing to load.', path)
  }

  const parsed = skillFrontmatterSchema.safeParse(frontmatter)
  if (!parsed.success) {
    throw new SkillParseError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'front matter'}: ${i.message}`).join('; '),
      path,
    )
  }

  return { ...parsed.data, body, path }
}

/**
 * A deliberately small YAML subset: `key: value`, and `key: [a, b]` or a
 * block list for arrays.
 *
 * Pulling in a YAML parser for this would be a dependency, a parser with its
 * own history of surprises, and an invitation to write skills whose front
 * matter needs a parser to understand. Anything this cannot read is a file
 * whose front matter is too clever, and it says so rather than guessing.
 */
function parseFrontmatter(block: string, path: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const lines = block.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.trim() || line.trimStart().startsWith('#')) continue

    // A block list belongs to the key above it.
    if (/^\s*-\s+/.test(line)) continue

    const separator = line.indexOf(':')
    if (separator === -1) {
      throw new SkillParseError(`Cannot read front matter line: ${line.trim()}`, path)
    }

    const key = line.slice(0, separator).trim()
    const raw = line.slice(separator + 1).trim()

    if (raw === '') {
      // Collect an indented block list.
      const items: string[] = []
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!
        if (!/^\s*-\s+/.test(next)) break
        items.push(unquote(next.replace(/^\s*-\s+/, '').trim()))
        i = j
      }
      out[key] = items
      continue
    }

    if (raw.startsWith('[') && raw.endsWith(']')) {
      out[key] = raw
        .slice(1, -1)
        .split(',')
        .map((v) => unquote(v.trim()))
        .filter(Boolean)
      continue
    }

    out[key] = unquote(raw)
  }

  return out
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}
