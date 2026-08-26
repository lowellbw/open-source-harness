export {
  WorkspaceError,
  type Workspace,
  type WorkspaceKind,
  type WorkspaceCapabilities,
  type ExecOptions,
  type ExecResult,
  type DirEntry,
  type SnapshotRef,
} from './types.js'

export { LocalWorkspace, type LocalWorkspaceOptions } from './local.js'
export { DockerWorkspace, isDockerAvailable, type DockerWorkspaceOptions } from './docker.js'
export { createWorkspace, type WorkspaceSpec } from './factory.js'
export { resolveInRoot, isInside, assertRealPathInRoot, toWorkspacePath } from './paths.js'
