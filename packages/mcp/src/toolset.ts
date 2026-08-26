import { tool, jsonSchema, type ToolSet } from 'ai'
import { z } from 'zod'
import type { ConnectedServer } from './client.js'
import { listServerTools } from './client.js'
import type { ToolApprovals, ToolDescriptor } from './registry.js'

/**
 * Deferred tool loading (PLAN-V2 §11).
 *
 * Worth being precise, because the plan reads as though MCP provides this: it
 * does not. Deferred loading is an application-layer pattern over `tools/list`,
 * not a wire primitive. The spec's new `ttlMs`/`cacheScope` fields are about
 * caching list responses and are a different mechanism entirely.
 *
 * The problem it solves: a handful of connected servers can put tens of
 * thousands of tokens of JSON Schema in front of the model before it has done
 * anything, and selection accuracy *falls* as the list grows. So only a search
 * tool is exposed up front; the model finds what it needs and those tools
 * become active for subsequent steps.
 *
 * Implemented through the SDK's per-step `activeTools`, which is exactly this
 * shape — tools stay registered, but only the active subset is sent.
 */

export interface McpToolsetOptions {
  /**
   * Tools always active without a search. Keep this small — it is the token
   * cost deferral exists to avoid.
   */
  alwaysLoad?: string[]
  /** Max results per search. */
  searchLimit?: number
}

export interface DiscoveredTool extends ToolDescriptor {
  serverId: string
  /** Namespaced name the model sees. */
  qualifiedName: string
  /**
   * Computed against the current approvals every time it is read, never cached.
   * A cached status would mean approving a tool did not make it callable until
   * the server was reconnected — the approval would appear to do nothing.
   */
  status: 'approved' | 'unapproved' | 'changed'
}

export const SEARCH_TOOL_NAME = 'search_tools'

export class McpToolset {
  private readonly discovered = new Map<string, Omit<DiscoveredTool, 'status'>>()
  private readonly loaded = new Set<string>()
  private readonly servers = new Map<string, ConnectedServer>()

  constructor(
    private readonly approvals: ToolApprovals,
    private readonly options: McpToolsetOptions = {},
  ) {}

  async discover(servers: ConnectedServer[]): Promise<DiscoveredTool[]> {
    for (const server of servers) {
      this.servers.set(server.id, server)
      const tools = await listServerTools(server)
      for (const descriptor of tools) {
        const qualifiedName = qualify(server.id, descriptor.name)
        this.discovered.set(qualifiedName, { ...descriptor, serverId: server.id, qualifiedName })
      }
    }

    for (const name of this.options.alwaysLoad ?? []) {
      if (this.discovered.has(name)) this.loaded.add(name)
    }

    return this.all()
  }

  /** Every discovered tool, with its status resolved against current approvals. */
  all(): DiscoveredTool[] {
    return [...this.discovered.values()].map((t) => ({
      ...t,
      status: this.approvals.status(t.serverId, t),
    }))
  }

  /** Only approved tools are ever callable. */
  callable(): DiscoveredTool[] {
    return this.all().filter((t) => t.status === 'approved')
  }

  needingApproval(): DiscoveredTool[] {
    return this.all().filter((t) => t.status !== 'approved')
  }

  /**
   * Names to pass as `activeTools`.
   *
   * Always includes the search tool, so the model can never lose its way back
   * to the rest of the catalogue.
   */
  activeToolNames(): string[] {
    return [SEARCH_TOOL_NAME, ...this.loaded]
  }

  markLoaded(qualifiedName: string): void {
    if (this.discovered.has(qualifiedName)) this.loaded.add(qualifiedName)
  }

  /**
   * The full ToolSet: the search tool plus every approved tool.
   *
   * Registration is not exposure — `activeToolNames()` decides what the model
   * actually sees on any given step.
   */
  aiTools(): ToolSet {
    const tools: ToolSet = {
      [SEARCH_TOOL_NAME]: tool({
        description:
          'Find tools available from connected servers. Returns matching tool names and what they do. ' +
          'Call this first when you need a capability you do not already have; matched tools become available on the next step.',
        inputSchema: z.object({
          query: z.string().describe('What you are trying to do, in a few words'),
        }),
        execute: async ({ query }) => {
          const matches = this.search(query)
          for (const match of matches) this.loaded.add(match.qualifiedName)
          return {
            found: matches.length,
            tools: matches.map((m) => ({
              name: m.qualifiedName,
              description: truncate(m.description ?? '', 200),
            })),
            note:
              matches.length > 0
                ? 'These tools are now available. Call them directly.'
                : 'Nothing matched. Try different words, or proceed without a tool.',
          }
        },
      }),
    }

    for (const discovered of this.callable()) {
      const server = this.servers.get(discovered.serverId)
      if (!server) continue

      tools[discovered.qualifiedName] = tool({
        description: discovered.description ?? `Tool ${discovered.name} from ${discovered.serverId}`,
        // MCP hands us JSON Schema; the SDK takes it directly rather than
        // needing a round trip through Zod.
        inputSchema: jsonSchema((discovered.inputSchema ?? { type: 'object' }) as never),
        execute: async (args: unknown) => {
          const result = await server.client.callTool({
            name: discovered.name,
            arguments: (args ?? {}) as Record<string, unknown>,
          })
          return result.content ?? result
        },
      })
    }

    return tools
  }

  /**
   * Substring match over name and description.
   *
   * Deliberately not embeddings: a local, explainable match is debuggable and
   * costs nothing, and the catalogues in play are tens of tools rather than
   * thousands. Revisit if that stops being true.
   */
  private search(query: string): DiscoveredTool[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const limit = this.options.searchLimit ?? 8

    return this.callable()
      .map((candidate) => {
        const haystack = `${candidate.name} ${candidate.description ?? ''}`.toLowerCase()
        const score = terms.reduce((n, term) => n + (haystack.includes(term) ? 1 : 0), 0)
        return { candidate, score }
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ candidate }) => candidate)
  }
}

/**
 * Namespaced so two servers offering `search` do not collide.
 *
 * Non-conforming characters are replaced because providers restrict tool names
 * to a conservative set, and a server is free to use whatever it likes.
 */
export function qualify(serverId: string, toolName: string): string {
  return `${sanitise(serverId)}__${sanitise(toolName)}`
}

function sanitise(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
