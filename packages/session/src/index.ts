export {
  ApprovalGate,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  type PendingApproval,
} from './approvals.js'

export { buildWorkspaceTools, BUILTIN_TOOL_NAMES, type ToolContext } from './tools.js'
export {
  braveProvider,
  buildSearchWebTools,
  searchProviderFromEnv,
  type SearchProvider,
  type SearchResult,
} from './search.js'

export {
  initConnectors,
  type ConnectorConfig,
  type ConnectorState,
} from './connectors.js'

export {
  SessionManager,
  defaultPolicy,
  type Session,
  type SessionManagerConfig,
} from './manager.js'

export { buildEditTools, type EditToolContext } from './tools-edit.js'
export { buildSearchTools, type SearchToolContext } from './tools-search.js'
export { buildWebTools, type WebToolContext } from './tools-web.js'
export {
  snapshot,
  restore,
  listCheckpoints,
  CHECKPOINT_DIR,
  type Checkpoint,
} from './checkpoints.js'
