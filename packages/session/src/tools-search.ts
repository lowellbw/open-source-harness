import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { Workspace } from '@workspace/workspace'

/**
 * Finding things in a workspace.
 *
 * Two notes on how these are built.
 *
 * They call `workspace.exec` directly rather than going through the
 * `runCommand` tool, which deliberately bypasses the approval gate. Searching
 * reads; it destroys nothing, so under §9 it must not interrupt. Routing it
 * through the gated tool would prompt on every search and train people to
 * approve without reading.
 *
 * The pattern is passed in the environment, never interpolated into the command
 * string. It comes from model output, which is untrusted: a pattern containing
 * `; rm -rf /` interpolated into a shell command is a straightforward injection,
 * and no amount of quoting is as safe as never putting it there.
 */

export interface SearchToolContext {
  workspace: Workspace
  maxResults?: number
  timeoutMs?: number
}

export function buildSearchTools(ctx: SearchToolContext): ToolSet {
  const maxResults = ctx.maxResults ?? 200
  const timeoutMs = ctx.timeoutMs ?? 30_000

  return {
    searchFiles: tool({
      description:
        'Search file contents across the workspace, like grep. Returns matching lines with ' +
        'their file and line number. Use this to find where something is defined or used.',
      inputSchema: z.object({
        pattern: z.string().describe('Text or basic regular expression to search for'),
        path: z.string().default('/').describe('Directory to search under'),
        filePattern: z
          .string()
          .optional()
          .describe('Restrict to filenames matching this glob, e.g. "*.ts"'),
        ignoreCase: z.boolean().default(false),
      }),
      execute: async ({ pattern, path, filePattern, ignoreCase }) => {
        const flags = ['-rnI', ignoreCase ? '-i' : '', filePattern ? `--include=$INCLUDE` : '']
          .filter(Boolean)
          .join(' ')

        // -I skips binaries; without it a match inside a compiled artifact
        // returns a screenful of control characters.
        const result = await ctx.workspace.exec(
          `grep ${flags} -e "$PATTERN" . 2>/dev/null | head -n ${maxResults}`,
          {
            cwd: path,
            timeoutMs,
            env: { PATTERN: pattern, ...(filePattern ? { INCLUDE: filePattern } : {}) },
          },
        )

        const matches = result.stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [file, lineNumber, ...rest] = line.split(':')
            return {
              file: file ?? '',
              line: Number(lineNumber) || 0,
              text: rest.join(':').slice(0, 400),
            }
          })

        return {
          matches,
          count: matches.length,
          truncated: matches.length >= maxResults,
          // grep exits 1 on "no matches", which is not an error worth reporting
          // as one.
          searched: path,
        }
      },
    }),

    findFiles: tool({
      description:
        'Find files by name pattern, like glob. Returns workspace paths. Use this when you ' +
        'know roughly what a file is called but not where it lives.',
      inputSchema: z.object({
        pattern: z.string().describe('Filename glob, e.g. "*.ts" or "config.*"'),
        path: z.string().default('/').describe('Directory to search under'),
      }),
      execute: async ({ pattern, path }) => {
        const result = await ctx.workspace.exec(
          `find . -type f -name "$PATTERN" -not -path '*/.checkpoints/*' -not -path '*/.elided/*' | head -n ${maxResults}`,
          { cwd: path, timeoutMs, env: { PATTERN: pattern } },
        )

        const files = result.stdout
          .split('\n')
          .filter(Boolean)
          // find prints "./a/b"; workspace paths are rooted.
          .map((file) => file.replace(/^\.\//, '/'))

        return { files, count: files.length, truncated: files.length >= maxResults }
      },
    }),
  }
}
