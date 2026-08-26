import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import fsp from 'node:fs/promises'
import { Agent, type OrgPolicy } from '@workspace/core'
import {
  McpToolset,
  ToolApprovals,
  connectServer,
  type ConnectedServer,
  type McpServerConfig,
  type PinnedTool,
} from '@workspace/mcp'
import { ModelGateway } from '@workspace/gateway-model'
import { LocalWorkspace, type Workspace } from '@workspace/workspace'
import type { WorkspaceEvent } from '@workspace/protocol'

/**
 * Server-side session state.
 *
 * Held in module scope, which is right for the local single-user deployment
 * this app is: one process, one user, workspace on their own disk. The hosted
 * multi-tenant path (§4) replaces this with per-org sandbox pools and does NOT
 * reuse it — sharing a workspace across orgs is the one thing that must never
 * happen, and a module-level Map is exactly how that accident would occur.
 */

export interface PendingApproval {
  approvalId: string
  toolCallId: string
  reason: string
  irreversible: boolean
  payload: unknown
  resolve: (decision: 'allow' | 'deny') => void
}

export interface Session {
  id: string
  agent: Agent
  gateway: ModelGateway
  workspace: Workspace
  root: string
  listeners: Set<(event: WorkspaceEvent) => void>
  pending: Map<string, PendingApproval>
  modelAlias: string
  mcp: McpState
}

export interface McpState {
  toolset: McpToolset
  approvals: ToolApprovals
  servers: { id: string; era: string; protocolVersion: string | undefined }[]
  errors: { id: string; message: string }[]
  /** Persists approvals so a restart does not silently re-trust changed tools. */
  save: () => Promise<void>
}

const sessions = new Map<string, Session>()

const APPROVAL_TIMEOUT_MS = 300_000

const BUILTIN_TOOL_NAMES = ['listFiles', 'readFile', 'writeFile', 'runCommand']

export const defaultPolicy: OrgPolicy = {
  orgId: 'local',
  userId: 'you',
  role: 'staff',
  scope: ['/'],
  permissions: ['read', 'write', 'exec'],
  constraints: [
    'Work only inside the workspace.',
    'Ask before anything destructive or irreversible.',
    'Prefer showing your working over asserting a result.',
  ],
}

/**
 * Brings up configured MCP servers.
 *
 * Every failure mode here is non-fatal by design: a workspace that will not
 * open because one connector is unreachable is worse than one that opens
 * without it. Failures are collected and surfaced, not thrown.
 */
async function initMcp(root: string): Promise<McpState> {
  const approvalsPath = path.join(path.dirname(root), `${path.basename(root)}-mcp-approvals.json`)

  let pinned: PinnedTool[] = []
  try {
    pinned = JSON.parse(await fsp.readFile(approvalsPath, 'utf8')) as PinnedTool[]
  } catch {
    // No prior approvals is the normal first-run case.
  }

  const approvals = new ToolApprovals(pinned)
  const toolset = new McpToolset(approvals)
  const servers: McpState['servers'] = []
  const errors: McpState['errors'] = []

  let configured: McpServerConfig[] = []
  try {
    const raw = await fsp.readFile(path.join(process.cwd(), 'mcp.config.json'), 'utf8')
    configured = (JSON.parse(raw) as { servers?: McpServerConfig[] }).servers ?? []
  } catch {
    // No config file means no connectors, which is a valid configuration.
  }

  const connected: ConnectedServer[] = []
  for (const config of configured) {
    try {
      const server = await connectServer(config)
      connected.push(server)
      servers.push({ id: server.id, era: server.era, protocolVersion: server.protocolVersion })
    } catch (err) {
      errors.push({ id: config.id, message: err instanceof Error ? err.message : String(err) })
    }
  }

  if (connected.length > 0) {
    try {
      await toolset.discover(connected)
    } catch (err) {
      errors.push({ id: 'discovery', message: err instanceof Error ? err.message : String(err) })
    }
  }

  return {
    toolset,
    approvals,
    servers,
    errors,
    save: async () => {
      await fsp.writeFile(approvalsPath, JSON.stringify(approvals.export(), null, 2))
    },
  }
}

