import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LocalWorkspace } from './local.js'
import { DockerWorkspace, isDockerAvailable } from './docker.js'
import { WorkspaceError, type Workspace } from './types.js'

/**
 * One suite, every backing.
 *
 * This is the proof of PLAN-V2 §3's central claim: the agent core addresses its
 * environment through one interface, so the same agent code runs locally in the
 * Mac sidecar and in a container next to the sandbox pool. If this file needs a
 * conditional on `workspace.kind` to pass, the abstraction has leaked and the
 * claim is false.
 */

const dockerAvailable = await isDockerAvailable()

interface Backing {
  name: string
  create: () => Promise<Workspace>
  cleanup?: () => Promise<void>
  skip: boolean
}

const tmpDirs: string[] = []

const backings: Backing[] = [
  {
    name: 'LocalWorkspace',
    skip: false,
    create: async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-conf-'))
      tmpDirs.push(root)
      return new LocalWorkspace({ root })
    },
  },
  {
    name: 'DockerWorkspace',
    skip: !dockerAvailable,
    create: async () => new DockerWorkspace({ image: 'alpine:3' }),
  },
]

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })))
})

for (const backing of backings) {
  describe.skipIf(backing.skip)(`Workspace conformance: ${backing.name}`, () => {
    let ws: Workspace

    beforeAll(async () => {
      ws = await backing.create()
      await ws.start()
    }, 120_000)

    afterAll(async () => {
      await ws?.dispose()
    }, 60_000)

    it('start() is idempotent', async () => {
      await expect(ws.start()).resolves.toBeUndefined()
    })

    describe('files', () => {
      it('round-trips text', async () => {
        await ws.write('/notes.md', '# hello')
        expect(await ws.read('/notes.md')).toBe('# hello')
      })

      it('round-trips binary without corruption', async () => {
        // Bytes chosen to break anything that decodes as UTF-8 on the way through.
        const bytes = new Uint8Array([0x00, 0xff, 0xfe, 0x1f, 0x80, 0x7f, 0x42])
        await ws.write('/blob.bin', bytes)
        expect(Array.from(await ws.readBytes('/blob.bin'))).toEqual(Array.from(bytes))
      })

      it('creates parent directories on write', async () => {
        await ws.write('/deep/nested/dir/file.txt', 'ok')
        expect(await ws.read('/deep/nested/dir/file.txt')).toBe('ok')
      })

      it('reports existence', async () => {
        expect(await ws.exists('/notes.md')).toBe(true)
        expect(await ws.exists('/definitely-not-here.md')).toBe(false)
      })

      it('lists a directory with types and sizes', async () => {
        await ws.mkdir('/listing')
        await ws.write('/listing/a.txt', 'aaa')
        await ws.mkdir('/listing/sub')

        const entries = await ws.list('/listing')
        const byName = Object.fromEntries(entries.map((e) => [e.name, e]))

        expect(byName.a).toBeUndefined()
        expect(byName['a.txt']).toMatchObject({ type: 'file', size: 3 })
        expect(byName['sub']).toMatchObject({ type: 'directory' })
      })

      it('removes files and directories', async () => {
        await ws.write('/gone.txt', 'x')
        await ws.remove('/gone.txt')
        expect(await ws.exists('/gone.txt')).toBe(false)

        await ws.mkdir('/gonedir/child')
        await ws.remove('/gonedir', { recursive: true })
        expect(await ws.exists('/gonedir')).toBe(false)
      })

      it('reports a missing file as not_found rather than a generic failure', async () => {
        await expect(ws.read('/nope.txt')).rejects.toMatchObject({ code: 'not_found' })
      })
    })

    describe('path confinement', () => {
      it.each(['../escape.txt', '/../escape.txt', 'a/../../escape.txt'])(
        'refuses to write outside the root via %s',
        async (badPath) => {
          await expect(ws.write(badPath, 'pwned')).rejects.toThrow(WorkspaceError)
        },
      )

      it('refuses to read outside the root', async () => {
        await expect(ws.read('../../../../etc/passwd')).rejects.toThrow(WorkspaceError)
      })

      it('treats a leading slash as workspace-rooted, not host-rooted', async () => {
        // Reading "/etc/passwd" must resolve inside the workspace and miss,
        // never reach the real one.
        await expect(ws.read('/etc/passwd')).rejects.toMatchObject({ code: 'not_found' })
      })
    })

    describe('exec', () => {
      it('captures stdout and a zero exit code', async () => {
        const r = await ws.exec('echo hello')
        expect(r.stdout.trim()).toBe('hello')
        expect(r.exitCode).toBe(0)
        expect(r.timedOut).toBe(false)
      })

      it('captures stderr and a non-zero exit code without throwing', async () => {
        const r = await ws.exec('echo oops >&2; exit 3')
        expect(r.stderr.trim()).toBe('oops')
        expect(r.exitCode).toBe(3)
      })

      it('runs in the workspace root by default and sees written files', async () => {
        await ws.write('/visible.txt', 'content')
        const r = await ws.exec('cat visible.txt')
        expect(r.stdout.trim()).toBe('content')
      })

      it('honours cwd', async () => {
        await ws.mkdir('/cwdtest')
        await ws.write('/cwdtest/inner.txt', 'inner')
        const r = await ws.exec('cat inner.txt', { cwd: '/cwdtest' })
        expect(r.stdout.trim()).toBe('inner')
      })

      it('passes env', async () => {
        const r = await ws.exec('echo $MY_VAR', { env: { MY_VAR: 'set-value' } })
        expect(r.stdout.trim()).toBe('set-value')
      })

      it('feeds stdin', async () => {
        const r = await ws.exec('cat', { stdin: 'piped input' })
        expect(r.stdout.trim()).toBe('piped input')
      })

      it('kills a command at the timeout, bounding wall-clock', async () => {
        const startedAt = Date.now()
        const r = await ws.exec('sleep 30', { timeoutMs: 1_500 })
        const elapsed = Date.now() - startedAt

        expect(r.timedOut).toBe(true)
        expect(r.exitCode).toBe(124)

        // The flag alone is not enough. Killing only the shell leaves its
        // children holding the stdout pipe, so the call returns after the full
        // 30s with timedOut set — looking correct while bounding nothing.
        // A runaway command must actually stop, so assert the clock.
        expect(elapsed).toBeLessThan(10_000)
      }, 45_000)

      it('writes made by a command are visible through the file API', async () => {
        // Relative, so it lands in cwd — which is the workspace root.
        await ws.exec('echo from-shell > tmp-out.txt')
        expect((await ws.read('/tmp-out.txt')).trim()).toBe('from-shell')
      })

      it('a shell command’s "/" is the real root, NOT the workspace root', async () => {
        // A deliberate, documented asymmetry rather than a bug. The file API
        // rewrites "/" to the workspace root so untrusted model-authored paths
        // stay contained; a shell has a real filesystem and its own "/".
        //
        // The consequence callers must know: an absolute redirect inside exec
        // escapes the workspace view. Containment for exec comes from the
        // backing being isolated (see capabilities.isolated), not from path
        // rewriting. Pinned here so the asymmetry cannot regress silently.
        const marker = `/conformance-abs-${Date.now()}.txt`
        const wrote = await ws.exec(`echo escaped > ${marker} && echo ok`)

        if (wrote.exitCode === 0) {
          // It went to the real root, so the workspace view must not see it.
          expect(await ws.exists(marker)).toBe(false)
          await ws.exec(`rm -f ${marker}`)
        } else {
          // Read-only root is an equally acceptable outcome.
          expect(wrote.exitCode).not.toBe(0)
        }
      })
    })

    describe('lifecycle', () => {
      it('declares its capabilities honestly', () => {
        expect(typeof ws.capabilities.suspend).toBe('boolean')
        expect(typeof ws.capabilities.isolated).toBe('boolean')
        // Only the container backing claims isolation.
        expect(ws.capabilities.isolated).toBe(ws.kind === 'docker')
      })

      it('preserves filesystem state across suspend and resume', async () => {
        await ws.write('/persist.txt', 'survives')
        await ws.suspend()
        await ws.resume()
        expect(await ws.read('/persist.txt')).toBe('survives')
      }, 60_000)

      it('can still exec after a suspend/resume cycle', async () => {
        await ws.suspend()
        await ws.resume()
        const r = await ws.exec('echo back')
        expect(r.stdout.trim()).toBe('back')
      }, 60_000)

      it('dispose() is idempotent', async () => {
        const throwaway = await backing.create()
        await throwaway.start()
        await throwaway.dispose()
        await expect(throwaway.dispose()).resolves.toBeUndefined()
      }, 120_000)
    })

    describe('guard rails', () => {
      it('refuses filesystem work before start()', async () => {
        const fresh = await backing.create()
        await expect(fresh.read('/anything')).rejects.toMatchObject({ code: 'not_started' })
      })
    })
  })
}

describe('conformance coverage', () => {
  it('reports whether the Docker backing actually ran', () => {
    // Visible in output so a green suite is never mistaken for "both verified"
    // when the daemon was simply absent.
    expect(typeof dockerAvailable).toBe('boolean')
    if (!dockerAvailable) {
      console.warn('[conformance] Docker daemon unavailable — DockerWorkspace was NOT verified')
    }
  })
})
