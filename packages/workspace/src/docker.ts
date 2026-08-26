import { spawn } from 'node:child_process'
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
import { resolveInRoot, toWorkspacePath } from './paths.js'

const CONTAINER_ROOT = '/work'

export interface DockerWorkspaceOptions {
  /** Defaults to node:22-slim, matching the repo's runtime. */
  image?: string
  id?: string
  defaultTimeoutMs?: number
  env?: Record<string, string>
  /**
   * Defaults to 'none'. §4 requires default-deny egress; opening this up is a
   * deliberate act, never the default.
   */
  network?: string
  memory?: string
}

/**
 * Container-backed workspace. This is the isolated one.
 *
 * Driven through the docker CLI rather than a daemon client library: it adds no
 * dependency, and the CLI's behaviour is the thing operators already know how
 * to debug.
 */
export class DockerWorkspace implements Workspace {
  readonly kind = 'docker' as const
  readonly id: string
  readonly capabilities: WorkspaceCapabilities = {
    suspend: true,
    snapshot: true,
    isolated: true,
  }

  private readonly image: string
  private readonly defaultTimeoutMs: number
  private readonly env: Record<string, string>
  private readonly network: string
  private readonly memory: string | undefined
  private containerId: string | undefined

  constructor(options: DockerWorkspaceOptions = {}) {
    this.image = options.image ?? 'node:22-slim'
    this.id = options.id ?? `ws-${randomUUID().slice(0, 8)}`
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000
    this.env = options.env ?? {}
    this.network = options.network ?? 'none'
    this.memory = options.memory
  }

  async start(): Promise<void> {
    if (this.containerId) return

    const args = ['run', '-d', '--name', this.id, '-w', CONTAINER_ROOT, `--network=${this.network}`]
    if (this.memory) args.push(`--memory=${this.memory}`)
    for (const [k, v] of Object.entries(this.env)) args.push('-e', `${k}=${v}`)
    // The container must outlive the `run` call so exec has something to attach
    // to; sleep infinity is the conventional keep-alive.
    args.push(this.image, 'sh', '-c', `mkdir -p ${CONTAINER_ROOT} && sleep infinity`)

    const created = await docker(args)
    if (created.exitCode !== 0) {
      throw new WorkspaceError(
        `Could not start container from ${this.image}: ${created.stderr.trim()}`,
        'backend_error',
      )
    }
    this.containerId = created.stdout.trim()
  }

  private assertStarted(): string {
    if (!this.containerId) {
      throw new WorkspaceError('Workspace not started; call start() first', 'not_started')
    }
    return this.id
  }

  /** Container paths are always POSIX, whatever the host running this client is. */
  private resolve(input: string): string {
    return resolveInRoot(CONTAINER_ROOT, input, path.posix)
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const name = this.assertStarted()
    const cwd = options.cwd ? this.resolve(options.cwd) : CONTAINER_ROOT
    const args = ['exec', '-w', cwd]
    for (const [k, v] of Object.entries(options.env ?? {})) args.push('-e', `${k}=${v}`)
    if (options.stdin !== undefined) args.push('-i')
    args.push(name, 'sh', '-c', command)

    return await docker(args, {
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    })
  }

  async read(filePath: string): Promise<string> {
    return Buffer.from(await this.readBytes(filePath)).toString('utf8')
  }

  async readBytes(filePath: string): Promise<Uint8Array> {
    const name = this.assertStarted()
    const resolved = this.resolve(filePath)
    // Raw mode: `cat` output must not be decoded as UTF-8 or binary files corrupt.
    const result = await dockerRaw(['exec', name, 'cat', resolved])
    if (result.exitCode !== 0) {
      throw new WorkspaceError(`No such file or directory: ${filePath}`, 'not_found')
    }
    return new Uint8Array(result.stdout)
  }

  async write(filePath: string, contents: string | Uint8Array): Promise<void> {
    const name = this.assertStarted()
    const resolved = this.resolve(filePath)
    const dir = path.posix.dirname(resolved)

    // Streamed through stdin rather than embedded in the command line: argument
    // length is capped by ARG_MAX, and a file the agent generated can easily
    // exceed it.
    const result = await dockerRaw(
      ['exec', '-i', name, 'sh', '-c', `mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(resolved)}`],
      { stdinBytes: typeof contents === 'string' ? Buffer.from(contents, 'utf8') : Buffer.from(contents) },
    )
    if (result.exitCode !== 0) {
      throw new WorkspaceError(
        `Write failed for ${filePath}: ${result.stderr.toString().trim()}`,
        'backend_error',
      )
    }
  }