export async function getSession(id: string, modelAlias = 'Standard'): Promise<Session> {
  const existing = sessions.get(id)
  if (existing) return existing

  const root = path.join(os.tmpdir(), 'agentic-workspace', id)
  const workspace = new LocalWorkspace({ root })
  await workspace.start()

  const gateway = new ModelGateway()
  const listeners = new Set<(event: WorkspaceEvent) => void>()
  const pending = new Map<string, PendingApproval>()
  const mcp = await initMcp(root)

  const emit = (event: WorkspaceEvent) => {
    for (const listener of listeners) listener(event)
  }

  const builtins = buildTools({ workspace, emit, pending })

  const session: Session = {
    id,
    gateway,
    workspace,
    root,
    listeners,
    pending,
    modelAlias,
    mcp,
    agent: new Agent({
      gateway,
      policy: defaultPolicy,
      modelAlias,
      role: defaultPolicy.role,
      contextMaxTokens: 60_000,
      onEvent: emit,
      // Makes compaction genuinely lossless: the full output stays on disk and
      // the agent can re-read it by path.
      persistToolOutput: async (toolCallId, output) => {
        const target = `/.elided/${toolCallId}.json`
        await workspace.write(target, typeof output === 'string' ? output : JSON.stringify(output, null, 2))
        return target
      },
      summarise: async (messages) => {
        const text = messages
          .flatMap((m) => m.parts)
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join('\n')
          .slice(0, 4_000)
        return `Earlier steps covered: ${text.slice(0, 1_000)}`
      },
      // Built-in workspace tools are always available; MCP tools are added by
      // discovery and gated by approval. Names cannot collide because MCP tools
      // are namespaced by server id.
      // Rebuilt each turn so a tool approved mid-session becomes usable without
      // restarting the workspace.
      tools: () => ({ ...builtins, ...mcp.toolset.aiTools() }),
      // Deferred loading: only the search tool and whatever the model has
      // already asked for reach the prompt. Built-ins stay active because they
      // are few and always relevant.
      activeTools: () =>
        mcp.servers.length === 0
          ? undefined
          : [...BUILTIN_TOOL_NAMES, ...mcp.toolset.activeToolNames()],
    }),
  }

  sessions.set(id, session)
  return session
}

export function peekSession(id: string): Session | undefined {
  return sessions.get(id)
}

function buildTools(ctx: {
  workspace: Workspace
  emit: (event: WorkspaceEvent) => void
  pending: Map<string, PendingApproval>
}) {
  /**
   * Human-in-the-loop gate.
   *
   * §9 is specific that approvals are shown for irreversibility only. Prompting
   * on every read trains people to click through without looking, which is
   * strictly worse than not prompting: it manufactures consent instead of
   * obtaining it. So reads and listings run freely and only writes and commands
   * stop here.
   */
  const requireApproval = (reason: string, payload: unknown): Promise<'allow' | 'deny'> => {
    const approvalId = randomUUID()
    return new Promise<'allow' | 'deny'>((resolve) => {
      const timer = setTimeout(() => {
        ctx.pending.delete(approvalId)
        // Default deny. An unanswered prompt is not consent.
        resolve('deny')
      }, APPROVAL_TIMEOUT_MS)

      ctx.pending.set(approvalId, {
        approvalId,
        toolCallId: approvalId,
        reason,
        irreversible: true,
        payload,
        resolve: (decision) => {
          clearTimeout(timer)
          ctx.pending.delete(approvalId)
          resolve(decision)
        },
      })

      ctx.emit({
        type: 'approval.requested',
        runId: 'ui',
        ts: Date.now(),
        approvalId,
        toolCallId: approvalId,
        reason,
        irreversible: true,
        payload,
      })
    })
  }

  return {
    listFiles: tool({
      description: 'List files and directories in the workspace at a given path.',
      inputSchema: z.object({ path: z.string().describe('Workspace path, e.g. "/"') }),
      execute: async ({ path: p }) => ({ entries: await ctx.workspace.list(p) }),
    }),

    readFile: tool({
      description: 'Read a text file from the workspace.',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path: p }) => ({ contents: await ctx.workspace.read(p) }),
    }),

    writeFile: tool({
      description: 'Write a text file to the workspace. Overwrites if it exists.',
      inputSchema: z.object({ path: z.string(), contents: z.string() }),
      execute: async ({ path: p, contents }) => {
        const existed = await ctx.workspace.exists(p)
        if (existed) {
          // Only an overwrite is irreversible. Creating a new file is not, so
          // it does not interrupt.
          const decision = await requireApproval(`Overwrite ${p}`, {
            path: p,
            bytes: contents.length,
          })
          if (decision === 'deny') return { ok: false, reason: 'Denied by user' }
        }
        await ctx.workspace.write(p, contents)
        ctx.emit({
          type: 'workspace.file.changed',
          runId: 'ui',
          ts: Date.now(),
          path: p,
          op: existed ? 'modified' : 'created',
        })
        return { ok: true, path: p }
      },
    }),

    runCommand: tool({
      description: 'Run a shell command inside the workspace.',
      inputSchema: z.object({ command: z.string() }),
      execute: async ({ command }) => {
        const decision = await requireApproval(`Run: ${command}`, { command })
        if (decision === 'deny') return { ok: false, reason: 'Denied by user' }
        const result = await ctx.workspace.exec(command, { timeoutMs: 60_000 })
        return {
          ok: result.exitCode === 0,
          exitCode: result.exitCode,
          stdout: result.stdout.slice(0, 20_000),
          stderr: result.stderr.slice(0, 4_000),
          timedOut: result.timedOut,
        }
      },
    }),
  }
}
