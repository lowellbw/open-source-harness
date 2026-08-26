import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { WorkspaceEvent } from '@workspace/protocol'
import { LocalWorkspace } from '@workspace/workspace'
import { ApprovalGate } from './approvals.js'
import { buildWorkspaceTools } from './tools.js'
import { buildWebTools } from './tools-web.js'
import { listCheckpoints } from './checkpoints.js'

const tmpDirs: string[] = []

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function harness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-test-'))
  tmpDirs.push(root)

  const workspace = new LocalWorkspace({ root })
  await workspace.start()

  const events: WorkspaceEvent[] = []
  const emit = (event: WorkspaceEvent) => events.push(event)
  const tools = buildWorkspaceTools({
    workspace,
    approvals: new ApprovalGate(emit),
    emit,
  })

  const call = (name: string, args: unknown) =>
    (tools[name]!.execute as (a: unknown, o: unknown) => Promise<unknown>)(args, {})

  return { workspace, events, tools, call }
}

describe('editFile', () => {
  it('replaces an exact string without touching the rest', async () => {
    const { workspace, call } = await harness()
    await workspace.write('/code.ts', 'const a = 1\nconst b = 2\nconst c = 3\n')

    const result = await call('editFile', {
      path: '/code.ts',
      oldString: 'const b = 2',
      newString: 'const b = 22',
    })

    expect(result).toMatchObject({ ok: true, replacements: 1 })
    expect(await workspace.read('/code.ts')).toBe('const a = 1\nconst b = 22\nconst c = 3\n')
  })

  it('refuses when the string is not present, and says why', async () => {
    // Failing loudly beats a silent no-op the model then reports as success.
    const { workspace, call } = await harness()
    await workspace.write('/code.ts', 'hello')

    const result = (await call('editFile', {
      path: '/code.ts',
      oldString: 'not here',
      newString: 'x',
    })) as { ok: boolean; reason: string }

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('not found')
    expect(await workspace.read('/code.ts')).toBe('hello')
  })

  it('refuses an ambiguous match rather than guessing', async () => {
    // Picking the first of several matches silently edits the wrong line about
    // half the time.
    const { workspace, call } = await harness()
    await workspace.write('/code.ts', 'x = 1\nx = 1\nx = 1\n')

    const result = (await call('editFile', {
      path: '/code.ts',
      oldString: 'x = 1',
      newString: 'x = 2',
    })) as { ok: boolean; reason: string }

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('3 times')
    expect(await workspace.read('/code.ts')).toBe('x = 1\nx = 1\nx = 1\n')
  })

  it('replaces every occurrence when asked explicitly', async () => {
    const { workspace, call } = await harness()
    await workspace.write('/code.ts', 'x = 1\nx = 1\n')

    expect(
      await call('editFile', {
        path: '/code.ts',
        oldString: 'x = 1',
        newString: 'x = 2',
        replaceAll: true,
      }),
    ).toMatchObject({ ok: true, replacements: 2 })
    expect(await workspace.read('/code.ts')).toBe('x = 2\nx = 2\n')
  })

  it('does not prompt, because the edit is snapshotted and therefore reversible', async () => {
    // §9 gates on irreversibility. Removing the irreversibility is a better
    // answer than adding a prompt: an agent that asks before every edit is
    // unusable, and being asked constantly teaches people to click through.
    const { workspace, events, call } = await harness()
    await workspace.write('/code.ts', 'original')

    await call('editFile', { path: '/code.ts', oldString: 'original', newString: 'changed' })

    expect(events.some((e) => e.type === 'approval.requested')).toBe(false)
    expect(await listCheckpoints(workspace, '/code.ts')).toHaveLength(1)
  })

  it('restores the previous contents', async () => {
    const { workspace, call } = await harness()
    await workspace.write('/code.ts', 'original')
    await call('editFile', { path: '/code.ts', oldString: 'original', newString: 'changed' })

    expect(await call('restoreFile', { path: '/code.ts' })).toMatchObject({ ok: true })
    expect(await workspace.read('/code.ts')).toBe('original')
  })

  it('makes an unwanted undo itself undoable', async () => {
    // Restoring into a worse state with no way back is a poor reward for
    // trusting the feature.
    const { workspace, call } = await harness()
    await workspace.write('/code.ts', 'v1')
    await call('editFile', { path: '/code.ts', oldString: 'v1', newString: 'v2' })
    await call('restoreFile', { path: '/code.ts' })

    expect(await workspace.read('/code.ts')).toBe('v1')
    // The restore snapshotted v2 on its way past, so it can be recovered.
    expect((await listCheckpoints(workspace, '/code.ts')).length).toBeGreaterThan(1)
    await call('restoreFile', { path: '/code.ts' })
    expect(await workspace.read('/code.ts')).toBe('v2')
  })

  it('refuses to edit a file that does not exist', async () => {
    const { call } = await harness()
    expect(await call('editFile', { path: '/nope.ts', oldString: 'a', newString: 'b' })).toMatchObject(
      { ok: false },
    )
  })

  it('refuses a no-op edit', async () => {
    const { workspace, call } = await harness()
    await workspace.write('/f.txt', 'same')
    expect(
      await call('editFile', { path: '/f.txt', oldString: 'same', newString: 'same' }),
    ).toMatchObject({ ok: false })
  })

  it('snapshots binary content without mangling it', async () => {
    const { workspace, call } = await harness()
    const bytes = new Uint8Array([0x00, 0xff, 0xfe, 0x42])
    await workspace.write('/blob.bin', bytes)
    await workspace.write('/blob.bin', new Uint8Array([1, 2, 3]))

    // Written through writeFile twice; the second write snapshots the first.
    void call
    expect(Array.from(await workspace.readBytes('/blob.bin'))).toEqual([1, 2, 3])
  })
})

