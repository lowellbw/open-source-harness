import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { WorkspaceEvent } from '@workspace/protocol'
import type { Workspace } from '@workspace/workspace'
import type { ApprovalGate } from './approvals.js'

/**
 * The agent's built-in workspace tools.
 *
 * Every path here goes through the `Workspace` seam, so confinement to the
 * workspace root is enforced by `packages/workspace` rather than re-checked
 * here. A tool that did its own path handling would be a second place for that
 * to be wrong.
 */

export const BUILTIN_TOOL_NAMES = ['listFiles', 'readFile', 'writeFile', 'runCommand'] as const

export interface ToolContext {
  workspace: Workspace
  approvals: ApprovalGate
  emit: (event: WorkspaceEvent) => void
  /** Cap on captured stdout, to stop one command flooding the context. */
  maxOutputChars?: number
  commandTimeoutMs?: number
}

export function buildWorkspaceTools(ctx: ToolContext): ToolSet {
  const maxOutput = ctx.maxOutputChars ?? 20_000
  const commandTimeout = ctx.commandTimeoutMs ?? 60_000

  return {
    listFiles: tool({
      description: 'List files and directories in the workspace at a given path.',
      inputSchema: z.object({ path: z.string().describe('Workspace path, e.g. "/"') }),
      execute: async ({ path }) => ({ entries: await ctx.workspace.list(path) }),
    }),

    readFile: tool({
      description: 'Read a text file from the workspace.',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => ({ contents: await ctx.workspace.read(path) }),
    }),

    writeFile: tool({
      description: 'Write a text file to the workspace. Overwrites if it exists.',
      inputSchema: z.object({ path: z.string(), contents: z.string() }),
      execute: async ({ path, contents }) => {
        const existed = await ctx.workspace.exists(path)

        // Only an overwrite is irreversible. Creating a new file destroys
        // nothing, so it does not interrupt — see the note on ApprovalGate
        // about why prompting on everything is worse than prompting on little.
        if (existed) {
          const decision = await ctx.approvals.request(`Overwrite ${path}`, {
            path,
            bytes: contents.length,
          })
          if (decision === 'deny') return { ok: false, reason: 'Denied by user' }
        }

        await ctx.workspace.write(path, contents)
        ctx.emit({
          type: 'workspace.file.changed',
          runId: 'ui',
          ts: Date.now(),
          path,
          op: existed ? 'modified' : 'created',
        })
        return { ok: true, path }
      },
    }),

    runCommand: tool({
      description: 'Run a shell command inside the workspace.',
      inputSchema: z.object({ command: z.string() }),
      execute: async ({ command }) => {
        // Always gated. A shell can do anything the workspace backing allows,
        // and unlike a write there is no cheap way to tell in advance whether a
        // given command destroys something.
        const decision = await ctx.approvals.request(`Run: ${command}`, { command })
        if (decision === 'deny') return { ok: false, reason: 'Denied by user' }

        const result = await ctx.workspace.exec(command, { timeoutMs: commandTimeout })
        return {
          ok: result.exitCode === 0,
          exitCode: result.exitCode,
          stdout: result.stdout.slice(0, maxOutput),
          stderr: result.stderr.slice(0, 4_000),
          timedOut: result.timedOut,
        }
      },
    }),
  }
}
