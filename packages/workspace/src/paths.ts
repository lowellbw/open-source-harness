import path from 'node:path'
import fs from 'node:fs/promises'
import { WorkspaceError } from './types.js'

/**
 * Path confinement for workspace operations.
 *
 * Agents produce paths from model output, so these are untrusted strings. A
 * workspace that lets one resolve outside its root is not a sandbox, so this is
 * the choke point every filesystem operation goes through.
 *
 * Paths are treated as workspace-rooted: a leading "/" means the workspace
 * root, not the host root. That matches what a model naturally emits when it
 * believes it is looking at a filesystem, and it means "/etc/passwd" resolves
 * harmlessly inside the workspace instead of being rejected as hostile.
 */
export function resolveInRoot(
  root: string,
  input: string,
  /**
   * Path flavour to resolve with. Defaults to the host's. Container-backed
   * workspaces pass `path.posix` explicitly, since their paths are POSIX
   * regardless of what the host running the client happens to be.
   */
  impl: path.PlatformPath = path,
): string {
  if (input.includes('\0')) {
    throw new WorkspaceError('Path contains a null byte', 'path_escape')
  }

  const normalizedRoot = impl.resolve(root)

  // Strip any number of leading slashes — the path is rooted at the workspace,
  // not the host. Backslashes are left alone: they are legal filename
  // characters on POSIX and rewriting them would corrupt real names.
  const relative = input.replace(/^\/+/, '')
  const resolved = impl.resolve(normalizedRoot, relative)

  if (!isInside(normalizedRoot, resolved, impl)) {
    throw new WorkspaceError(
      `Path escapes the workspace root: ${input}`,
      'path_escape',
    )
  }

  return resolved
}

/**
 * Containment test on already-resolved absolute paths.
 *
 * Uses a separator-terminated prefix so that "/work-other" is not treated as
 * living inside "/work" — a plain startsWith would accept it.
 */
export function isInside(
  root: string,
  candidate: string,
  impl: path.PlatformPath = path,
): boolean {
  if (candidate === root) return true
  const withSep = root.endsWith(impl.sep) ? root : root + impl.sep
  return candidate.startsWith(withSep)
}

/**
 * Second line of defence against symlink escape.
 *
 * `resolveInRoot` is purely lexical, so a symlink inside the workspace pointing
 * at /etc would pass it. Here we resolve the nearest existing ancestor to its
 * real location and re-check containment. The nearest *existing* ancestor is
 * what matters because the target itself often does not exist yet — a write
 * creating a new file is the normal case.
 *
 * Only meaningful for host-backed workspaces. Container-backed ones have the
 * container as their boundary.
 */
export async function assertRealPathInRoot(root: string, resolved: string): Promise<void> {
  const realRoot = await fs.realpath(path.resolve(root))

  let probe = resolved
  for (;;) {
    try {
      const real = await fs.realpath(probe)
      if (!isInside(realRoot, real)) {
        throw new WorkspaceError(
          `Path resolves outside the workspace via a link: ${resolved}`,
          'path_escape',
        )
      }
      return
    } catch (err) {
      if (err instanceof WorkspaceError) throw err
      const parent = path.dirname(probe)
      if (parent === probe) {
        // Walked to the filesystem root without finding anything that exists.
        throw new WorkspaceError(
          `Path resolves outside the workspace: ${resolved}`,
          'path_escape',
        )
      }
      probe = parent
    }
  }
}

/** Workspace-relative form, forward-slashed, for reporting back to the agent. */
export function toWorkspacePath(root: string, absolute: string): string {
  const rel = path.relative(path.resolve(root), absolute)
  return '/' + rel.split(path.sep).join('/')
}
