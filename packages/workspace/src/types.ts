/**
 * The execution seam (PLAN-V2 §3).
 *
 * One interface, several backings: a local process, a Docker container, and
 * later a remote cloud sandbox. The agent core addresses its environment only
 * through this, so the same agent code runs in a Mac sidecar and next to a
 * per-org sandbox pool without knowing the difference.
 *
 * The shape is ported from OpenHands' Python `Workspace` abstraction, which is
 * the reference design. Note it is a genuine port, not a binding: OpenHands'
 * own TypeScript client covers only the remote case, so Local/Docker
 * polymorphism in TS is new work.
 */

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  /** True when the command was killed at `timeoutMs` rather than exiting on its own. */
  timedOut: boolean
  durationMs: number
}

export interface ExecOptions {
  /** Working directory, relative to the workspace root. Defaults to the root. */
  cwd?: string
  env?: Record<string, string>
  /** Defaults to 120_000. A command that hits this is killed and `timedOut` is set. */
  timeoutMs?: number
  /** Written to the process's stdin, then closed. */
  stdin?: string
}

export interface DirEntry {
  name: string
  /** Path relative to the workspace root, always using forward slashes. */
  path: string
  type: 'file' | 'directory' | 'other'
  size: number
}

export interface SnapshotRef {
  id: string
  kind: WorkspaceKind
  createdAt: number
}

export type WorkspaceKind = 'local' | 'docker' | 'remote'

export interface Workspace {
  readonly id: string
  readonly kind: WorkspaceKind

  /** Idempotent. Safe to call more than once. */
  start(): Promise<void>

  /**
   * Runs a shell command. Defaults to the workspace root as cwd.
   *
   * IMPORTANT ASYMMETRY: the file methods below treat a leading "/" as the
   * workspace root, so untrusted model-authored paths stay contained. A shell
   * command does not get that rewriting — its "/" is the real filesystem root
   * of wherever it runs. `exec('cat /etc/passwd')` reads the actual file.
   *
   * Containment for exec therefore comes from the backing being isolated
   * (`capabilities.isolated`), never from path rewriting. This is why
   * LocalWorkspace must not back untrusted work.
   */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>

  read(path: string): Promise<string>
  readBytes(path: string): Promise<Uint8Array>
  write(path: string, contents: string | Uint8Array): Promise<void>
  list(path: string): Promise<DirEntry[]>
  exists(path: string): Promise<boolean>
  mkdir(path: string): Promise<void>
  remove(path: string, options?: { recursive?: boolean }): Promise<void>

  /**
   * Stop consuming CPU while keeping filesystem state.
   *
   * This is the single biggest COGS lever on the hosted side (§5): keeping
   * workspaces warm ten hours a day instead of two can cost more than the seat
   * is sold for. Implementations that cannot genuinely suspend must say so via
   * `capabilities.suspend` rather than pretending.
   */
  suspend(): Promise<void>
  resume(): Promise<void>
  snapshot(): Promise<SnapshotRef>

  /** Releases the backing resource. Idempotent. */
  dispose(): Promise<void>

  readonly capabilities: WorkspaceCapabilities
}

export interface WorkspaceCapabilities {
  /** False for backings where suspend is a recorded no-op rather than real. */
  suspend: boolean
  snapshot: boolean
  /**
   * Whether commands are isolated from the host. False for LocalWorkspace,
   * which runs directly on the machine — never use it for untrusted org work.
   */
  isolated: boolean
}

export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'path_escape'
      | 'not_found'
      | 'not_started'
      | 'unsupported'
      | 'backend_error',
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'WorkspaceError'
  }
}
