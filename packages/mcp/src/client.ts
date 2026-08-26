import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { ToolDescriptor } from './registry.js'

/**
 * MCP connection (PLAN-V2 §11).
 *
 * The official SDK v2, not a hand-rolled client. The 2026-07-28 revision is
 * stateless with no `initialize` handshake, adds a mandatory `server/discover`,
 * and replaces server-initiated requests with the MRTR retry pattern. Tracking
 * that by hand is a standing liability for no benefit.
 *
 * Legacy fallback stays on. The SDK speaks the 2025-era protocol unless
 * 2026-07-28 is explicitly opted into, and the overwhelming majority of
 * deployed servers still predate the revision — so negotiating down is correct
 * behaviour rather than a compromise.
 */

export interface StdioServerConfig {
  id: string
  transport: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface HttpServerConfig {
  id: string
  transport: 'http'
  url: string
  headers?: Record<string, string>
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig

export interface ConnectedServer {
  id: string
  client: Client
  /** 'modern' speaks 2026-07-28+; 'legacy' only the 2025-era handshake. */
  era: string
  protocolVersion: string | undefined
  close: () => Promise<void>
}

export async function connectServer(config: McpServerConfig): Promise<ConnectedServer> {
  const client = new Client({ name: 'agentic-workspace', version: '0.1.0' })

  const transport =
    config.transport === 'stdio'
      ? new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          ...(config.env ? { env: config.env } : {}),
        })
      : new StreamableHTTPClientTransport(new URL(config.url), {
          ...(config.headers
            ? { requestInit: { headers: config.headers } }
            : {}),
        })

  await client.connect(transport)

  return {
    id: config.id,
    client,
    era: safeCall(() => client.getProtocolEra()) ?? 'unknown',
    protocolVersion: safeCall(() => client.getNegotiatedProtocolVersion()),
    close: async () => {
      await client.close()
    },
  }
}

export async function listServerTools(server: ConnectedServer): Promise<ToolDescriptor[]> {
  const result = await server.client.listTools()
  return result.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }))
}

/**
 * Era and version accessors are new in v2 and not guaranteed present on every
 * code path; a missing one must not take down a working connection.
 */
function safeCall<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}
