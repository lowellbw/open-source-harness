import os from 'node:os'
import path from 'node:path'
import { SessionManager, defaultPolicy } from '@workspace/session'
import { SqliteStore } from '@workspace/store'

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

/**
 * Under the home directory, not the temp directory.
 *
 * These files are now someone's conversation history and their documents.
 * `os.tmpdir()` is swept — on a Mac by the system every few days, in a
 * container on every restart — which would make the persistence below a
 * pleasant fiction.
 *
 * Overridable so the Mac shell can point at Application Support, where a
 * sandboxed app is actually permitted to write.
 */
const dataRoot = process.env.AGENTIC_WORKSPACE_HOME ?? path.join(os.homedir(), '.agentic-workspace')

export const store = new SqliteStore(path.join(dataRoot, 'workspace.db'))

export const manager = new SessionManager({
  workspaceRoot: path.join(dataRoot, 'threads'),
  store,
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
