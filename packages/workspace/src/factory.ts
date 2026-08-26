import { LocalWorkspace, type LocalWorkspaceOptions } from './local.js'
import { DockerWorkspace, type DockerWorkspaceOptions } from './docker.js'
import type { Workspace } from './types.js'

export type WorkspaceSpec =
  | ({ kind?: 'local' } & LocalWorkspaceOptions)
  | ({ kind: 'docker' } & DockerWorkspaceOptions)

/**
 * Resolves by argument shape, following OpenHands' `Workspace()` factory: give
 * it a host directory and you get a local workspace; ask for a container and
 * you get an isolated one. Callers that do not care which they got — which
 * should be most of them — just hold the returned `Workspace`.
 */
export function createWorkspace(spec: WorkspaceSpec): Workspace {
  if (spec.kind === 'docker') {
    const { kind: _kind, ...options } = spec
    return new DockerWorkspace(options)
  }
  const { kind: _kind, ...options } = spec
  return new LocalWorkspace(options)
}
