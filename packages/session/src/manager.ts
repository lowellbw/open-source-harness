import fs from 'node:fs/promises'
import path from 'node:path'
import { Agent, type OrgPolicy, type ReasoningEffort } from '@workspace/core'
import { ModelGateway } from '@workspace/gateway-model'
import { LocalWorkspace, type Workspace } from '@workspace/workspace'
import type { WorkspaceEvent } from '@workspace/protocol'
import type { Store, ThreadSummary } from '@workspace/store'
import { ApprovalGate } from './approvals.js'
import { buildWorkspaceTools } from './tools.js'
import { buildSearchWebTools, searchProviderFromEnv, type SearchProvider } from './search.js'
import { buildSubagentTools } from '@workspace/subagents'
import { buildWebTools } from './tools-web.js'
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
  /**
   * Durable thread storage. Optional: without it the manager behaves exactly as
   * before and conversations die with the process, which is what the tests that
   * do not care about persistence want.
   */
  store?: Store
  /**
   * Dedicated search API, if one is configured.
   *
   * Absent, the gateway attaches the provider's own server-side search instead,
   * so search works with no credential beyond the model key. Pass `null` to
   * disable search altogether rather than falling back.
   */
  searchProvider?: SearchProvider | null
  /** Set false to remove the `research` tool entirely. */
  subagents?: boolean
  /** Scouts read and summarise, which is not premium work. Defaults to Light. */
  scoutModelAlias?: string
  reasoningEffort?: ReasoningEffort
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
    if (!id.trim()) {
      throw new Error('Session id may not be empty. There is no default thread.')
    }

    const existing = this.sessions.get(id)
    if (existing) return existing

    const policy = this.config.policy ?? defaultPolicy
    const store = this.config.store

    // A thread row is created on first sight rather than requiring the caller to
    // create one first. The alternative is a class of bug where a session exists
    // and its messages have nowhere to go, which fails silently at write time.
    const thread = store?.getThread(id) ?? store?.createThread({ id, ...(modelAlias ? { modelAlias } : {}) })
    const alias = modelAlias ?? thread?.modelAlias ?? this.config.defaultModelAlias ?? 'Standard'
    if (store && thread && modelAlias && modelAlias !== thread.modelAlias) {
      store.setThreadModel(id, modelAlias)
    }

    const history = store?.loadMessages(id) ?? []

    const root = path.join(this.config.workspaceRoot, id)
    const workspace = new LocalWorkspace({ root })
    await workspace.start()

    // A dedicated provider gives an explicit query and inspectable results; the
    // provider-native fallback keeps search working with no second credential
    // and no extra sub-processor to disclose (§6.4). Exactly one is active — 
    // running both would search twice and bill twice for one question.
    const searchProvider =
      this.config.searchProvider === null
        ? undefined
        : (this.config.searchProvider ?? searchProviderFromEnv())

    const gateway =
      this.config.createGateway?.() ??
      new ModelGateway(
        searchProvider || this.config.searchProvider === null
          ? {}
          : { webSearch: { maxResults: 5, engine: 'auto' } },
      )
    const connectors = await this.getConnectors()

    const listeners = new Set<(event: WorkspaceEvent) => void>()
    const emit = (event: WorkspaceEvent) => {
      // Written here rather than in the agent so the core stays free of any
      // notion of a database. The ledger is a session-layer concern.
      if (event.type === 'cost.updated' && store) {
        store.recordCost(id, event.runId, event.model, event.delta)
      }
      for (const listener of listeners) listener(event)
    }

    const approvals = new ApprovalGate(emit, this.config.approvalTimeoutMs)

    // The read-only slice a scout may have. Web fetch and search reach outside
    // the workspace but change nothing in it, so they are safe to hand over;
    // they are injected rather than imported by `@workspace/subagents` so that
    // package does not depend on this one, which depends on it.
    const scoutExtraTools = {
      ...buildWebTools(),
      ...(searchProvider ? buildSearchWebTools({ provider: searchProvider }) : {}),
    }

    const builtins = {
      ...buildWorkspaceTools({ workspace, approvals, emit }),
      ...(searchProvider ? buildSearchWebTools({ provider: searchProvider }) : {}),
      ...(this.config.subagents === false
        ? {}
        : buildSubagentTools({
            workspace,
            policy,
            gateway,
            emit,
            extraTools: scoutExtraTools,
            ...(this.config.scoutModelAlias ? { modelAlias: this.config.scoutModelAlias } : {}),
          })),
    }

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
        initialHistory: history,
        ...(this.config.reasoningEffort ? { reasoningEffort: this.config.reasoningEffort } : {}),
        ...(store
          ? {
              onMessage: (message) => {
                store.appendMessages(id, [message])
                // Title from the first thing asked. A sidebar of twenty rows
                // all reading "New thread" is a list you cannot navigate, and
                // asking the user to name a conversation before having it is
                // asking them to summarise something that has not happened.
                if (message.role === 'user' && store.getThread(id)?.title === 'New thread') {
                  const text = message.parts
                    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
                    .map((part) => part.text)
                    .join(' ')
                    .replace(/\s+/g, ' ')
                    .trim()
                  if (text) store.renameThread(id, text.slice(0, 60))
                }
              },
            }
          : {}),
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
        // Derived from the built set rather than a hardcoded list, so a tool
        // that exists only in some configurations — search, when a key is
        // present — cannot be silently filtered out of the prompt.
        activeTools: () =>
          connectors.servers.length === 0
            ? undefined
            : [...Object.keys(builtins), ...connectors.toolset.activeToolNames()],
      }),
    }

    this.sessions.set(id, session)
    return session
  }

  peek(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  /**
   * Thread operations.
   *
   * Routed through the manager rather than letting callers reach the store
   * directly, because a thread has two halves: rows in SQLite and a live session
   * holding a workspace and an agent. Deleting one without the other leaves
   * either an orphaned workspace on disk or a session whose history no longer
   * exists.
   */
  listThreads(): ThreadSummary[] {
    return this.config.store?.listThreads() ?? []
  }

  createThread(title?: string, modelAlias?: string): { id: string } {
    const store = this.config.store
    if (!store) throw new Error('No store configured; threads are not persistent.')
    const record = store.createThread({
      ...(title ? { title } : {}),
      ...(modelAlias ? { modelAlias } : {}),
    })
    return { id: record.id }
  }

  renameThread(id: string, title: string): void {
    this.config.store?.renameThread(id, title)
  }

  async deleteThread(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (session) {
      session.approvals.denyAll()
      await session.workspace.dispose().catch(() => {})
      this.sessions.delete(id)
    }
    this.config.store?.deleteThread(id)
    // The workspace directory outlives dispose(), which releases handles rather
    // than deleting files. Left behind, a deleted thread keeps its documents.
    await fs.rm(path.join(this.config.workspaceRoot, id), { recursive: true, force: true }).catch(
      () => {},
    )
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
