import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  McpToolset,
  ToolApprovals,
  connectServer,
  type ConnectedServer,
  type McpServerConfig,
  type PinnedTool,
} from '@workspace/mcp'

/**
 * Brings up configured MCP servers.
 *
 * Every failure here is non-fatal by design: a workspace that will not open
 * because one connector is unreachable is worse than one that opens without it.
 * Failures are collected and surfaced, never thrown.
 */

export interface ConnectorState {
  toolset: McpToolset
  approvals: ToolApprovals
  servers: { id: string; era: string; protocolVersion: string | undefined }[]
  errors: { id: string; message: string }[]
  connected: ConnectedServer[]
  /** Persists approvals so a restart does not silently re-trust a changed tool. */
  save: () => Promise<void>
  close: () => Promise<void>
}

export interface ConnectorConfig {
  /**
   * Where tool approvals persist.
   *
   * Global, not per session. Connectors are configured once, so scoping their
   * approvals to a session means re-reading the same descriptions forever —
   * which is exactly how a security prompt decays into noise.
   */
  approvalsPath: string
  /** Path to a JSON file with a `servers` array. Ignored if `servers` is given. */
  configPath?: string
  servers?: McpServerConfig[]
}

export async function initConnectors(config: ConnectorConfig): Promise<ConnectorState> {
  await fsp.mkdir(path.dirname(config.approvalsPath), { recursive: true })

  let pinned: PinnedTool[] = []
  try {
    pinned = JSON.parse(await fsp.readFile(config.approvalsPath, 'utf8')) as PinnedTool[]
  } catch {
    // No prior approvals is the normal first-run case.
  }

  const approvals = new ToolApprovals(pinned)
  const toolset = new McpToolset(approvals)
  const servers: ConnectorState['servers'] = []
  const errors: ConnectorState['errors'] = []

  const configured = config.servers ?? (await readServerConfig(config.configPath))

  const connected: ConnectedServer[] = []
  for (const entry of configured) {
    try {
      const server = await connectServer(entry)
      connected.push(server)
      servers.push({ id: server.id, era: server.era, protocolVersion: server.protocolVersion })
    } catch (err) {
      errors.push({ id: entry.id, message: err instanceof Error ? err.message : String(err) })
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
    connected,
    save: async () => {
      await fsp.writeFile(config.approvalsPath, JSON.stringify(approvals.export(), null, 2))
    },
    close: async () => {
      // Stdio servers are child processes; leaving them running outlives the app.
      await Promise.all(connected.map((server) => server.close().catch(() => {})))
    },
  }
}

async function readServerConfig(configPath: string | undefined): Promise<McpServerConfig[]> {
  if (!configPath) return []
  try {
    const raw = await fsp.readFile(configPath, 'utf8')
    return (JSON.parse(raw) as { servers?: McpServerConfig[] }).servers ?? []
  } catch {
    // No config file means no connectors, which is a valid configuration.
    return []
  }
}
