export {
  ApprovalGate,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  type PendingApproval,
} from './approvals.js'

export { buildWorkspaceTools, BUILTIN_TOOL_NAMES, type ToolContext } from './tools.js'

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
