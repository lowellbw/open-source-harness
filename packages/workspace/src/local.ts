import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  WorkspaceError,
  type DirEntry,
  type ExecOptions,
  type ExecResult,
  type SnapshotRef,
  type Workspace,
  type WorkspaceCapabilities,
} from './types.js'
import { assertRealPathInRoot, resolveInRoot, toWorkspacePath } from './paths.js'

export interface LocalWorkspaceOptions {
  /** Host directory backing the workspace. Created if absent. */
  root: string
  id?: string
  /** Default per-command timeout. Defaults to 120s. */
  defaultTimeoutMs?: number
}

/**
 * Host-backed workspace: commands run directly on this machine.
 *
 * Fast, dependency-free, and the right choice for local development and for the
 * Mac app's own sidecar, where the user's machine IS the intended environment.
 * It is NOT isolation — `capabilities.isolated` is false and means it. Never
 * back multi-tenant or untrusted work with this; that is what DockerWorkspace
 * is for (§4: never share a sandbox across orgs).
 */
export class LocalWorkspace implements Workspace {
  readonly kind = 'local' as const
  readonly id: string
  readonly capabilities: WorkspaceCapabilities = {
    // A host directory cannot be frozen. Reported honestly rather than faked,
    // so callers relying on suspend for cost control can detect it.
    suspend: false,
    snapshot: true,
    isolated: false,
  }

  private readonly root: string
  private readonly defaultTimeoutMs: number
  private started = false

  constructor(options: LocalWorkspaceOptions) {
    this.root = path.resolve(options.root)
    this.id = options.id ?? `local-${randomUUID().slice(0, 8)}`
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000
  }

  async start(): Promise<void> {
    if (this.started) return
    await fs.mkdir(this.root, { recursive: true })
    this.started = true
  }

  private assertStarted(): void {
    if (!this.started) {
      throw new WorkspaceError('Workspace not started; call start() first', 'not_started')
    }
  }

  private async resolve(input: string): Promise<string> {
    const resolved = resolveInRoot(this.root, input)
    await assertRealPathInRoot(this.root, resolved)
    return resolved
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    this.assertStarted()
    const cwd = options.cwd ? await this.resolve(options.cwd) : this.root
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
    const startedAt = Date.now()

    return await new Promise<ExecResult>((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', command], {
        cwd,
        env: { ...process.env, ...options.env },
        // Own process group, so a timeout can kill the whole tree.
        // Without this, killing the shell orphans its children: they keep the
        // stdout pipe open, 'close' never fires, and the timeout silently fails
        // to bound anything. An agent harness must be able to stop a runaway
        // command, so this is a safety property, not a tidiness one.
        detached: true,
      })

      let stdout = ''
      let stderr = ''
      let timedOut = false

      const timer = setTimeout(() => {
        timedOut = true
        killTree(child.pid)
      }, timeoutMs)

      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString()
      })
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString()
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        reject(new WorkspaceError(`Failed to run command: ${command}`, 'backend_error', { cause: err }))
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({
          stdout,
          stderr,
          // A SIGKILL'd process reports a null exit code; surface the
          // conventional 124 for "timed out" rather than a confusing 0.
          exitCode: timedOut ? 124 : (code ?? 0),
          timedOut,
          durationMs: Date.now() - startedAt,
        })
      })

      if (options.stdin !== undefined) child.stdin.end(options.stdin)
      else child.stdin.end()
    })
  }

  async read(filePath: string): Promise<string> {
    const bytes = await this.readBytes(filePath)
    return Buffer.from(bytes).toString('utf8')
  }

  async readBytes(filePath: string): Promise<Uint8Array> {
    this.assertStarted()
    const resolved = await this.resolve(filePath)
    try {
      return new Uint8Array(await fs.readFile(resolved))
    } catch (err) {
      throw notFound(err, filePath)
    }
  }

  async write(filePath: string, contents: string | Uint8Array): Promise<void> {
    this.assertStarted()
    const resolved = await this.resolve(filePath)
    await fs.mkdir(path.dirname(resolved), { recursive: true })
    await fs.writeFile(resolved, contents)
  }

  async list(dirPath: string): Promise<DirEntry[]> {
    this.assertStarted()
    const resolved = await this.resolve(dirPath)
    let entries
    try {
      entries = await fs.readdir(resolved, { withFileTypes: true })
    } catch (err) {
      throw notFound(err, dirPath)
    }

    const out: DirEntry[] = []
    for (const entry of entries) {
      const abs = path.join(resolved, entry.name)
      let size = 0
      try {
        size = (await fs.stat(abs)).size
      } catch {
        // A broken symlink or a file deleted between readdir and stat should
        // not blow up a directory listing.
      }
      out.push({
        name: entry.name,
        path: toWorkspacePath(this.root, abs),
        type: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other',
        size,
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  async exists(filePath: string): Promise<boolean> {
    this.assertStarted()
    try {
      const resolved = await this.resolve(filePath)
      await fs.stat(resolved)
      return true
    } catch {
      return false
    }
  }

  async mkdir(dirPath: string): Promise<void> {
    this.assertStarted()
    await fs.mkdir(await this.resolve(dirPath), { recursive: true })
  }

  async remove(filePath: string, options: { recursive?: boolean } = {}): Promise<void> {
    this.assertStarted()
    const resolved = await this.resolve(filePath)
    await fs.rm(resolved, { recursive: options.recursive ?? false, force: true })
  }

  /** No-op by construction — see `capabilities.suspend`. */
  async suspend(): Promise<void> {}
  async resume(): Promise<void> {}

  async snapshot(): Promise<SnapshotRef> {
    this.assertStarted()
    const id = `snap-${randomUUID().slice(0, 8)}`
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-snap-'))
    const archive = path.join(dir, `${id}.tar.gz`)
    const result = await this.execHost(`tar -czf ${JSON.stringify(archive)} -C ${JSON.stringify(this.root)} .`)
    if (result.exitCode !== 0) {
      throw new WorkspaceError(`Snapshot failed: ${result.stderr}`, 'backend_error')
    }
    return { id: archive, kind: this.kind, createdAt: Date.now() }
  }

  async dispose(): Promise<void> {
    this.started = false
  }

  /** Runs on the host outside the root — snapshotting needs to write elsewhere. */
  private execHost(command: string): Promise<ExecResult> {
    const startedAt = Date.now()
    return new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-c', command])
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      child.on('close', (code) =>
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 0,
          timedOut: false,
          durationMs: Date.now() - startedAt,
        }),
      )
    })
  }
}

/**
 * Kills a detached child and everything it spawned.
 *
 * Negating the pid targets the process group, which is why `exec` spawns with
 * `detached: true`. Falls back to the bare pid if the group is already gone.
 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already exited between the timer firing and this call.
    }
  }
}

function notFound(err: unknown, requested: string): WorkspaceError {
  if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
    return new WorkspaceError(`No such file or directory: ${requested}`, 'not_found', { cause: err })
  }
  return new WorkspaceError(`Filesystem error on ${requested}`, 'backend_error', { cause: err })
}
