import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertRealPathInRoot, isInside, resolveInRoot, toWorkspacePath } from './paths.js'
import { WorkspaceError } from './types.js'

const ROOT = '/work'

describe('resolveInRoot', () => {
  it('treats a leading slash as the workspace root, not the host root', () => {
    expect(resolveInRoot(ROOT, '/notes.md', path.posix)).toBe('/work/notes.md')
    // The point of this rule: a model emitting a plausible-looking absolute
    // path lands harmlessly inside the workspace instead of reading the host.
    expect(resolveInRoot(ROOT, '/etc/passwd', path.posix)).toBe('/work/etc/passwd')
  })

  it('resolves relative paths and normalises redundant segments', () => {
    expect(resolveInRoot(ROOT, 'a/b/../c.txt', path.posix)).toBe('/work/a/c.txt')
    expect(resolveInRoot(ROOT, './a/./b', path.posix)).toBe('/work/a/b')
    expect(resolveInRoot(ROOT, '', path.posix)).toBe('/work')
    expect(resolveInRoot(ROOT, '.', path.posix)).toBe('/work')
  })

  it('collapses repeated leading slashes', () => {
    expect(resolveInRoot(ROOT, '///a.txt', path.posix)).toBe('/work/a.txt')
  })

  it.each([
    ['simple parent escape', '../secret'],
    ['deep parent escape', 'a/b/../../../secret'],
    ['escape after a leading slash', '/../secret'],
    ['escape to the filesystem root', '../../../../../../etc/passwd'],
    ['pure traversal', '..'],
  ])('rejects %s', (_label, input) => {
    expect(() => resolveInRoot(ROOT, input, path.posix)).toThrow(WorkspaceError)
    try {
      resolveInRoot(ROOT, input, path.posix)
    } catch (err) {
      expect((err as WorkspaceError).code).toBe('path_escape')
    }
  })

  it('rejects a null byte, which can truncate a path in a syscall', () => {
    expect(() => resolveInRoot(ROOT, 'a\0b', path.posix)).toThrow(WorkspaceError)
  })

  it('does not treat a sibling with the root as a prefix as inside it', () => {
    // The bug a naive startsWith check produces: /work-other passes as /work.
    expect(isInside('/work', '/work-other/file', path.posix)).toBe(false)
    expect(isInside('/work', '/work/file', path.posix)).toBe(true)
    expect(isInside('/work', '/work', path.posix)).toBe(true)
  })

  it('keeps backslashes, which are legal POSIX filename characters', () => {
    expect(resolveInRoot(ROOT, 'weird\\name.txt', path.posix)).toBe('/work/weird\\name.txt')
  })
})

describe('toWorkspacePath', () => {
  it('reports paths relative to the root, forward-slashed', () => {
    expect(toWorkspacePath('/work', '/work/a/b.txt')).toBe('/a/b.txt')
  })
})

describe('assertRealPathInRoot', () => {
  let root: string
  let outside: string

  beforeAll(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-paths-'))
    root = path.join(base, 'root')
    outside = path.join(base, 'outside')
    await fs.mkdir(root, { recursive: true })
    await fs.mkdir(outside, { recursive: true })
    await fs.writeFile(path.join(outside, 'secret.txt'), 'classified')
    await fs.writeFile(path.join(root, 'ok.txt'), 'fine')
  })

  afterAll(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true })
  })

  it('accepts a real path inside the root', async () => {
    await expect(assertRealPathInRoot(root, path.join(root, 'ok.txt'))).resolves.toBeUndefined()
  })

  it('accepts a path that does not exist yet, since writes create files', async () => {
    await expect(
      assertRealPathInRoot(root, path.join(root, 'nested/not/created/yet.txt')),
    ).resolves.toBeUndefined()
  })

  it('rejects a symlink pointing outside the root', async () => {
    // This is the case lexical resolution cannot catch: the path looks
    // contained, and only following the link reveals it is not.
    const link = path.join(root, 'escape')
    await fs.symlink(outside, link)
    await expect(assertRealPathInRoot(root, path.join(link, 'secret.txt'))).rejects.toThrow(
      WorkspaceError,
    )
  })
})
