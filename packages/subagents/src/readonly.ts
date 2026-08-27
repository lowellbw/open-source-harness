import { WorkspaceError, type Workspace } from '@workspace/workspace'

/**
 * A workspace a scout cannot write to.
 *
 * §9 says subagents are read-only. There are two ways to mean that, and only
 * one of them is true under pressure:
 *
 *   - Tell the model not to write, and give it write tools anyway. This is a
 *     request, and the failure mode is silent — a scout that decides an edit is
 *     obviously helpful makes it, and nothing stops it.
 *   - Take the capability away. Then "read-only" is a property of the object,
 *     not a hope about the prompt.
 *
 * This is the second. It wraps the seam rather than trimming the toolset,
 * because a toolset is a list someone can add to: a new builtin, an MCP tool, a
 * helper that reaches `ctx.workspace` directly. All of them route through here.
 *
 * `exec` is blocked too, and that is the decision worth defending. A shell is a
 * write primitive — `sh -c 'echo x > f'` — so a read-only workspace that allows
 * commands is not read-only. Containment for `exec` comes from the backing
 * being isolated, never from wrapping (see the note in `packages/workspace`),
 * and a scout must be safe on `LocalWorkspace` too. So scouts search and glob
 * without a shell; see `tools.ts`.
 */

export class ReadOnlyViolation extends WorkspaceError {
  constructor(operation: string) {
    super(
      `A subagent may not ${operation}. Scouts read and report; the parent agent makes changes.`,
      'unsupported',
    )
    this.name = 'ReadOnlyViolation'
  }
}

export function readOnly(workspace: Workspace): Workspace {
  // Rejects rather than throwing synchronously. Every method it replaces is
  // typed `Promise<...>`, and a caller writing `workspace.write(x).catch(...)`
  // would crash on a sync throw instead of handling it — the failure landing
  // somewhere entirely different from the code that asked for it.
  const refuse =
    (operation: string) =>
    async (): Promise<never> => {
      throw new ReadOnlyViolation(operation)
    }

  return {
    get id() {
      return workspace.id
    },
    get kind() {
      return workspace.kind
    },
    get capabilities() {
      return workspace.capabilities
    },

    // Reads pass straight through.
    read: (path) => workspace.read(path),
    readBytes: (path) => workspace.readBytes(path),
    list: (path) => workspace.list(path),
    exists: (path) => workspace.exists(path),

    // Writes do not.
    write: refuse('write files'),
    mkdir: refuse('create directories'),
    remove: refuse('delete files'),
    exec: refuse('run shell commands'),

    // Lifecycle belongs to whoever owns the workspace. A scout borrowing one
    // must not be able to dispose of it out from under the parent — start() is
    // idempotent and harmless, the rest are not.
    start: () => workspace.start(),
    suspend: refuse('suspend the workspace'),
    resume: refuse('resume the workspace'),
    snapshot: refuse('snapshot the workspace'),
    dispose: async () => {},
  }
}
