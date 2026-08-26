import os from 'node:os'
import path from 'node:path'
import { SessionManager, defaultPolicy } from '@workspace/session'

/**
 * Web-app wiring for the shared session layer.
 *
 * Everything that used to live here — the toolset, the approval gate, the
 * connector bring-up — now lives in `@workspace/session`, so the Mac sidecar
 * runs the identical code rather than a second implementation that drifts.
 * What is left is the part that genuinely differs per shell: where things live
 * on disk.
 *
 * Held in module scope, which is right for the local single-user deployment
 * this app is. The hosted multi-tenant path (§4) constructs one manager per org
 * against per-org sandbox pools and does NOT reuse this — sharing a workspace
 * across orgs is the one thing that must never happen, and a process-wide
 * singleton is exactly how that accident occurs.
 */

const dataRoot = path.join(os.tmpdir(), 'agentic-workspace')

export const manager = new SessionManager({
  workspaceRoot: dataRoot,
  connectors: {
    // Global rather than per session: connectors are configured once, so
    // scoping approvals per session means re-reading the same descriptions
    // forever, which is how a security prompt decays into noise.
    approvalsPath: path.join(dataRoot, 'mcp-approvals.json'),
    configPath: path.join(process.cwd(), 'mcp.config.json'),
  },
  contextMaxTokens: 60_000,
})

export { defaultPolicy }
export type { Session } from '@workspace/session'

export const getSession = (id: string, modelAlias?: string) => manager.get(id, modelAlias)
export const peekSession = (id: string) => manager.peek(id)
