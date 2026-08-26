import path from 'node:path'
import type { Workspace } from '@workspace/workspace'

/**
 * Per-file snapshots taken before a destructive edit.
 *
 * This exists to change what the approval gate has to ask about. §9 gates on
 * irreversibility, and the usual reading of that is "prompt before every edit"
 * — which makes an agent unusable for real work and, worse, trains people to
 * approve without reading.
 *
 * The better answer is to remove the irreversibility. An edit that can be
 * undone is not irreversible, so it does not need to interrupt anyone. That is
 * also what §8's checkpoint store is for on the Mac; this is the portable
 * version of the same idea, working through the `Workspace` seam so it behaves
 * identically in a container.
 *
 * Deliberately not a general undo system. It snapshots single files at the
 * moment before they change, which is the case that actually loses work.
 */

const CHECKPOINT_DIR = '/.checkpoints'

export interface Checkpoint {
  /** Workspace path of the file this snapshot came from. */
  originalPath: string
  /** Where the snapshot lives. */
  checkpointPath: string
  takenAt: number
}

/**
 * Copies a file aside before it is modified.
 *
 * Returns undefined when there was nothing to snapshot — a create is already
 * reversible by deleting the file.
 */
export async function snapshot(
  workspace: Workspace,
  filePath: string,
): Promise<Checkpoint | undefined> {
  if (!(await workspace.exists(filePath))) return undefined

  const takenAt = Date.now()
  const checkpointPath = checkpointPathFor(filePath, takenAt)

  // Bytes, not text: a snapshot that mangles a binary file is not a snapshot.
  await workspace.write(checkpointPath, await workspace.readBytes(filePath))

  return { originalPath: filePath, checkpointPath, takenAt }
}

/** Most recent snapshot first, so "undo" means the obvious thing. */
export async function listCheckpoints(
  workspace: Workspace,
  filePath: string,
): Promise<Checkpoint[]> {
  const dir = path.posix.join(CHECKPOINT_DIR, encodePath(filePath))
  if (!(await workspace.exists(dir))) return []

  const entries = await workspace.list(dir)
  return entries
    .filter((entry) => entry.type === 'file')
    .map((entry) => ({
      originalPath: filePath,
      checkpointPath: entry.path,
      takenAt: Number(entry.name.replace(/\D/g, '')) || 0,
    }))
    .sort((a, b) => b.takenAt - a.takenAt)
}

/** Restores a file from a snapshot, taking one of the current state first. */
export async function restore(
  workspace: Workspace,
  filePath: string,
  checkpointPath?: string,
): Promise<{ ok: boolean; restoredFrom?: string; reason?: string }> {
  const available = await listCheckpoints(workspace, filePath)
  const target = checkpointPath
    ? available.find((c) => c.checkpointPath === checkpointPath)
    : available[0]

  if (!target) {
    return { ok: false, reason: `No checkpoint found for ${filePath}` }
  }

  // Snapshot what we are about to overwrite, so an unwanted undo is itself
  // undoable. Restoring into a worse state with no way back would be a poor
  // reward for trusting the feature.
  await snapshot(workspace, filePath)
  await workspace.write(filePath, await workspace.readBytes(target.checkpointPath))

  return { ok: true, restoredFrom: target.checkpointPath }
}

function checkpointPathFor(filePath: string, takenAt: number): string {
  return path.posix.join(CHECKPOINT_DIR, encodePath(filePath), `${takenAt}.bak`)
}

/**
 * Flattens a workspace path into one directory name.
 *
 * Slashes become `__` so `/src/a.ts` and `/src__a.ts` cannot collide into the
 * same checkpoint directory and overwrite each other's history.
 */
function encodePath(filePath: string): string {
  return filePath.replace(/^\/+/, '').replace(/_/g, '_-').replace(/\//g, '__') || 'root'
}

export { CHECKPOINT_DIR }
