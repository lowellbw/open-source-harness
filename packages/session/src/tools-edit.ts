import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { WorkspaceEvent } from '@workspace/protocol'
import type { Workspace } from '@workspace/workspace'
import { listCheckpoints, restore, snapshot } from './checkpoints.js'

/**
 * Surgical editing, and the undo that makes it safe.
 *
 * `writeFile` is the wrong tool for changing one line: the model has to
 * reproduce the entire file from memory, which is slow, expensive, and the most
 * common way an agent silently destroys work it was not asked to touch.
 */

export interface EditToolContext {
  workspace: Workspace
  emit: (event: WorkspaceEvent) => void
}

export function buildEditTools(ctx: EditToolContext): ToolSet {
  return {
    editFile: tool({
      description:
        'Replace an exact string in a file. Prefer this over writeFile for changing existing ' +
        'files: it only touches what you name, and the original is snapshotted so the edit can ' +
        'be undone. The oldString must match exactly, including whitespace and indentation.',
      inputSchema: z.object({
        path: z.string(),
        oldString: z.string().describe('Exact text to replace, including surrounding context'),
        newString: z.string().describe('What to replace it with'),
        replaceAll: z
          .boolean()
          .default(false)
          .describe('Replace every occurrence. Without this, an ambiguous match is refused.'),
      }),
      execute: async ({ path, oldString, newString, replaceAll }) => {
        if (!(await ctx.workspace.exists(path))) {
          return { ok: false, reason: `No such file: ${path}` }
        }
        if (oldString === newString) {
          return { ok: false, reason: 'oldString and newString are identical — nothing to do' }
        }

        const before = await ctx.workspace.read(path)
        const occurrences = countOccurrences(before, oldString)

        if (occurrences === 0) {
          // Failing loudly beats a silent no-op that the model reports as success.
          return {
            ok: false,
            reason:
              `oldString not found in ${path}. It must match exactly, including whitespace ` +
              `and indentation. Read the file again and copy the text verbatim.`,
          }
        }

        if (occurrences > 1 && !replaceAll) {
          // Refusing an ambiguous edit is the whole point: picking the first
          // match silently changes the wrong line about half the time.
          return {
            ok: false,
            reason:
              `oldString appears ${occurrences} times in ${path}. Include more surrounding ` +
              `context to identify which one you mean, or pass replaceAll.`,
          }
        }

        // Snapshot first. This is what makes the edit reversible, which is what
        // means it does not have to interrupt the user for approval.
        const checkpoint = await snapshot(ctx.workspace, path)

        const after = replaceAll
          ? before.split(oldString).join(newString)
          : before.replace(oldString, newString)

        await ctx.workspace.write(path, after)
        ctx.emit({
          type: 'workspace.file.changed',
          runId: 'ui',
          ts: Date.now(),
          path,
          op: 'modified',
        })

        return {
          ok: true,
          path,
          replacements: replaceAll ? occurrences : 1,
          undo: checkpoint?.checkpointPath,
        }
      },
    }),

    restoreFile: tool({
      description:
        'Undo changes to a file by restoring its most recent snapshot. Snapshots are taken ' +
        'automatically before each edit. Restoring also snapshots the current state, so an ' +
        'unwanted undo can itself be undone.',
      inputSchema: z.object({
        path: z.string(),
        checkpointPath: z
          .string()
          .optional()
          .describe('A specific snapshot. Defaults to the most recent.'),
      }),
      execute: async ({ path, checkpointPath }) => {
        const result = await restore(ctx.workspace, path, checkpointPath)
        if (result.ok) {
          ctx.emit({
            type: 'workspace.file.changed',
            runId: 'ui',
            ts: Date.now(),
            path,
            op: 'modified',
          })
        }
        return result
      },
    }),

    listCheckpoints: tool({
      description: 'List available snapshots for a file, most recent first.',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => ({
        checkpoints: (await listCheckpoints(ctx.workspace, path)).map((c) => ({
          path: c.checkpointPath,
          takenAt: new Date(c.takenAt).toISOString(),
        })),
      }),
    }),
  }
}

/** `split().length - 1` rather than a regex, so the needle needs no escaping. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  return haystack.split(needle).length - 1
}
