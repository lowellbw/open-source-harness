import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { Workspace } from '@workspace/workspace'

/**
 * A scout's file tools, implemented without a shell.
 *
 * `packages/session` already has grep- and find-backed versions of these, and
 * they are better: faster, and they handle a large tree without thinking about
 * it. They are not reusable here, because they work by calling
 * `workspace.exec`, and a scout's workspace refuses to exec — see
 * `readonly.ts` for why a shell and "read-only" cannot coexist.
 *
 * So this walks the tree in JavaScript. That is slower, and the bounds below
 * exist because it is: an unbounded recursive walk on a repository with a
 * `node_modules` is not slow, it is a hang.
 *
 * One thing it gains by not using a shell: there is no command string, so
 * there is no injection surface at all. The session versions have to pass the
 * pattern through the environment to stay safe; here the question never arises.
 */

export interface ScoutToolOptions {
  workspace: Workspace
  /** Files visited per walk. A tree larger than this is reported as truncated. */
  maxFiles?: number
  maxResults?: number
  /** Bytes returned per file. Larger files are truncated rather than refused. */
  maxFileBytes?: number
}

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  // Ours, not the user's work.
  '.checkpoints',
  '.elided',
])

export function buildScoutFileTools(options: ScoutToolOptions): ToolSet {
  const maxFiles = options.maxFiles ?? 5_000
  const maxResults = options.maxResults ?? 200
  const maxFileBytes = options.maxFileBytes ?? 200_000
  const { workspace } = options

  return {
    listFiles: tool({
      description: 'List files and directories at a path in the workspace.',
      inputSchema: z.object({ path: z.string().default('/') }),
      execute: async ({ path }) => ({ entries: await workspace.list(path) }),
    }),

    readFile: tool({
      description: 'Read a text file from the workspace.',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        try {
          const contents = await workspace.read(path)
          return {
            ok: true,
            contents: contents.slice(0, maxFileBytes),
            truncated: contents.length > maxFileBytes,
          }
        } catch (err) {
          return { ok: false, reason: String(err) }
        }
      },
    }),

    searchFiles: tool({
      description:
        'Search file contents across the workspace. Returns matching lines with their file ' +
        'and line number. Use this to find where something is defined or mentioned.',
      inputSchema: z.object({
        pattern: z.string().describe('Text or regular expression to search for'),
        path: z.string().default('/').describe('Directory to search under'),
        filePattern: z
          .string()
          .optional()
          .describe('Restrict to names matching a glob, e.g. "*.ts"'),
        ignoreCase: z.boolean().default(false),
      }),
      execute: async ({ pattern, path, filePattern, ignoreCase }) => {
        let regex: RegExp
        try {
          regex = new RegExp(pattern, ignoreCase ? 'i' : '')
        } catch {
          // A model writing a regex gets it wrong sometimes. Falling back to a
          // literal search is more useful than refusing.
          regex = new RegExp(escapeRegex(pattern), ignoreCase ? 'i' : '')
        }

        const nameFilter = filePattern ? globToRegExp(filePattern) : undefined
        const matches: { file: string; line: number; text: string }[] = []
        let truncated = false

        await walk(workspace, path, maxFiles, async (file) => {
          if (matches.length >= maxResults) {
            truncated = true
            return false
          }
          if (nameFilter && !nameFilter.test(basename(file))) return true

          let contents: string
          try {
            contents = await workspace.read(file)
          } catch {
            // Unreadable. Skipping beats failing the whole search.
            return true
          }
          if (looksBinary(contents)) return true

          const lines = contents.split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= maxResults) {
              truncated = true
              break
            }
            const line = lines[i]!
            // `lastIndex` is not reset between calls for a /g regex, so a
            // global pattern would skip every other match. Not built with /g.
            if (regex.test(line)) {
              matches.push({ file, line: i + 1, text: line.slice(0, 400) })
            }
          }
          return true
        })

        return { matches, count: matches.length, truncated, searched: path }
      },
    }),

    findFiles: tool({
      description:
        'Find files by name pattern, like glob. Returns workspace paths. Use this when you ' +
        'know roughly what a file is called but not where it lives.',
      inputSchema: z.object({
        pattern: z.string().describe('Filename glob, e.g. "*.ts" or "config.*"'),
        path: z.string().default('/'),
      }),
      execute: async ({ pattern, path }) => {
        const nameFilter = globToRegExp(pattern)
        const files: string[] = []
        let truncated = false

        await walk(workspace, path, maxFiles, async (file) => {
          if (files.length >= maxResults) {
            truncated = true
            return false
          }
          if (nameFilter.test(basename(file))) files.push(file)
          return true
        })

        return { files, count: files.length, truncated }
      },
    }),
  }
}

/**
 * Breadth-first walk over files, bounded by a visit budget.
 *
 * `visit` returns false to stop the whole walk. The budget counts files
 * VISITED rather than results returned, so a search that matches nothing in a
 * huge tree still terminates.
 */
async function walk(
  workspace: Workspace,
  root: string,
  maxFiles: number,
  visit: (file: string) => Promise<boolean>,
): Promise<void> {
  const queue = [root]
  let visited = 0

  while (queue.length > 0) {
    const dir = queue.shift()!

    let entries
    try {
      entries = await workspace.list(dir)
    } catch {
      continue
    }

    for (const entry of entries) {
      if (entry.type === 'directory') {
        if (!SKIP_DIRECTORIES.has(entry.name)) queue.push(entry.path)
        continue
      }
      if (entry.type !== 'file') continue

      if (++visited > maxFiles) return
      if (!(await visit(entry.path))) return
    }
  }
}

function basename(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Filename globs only — `*` and `?`, no path semantics. */
function globToRegExp(glob: string): RegExp {
  const source = [...glob]
    .map((char) => (char === '*' ? '.*' : char === '?' ? '.' : escapeRegex(char)))
    .join('')
  return new RegExp(`^${source}$`)
}

/**
 * A NUL byte in the first few KB means binary.
 *
 * The shell version gets this from `grep -I`; without it a match inside a
 * compiled artifact returns a screenful of control characters.
 */
function looksBinary(contents: string): boolean {
  return contents.slice(0, 4_000).includes('\u0000')
}
