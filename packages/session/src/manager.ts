import path from 'node:path'
import { Agent, type OrgPolicy } from '@workspace/core'
import { ModelGateway } from '@workspace/gateway-model'
import { LocalWorkspace, type Workspace } from '@workspace/workspace'
import type { WorkspaceEvent } from '@workspace/protocol'
import { ApprovalGate } from './approvals.js'
import { BUILTIN_TOOL_NAMES, buildWorkspaceTools } from './tools.js'
import { initConnectors, type ConnectorConfig, type ConnectorState } from './connectors.js'

/**
 * Session lifecycle, shared by every shell.
 *
 * This is the layer that used to live inside the Next.js app, which made
 * PLAN-V2 §3's "one core, three shells" untrue in practice: the core was
 * shared but the toolset, the approval gate and the connector wiring — where
 * the product's actual behaviour lives — were reachable only from the web app.
 * The Mac sidecar would have had to reimplement them and drift.
 *
 * Everything environment-specific is injected. The web app puts workspaces in a
 * temp directory; the Mac shell puts them under Application Support. Neither
 * decision belongs in here.
 *
 * Sessions are held in an instance map rather than module scope, so a test can
 * build an isolated manager and the hosted path (§4) can hold one per org
 * instead of inheriting a process-wide singleton by accident.
 */

export interface SessionManagerConfig {
  /** Directory under which each session gets its own workspace. */
  workspaceRoot: string
  connectors: ConnectorConfig
  policy?: OrgPolicy
  defaultModelAlias?: string
  contextMaxTokens?: number
  /** Injectable so tests can supply a gateway without a live key. */
  createGateway?: () => ModelGateway
  approvalTimeoutMs?: number
}

export interface Session {
  id: string
  agent: Agent
  gateway: ModelGateway
  workspace: Workspace
  root: string
  listeners: Set<(event: WorkspaceEvent) => void>
  approvals: ApprovalGate
  modelAlias: string
  connectors: ConnectorState
}

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

export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private connectors: ConnectorState | undefined
  private connectorsPromise: Promise<ConnectorState> | undefined

  constructor(private readonly config: SessionManagerConfig) {}

  /**
   * Connectors are process-wide, brought up once.
   *
   * The promise is cached rather than the result so two sessions created
   * concurrently on a cold start do not each spawn their own copy of every
   * stdio server.
   */
  private async getConnectors(): Promise<ConnectorState> {
    if (this.connectors) return this.connectors
    this.connectorsPromise ??= initConnectors(this.config.connectors).then((state) => {
      this.connectors = state
      return state
    })
    return this.connectorsPromise
  }

  async get(id: string, modelAlias?: string): Promise<Session> {
    const existing = this.sessions.get(id)
    if (existing) return existing

    const policy = this.config.policy ?? defaultPolicy
    const alias = modelAlias ?? this.config.defaultModelAlias ?? 'Standard'

    const root = path.join(this.config.workspaceRoot, id)
    const workspace = new LocalWorkspace({ root })
    await workspace.start()

    const gateway = this.config.createGateway?.() ?? new ModelGateway()
    const connectors = await this.getConnectors()

    const listeners = new Set<(event: WorkspaceEvent) => void>()
    const emit = (event: WorkspaceEvent) => {
      for (const listener of listeners) listener(event)
    }

    const approvals = new ApprovalGate(emit, this.config.approvalTimeoutMs)
    const builtins = buildWorkspaceTools({ workspace, approvals, emit })

    const session: Session = {
      id,
      gateway,
      workspace,
      root,
      listeners,
      approvals,
      modelAlias: alias,
      connectors,
      agent: new Agent({
        gateway,
        policy,
        modelAlias: alias,
        role: policy.role,
        contextMaxTokens: this.config.contextMaxTokens ?? 60_000,
        onEvent: emit,
        // Makes compaction genuinely lossless: the full output stays on disk
        // and the agent can re-read it by path.
        persistToolOutput: async (toolCallId, output) => {
          const target = `/.elided/${toolCallId}.json`
          await workspace.write(
            target,
            typeof output === 'string' ? output : JSON.stringify(output, null, 2),
          )
          return target
        },
        summarise: async (messages) => {
          const text = messages
            .flatMap((m) => m.parts)
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map((p) => p.text)
            .join('\n')
          return `Earlier steps covered: ${text.slice(0, 1_000)}`
        },
        // Rebuilt each turn so a connector tool approved mid-session becomes
        // usable without restarting.
        tools: () => ({ ...builtins, ...connectors.toolset.aiTools() }),
        // Deferred loading: only the search tool and whatever the model has
        // already asked for reach the prompt. Built-ins stay active because
        // they are few and always relevant.
        activeTools: () =>
          connectors.servers.length === 0
            ? undefined
            : [...BUILTIN_TOOL_NAMES, ...connectors.toolset.activeToolNames()],
      }),
    }

    this.sessions.set(id, session)
    return session
  }

  peek(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  list(): Session[] {
    return [...this.sessions.values()]
  }

  /** Releases workspaces and connector child processes. */
  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.approvals.denyAll()
      await session.workspace.dispose().catch(() => {})
    }
    this.sessions.clear()
    await this.connectors?.close()
    this.connectors = undefined
    this.connectorsPromise = undefined
  }
}