  async list(dirPath: string): Promise<DirEntry[]> {
    const name = this.assertStarted()
    const resolved = this.resolve(dirPath)
    // -1 gives one entry per line; %s and %F come from stat, keeping parsing
    // simple and locale-independent.
    const result = await docker([
      'exec',
      name,
      'sh',
      '-c',
      `cd ${shellQuote(resolved)} 2>/dev/null && for f in * .[!.]*; do [ -e "$f" ] || continue; printf '%s\\t%s\\t%s\\n' "$f" "$(stat -c %s "$f")" "$(stat -c %F "$f")"; done`,
    ])
    if (result.exitCode !== 0) {
      throw new WorkspaceError(`No such file or directory: ${dirPath}`, 'not_found')
    }

    const entries: DirEntry[] = []
    for (const line of result.stdout.split('\n')) {
      if (!line.trim()) continue
      const [entryName, size, kind] = line.split('\t')
      if (!entryName) continue
      entries.push({
        name: entryName,
        path: toWorkspacePath(CONTAINER_ROOT, path.posix.join(resolved, entryName)),
        type: kind === 'directory' ? 'directory' : kind === 'regular file' || kind === 'regular empty file' ? 'file' : 'other',
        size: Number(size ?? 0) || 0,
      })
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name))
  }

  async exists(filePath: string): Promise<boolean> {
    const name = this.assertStarted()
    let resolved: string
    try {
      resolved = this.resolve(filePath)
    } catch {
      return false
    }
    const result = await docker(['exec', name, 'sh', '-c', `test -e ${shellQuote(resolved)}`])
    return result.exitCode === 0
  }

  async mkdir(dirPath: string): Promise<void> {
    const name = this.assertStarted()
    await docker(['exec', name, 'mkdir', '-p', this.resolve(dirPath)])
  }

  async remove(filePath: string, options: { recursive?: boolean } = {}): Promise<void> {
    const name = this.assertStarted()
    const resolved = this.resolve(filePath)
    await docker(['exec', name, 'rm', options.recursive ? '-rf' : '-f', resolved])
  }

  async suspend(): Promise<void> {
    const name = this.assertStarted()
    const result = await docker(['pause', name])
    // Pausing an already-paused container is not a failure worth propagating.
    if (result.exitCode !== 0 && !result.stderr.includes('is already paused')) {
      throw new WorkspaceError(`Suspend failed: ${result.stderr.trim()}`, 'backend_error')
    }
  }

  async resume(): Promise<void> {
    const name = this.assertStarted()
    const result = await docker(['unpause', name])
    if (result.exitCode !== 0 && !result.stderr.includes('is not paused')) {
      throw new WorkspaceError(`Resume failed: ${result.stderr.trim()}`, 'backend_error')
    }
  }

  async snapshot(): Promise<SnapshotRef> {
    const name = this.assertStarted()
    const tag = `workspace-snap:${randomUUID().slice(0, 8)}`
    const result = await docker(['commit', name, tag])
    if (result.exitCode !== 0) {
      throw new WorkspaceError(`Snapshot failed: ${result.stderr.trim()}`, 'backend_error')
    }
    return { id: tag, kind: this.kind, createdAt: Date.now() }
  }

  async dispose(): Promise<void> {
    if (!this.containerId) return
    // Unpause first: `rm -f` cannot remove a paused container on some engines.
    await docker(['unpause', this.id])
    await docker(['rm', '-f', this.id])
    this.containerId = undefined
  }
}

export async function isDockerAvailable(): Promise<boolean> {
  try {
    const result = await docker(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 15_000 })
    return result.exitCode === 0
  } catch {
    return false
  }
}

/** Single-quote for `sh -c`, escaping embedded single quotes. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

interface RawResult {
  stdout: Buffer
  stderr: Buffer
  exitCode: number
  timedOut: boolean
  durationMs: number
}

function dockerRaw(
  args: string[],
  options: { timeoutMs?: number; stdinBytes?: Buffer } = {},
): Promise<RawResult> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const startedAt = Date.now()

  return new Promise((resolve, reject) => {
    const child = spawn('docker', args)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', (d: Buffer) => stdout.push(d))
    child.stderr.on('data', (d: Buffer) => stderr.push(d))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new WorkspaceError('docker CLI not available', 'backend_error', { cause: err }))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: timedOut ? 124 : (code ?? 0),
        timedOut,
        durationMs: Date.now() - startedAt,
      })
    })

    if (options.stdinBytes) child.stdin.end(options.stdinBytes)
    else child.stdin.end()
  })
}

async function docker(
  args: string[],
  options: { timeoutMs?: number; stdin?: string } = {},
): Promise<ExecResult> {
  const raw = await dockerRaw(args, {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.stdin !== undefined ? { stdinBytes: Buffer.from(options.stdin, 'utf8') } : {}),
  })
  return {
    stdout: raw.stdout.toString('utf8'),
    stderr: raw.stderr.toString('utf8'),
    exitCode: raw.exitCode,
    timedOut: raw.timedOut,
    durationMs: raw.durationMs,
  }
}