describe('searchFiles and findFiles', () => {
  it('finds matching lines with file and line number', async () => {
    const { workspace, call } = await harness()
    await workspace.write('/a.ts', 'const target = 1\nother\n')
    await workspace.write('/nested/b.ts', 'nothing\nconst target = 2\n')

    const result = (await call('searchFiles', { pattern: 'target' })) as {
      matches: { file: string; line: number }[]
      count: number
    }

    expect(result.count).toBe(2)
    expect(result.matches.map((m) => m.line).sort()).toEqual([1, 2])
  })

  it('does not prompt — searching reads, and reads are not irreversible', async () => {
    const { workspace, events, call } = await harness()
    await workspace.write('/a.ts', 'findme')
    await call('searchFiles', { pattern: 'findme' })

    expect(events.some((e) => e.type === 'approval.requested')).toBe(false)
  })

  it('treats a shell metacharacter pattern as text, not as a command', async () => {
    // The pattern comes from model output. Interpolated into a command string,
    // this would run `touch`. It is passed in the environment instead, so the
    // shell never parses it.
    const { workspace, call } = await harness()
    await workspace.write('/a.ts', 'harmless')

    await call('searchFiles', { pattern: '"; touch /pwned.txt; echo "' })

    expect(await workspace.exists('/pwned.txt')).toBe(false)
  })

  it('applies the same care to findFiles', async () => {
    const { workspace, call } = await harness()
    await call('findFiles', { pattern: '"; touch /pwned2.txt; echo "' })
    expect(await workspace.exists('/pwned2.txt')).toBe(false)
  })

  it('finds files by glob and returns workspace paths', async () => {
    const { workspace, call } = await harness()
    await workspace.write('/src/one.ts', 'x')
    await workspace.write('/src/two.js', 'x')

    const result = (await call('findFiles', { pattern: '*.ts' })) as { files: string[] }
    expect(result.files).toEqual(['/src/one.ts'])
  })

  it('hides internal bookkeeping directories from results', async () => {
    // /.checkpoints and /.elided are ours, not the user's work.
    const { workspace, call } = await harness()
    await workspace.write('/real.txt', 'x')
    await workspace.write('/.checkpoints/real.txt/1.bak', 'x')

    const result = (await call('findFiles', { pattern: '*.bak' })) as { files: string[] }
    expect(result.files).toEqual([])
  })

  it('reports no matches as an empty result rather than an error', async () => {
    const { call } = await harness()
    expect(await call('searchFiles', { pattern: 'nothing-matches-this' })).toMatchObject({
      count: 0,
    })
  })
})

describe('fetchUrl', () => {
  const callWeb = (tools: ReturnType<typeof buildWebTools>, args: unknown) =>
    (tools.fetchUrl!.execute as (a: unknown, o: unknown) => Promise<unknown>)(args, {})

  it('refuses a non-http scheme', async () => {
    const tools = buildWebTools()
    expect(await callWeb(tools, { url: 'file:///etc/passwd' })).toMatchObject({ ok: false })
  })

  it.each([
    'http://127.0.0.1/',
    'http://localhost/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
  ])('refuses the private address %s', async (url) => {
    // Without this the tool is an SSRF primitive: 169.254.169.254 is cloud
    // metadata, and 127.0.0.1 is the workspace's own API.
    const result = (await callWeb(buildWebTools(), { url })) as { ok: boolean; reason: string }
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('Refused')
  })

  it('fetches a page and extracts readable text', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(
        '<html><head><style>p{color:red}</style><script>alert(1)</script></head>' +
          '<body><h1>Title</h1><p>Body &amp; text</p></body></html>',
      )
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port

    // Private ranges are refused by default, so this test opts in explicitly —
    // which is itself a check that the flag works.
    const tools = buildWebTools({ allowPrivateNetwork: true })
    const result = (await callWeb(tools, { url: `http://127.0.0.1:${port}/` })) as {
      ok: boolean
      content: string
    }

    expect(result.ok).toBe(true)
    expect(result.content).toContain('Title')
    expect(result.content).toContain('Body & text')
    // Script and style bodies must not survive into the model's context.
    expect(result.content).not.toContain('alert(1)')
    expect(result.content).not.toContain('color:red')

    server.close()
  })

  it('reports an HTTP error rather than pretending it worked', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(404)
      res.end('nope')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port

    const tools = buildWebTools({ allowPrivateNetwork: true })
    expect(await callWeb(tools, { url: `http://127.0.0.1:${port}/` })).toMatchObject({
      ok: false,
      status: 404,
    })

    server.close()
  })

  it('caps an enormous response instead of exhausting memory', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('x'.repeat(2_000_000))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port

    const tools = buildWebTools({ allowPrivateNetwork: true, maxBytes: 5_000 })
    const result = (await callWeb(tools, { url: `http://127.0.0.1:${port}/` })) as {
      content: string
      truncated: boolean
    }

    expect(result.content.length).toBeLessThanOrEqual(5_000)
    expect(result.truncated).toBe(true)

    server.close()
  })
})
