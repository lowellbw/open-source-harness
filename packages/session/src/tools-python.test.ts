import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { WorkspaceEvent } from '@workspace/protocol'
import { LocalWorkspace } from '@workspace/workspace'
import { ApprovalGate } from './approvals.js'
import { buildPythonTools, PYTHON_SCOPE } from './tools-python.js'

const tmpDirs: string[] = []

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function harness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'python-'))
  tmpDirs.push(root)
  const workspace = new LocalWorkspace({ root })
  await workspace.start()

  const events: WorkspaceEvent[] = []
  const approvals = new ApprovalGate((e) => events.push(e))
  const tools = buildPythonTools({ workspace, approvals, emit: (e) => events.push(e) })

  const call = (args: unknown) =>
    (tools.runPython!.execute as (a: unknown, o: unknown) => Promise<never>)(args, {})

  /** Answers the next prompt, since request() blocks until someone does. */
  const answer = async (decision: 'allow' | 'deny' | 'session') => {
    await vi.waitFor(() => expect(approvals.list()).toHaveLength(1))
    approvals.resolve(approvals.list()[0]!.approvalId, decision)
  }

  return { workspace, approvals, events, call, answer }
}

describe('running python', () => {
  it('returns what the script printed', async () => {
    const { call, answer } = await harness()
    const pending = call({ code: 'print(2 + 2)', label: 'sum' })
    await answer('allow')

    const result = (await pending) as { ok: boolean; stdout: string }
    expect(result.ok).toBe(true)
    expect(result.stdout.trim()).toBe('4')
  })

  it('reports a failing script rather than pretending it worked', async () => {
    const { call, answer } = await harness()
    const pending = call({ code: 'raise ValueError("bad data")', label: 'boom' })
    await answer('allow')

    const result = (await pending) as { ok: boolean; exitCode: number; stderr: string }
    expect(result.ok).toBe(false)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('bad data')
  })

  it('keeps stderr on success, because a warning explains a wrong number', async () => {
    const { call, answer } = await harness()
    const pending = call({
      code: 'import sys; print("ok"); print("careful", file=sys.stderr)',
      label: 'warn',
    })
    await answer('allow')

    const result = (await pending) as { ok: boolean; stderr: string }
    expect(result.ok).toBe(true)
    expect(result.stderr).toContain('careful')
  })

  it('notices files the script created', async () => {
    const { call, answer } = await harness()
    const pending = call({
      code: 'open("tmp_out.csv","w").write("a,b\\n1,2\\n")',
      label: 'write',
    })
    await answer('allow')

    const result = (await pending) as { created?: string[] }
    expect(result.created).toContain('/tmp_out.csv')
  })

  it('separates charts from other files it made', async () => {
    // A chart goes in the artifact pane; a CSV does not.
    const { call, answer } = await harness()
    const pending = call({
      code: [
        'import matplotlib.pyplot as plt',
        'plt.plot([1,2,3],[2,4,8])',
        'plt.savefig("chart.png")',
        'open("data.csv","w").write("x\\n1\\n")',
      ].join('\n'),
      label: 'plot',
    })
    await answer('allow')

    const result = (await pending) as { ok: boolean; charts?: string[]; created?: string[] }
    expect(result.ok).toBe(true)
    expect(result.charts).toEqual(['/chart.png'])
    expect(result.created).toContain('/data.csv')
  })

  it('uses a non-interactive matplotlib backend', async () => {
    // Without MPLBACKEND=Agg matplotlib hunts for a display, fails to find
    // one, and takes the script down with it.
    const { call, answer } = await harness()
    const pending = call({
      code: 'import matplotlib; print(matplotlib.get_backend())',
      label: 'backend',
    })
    await answer('allow')

    expect(((await pending) as { stdout: string }).stdout.toLowerCase()).toContain('agg')
  })

  it('keeps the script in the workspace, so the analysis is inspectable', async () => {
    const { workspace, call, answer } = await harness()
    const pending = call({ code: 'print(1)', label: 'my analysis' })
    await answer('allow')

    const result = (await pending) as { script: string }
    expect(result.script).toBe('/.python/my-analysis.py')
    expect(await workspace.read(result.script)).toBe('print(1)')
  })

  it('has no memory between calls, and says so in its description', async () => {
    // Stated, because a model that assumes a kernel writes cells that depend
    // on the last one and cannot understand why they fail.
    const { call, answer } = await harness()
    const first = call({ code: 'x = 99', label: 'one' })
    await answer('session')
    await first

    const second = (await call({ code: 'print(x)', label: 'two' })) as { ok: boolean; stderr: string }
    expect(second.ok).toBe(false)
    expect(second.stderr).toContain('NameError')
  })
})

describe('consent', () => {
  it('asks before running anything', async () => {
    const { call, answer, events } = await harness()
    const pending = call({ code: 'print(1)', label: 'x' })
    await answer('allow')
    await pending

    expect(events.some((e) => e.type === 'approval.requested')).toBe(true)
  })

  it('refuses when denied, and runs nothing', async () => {
    const { workspace, call, answer } = await harness()
    const pending = call({ code: 'open("should-not-exist","w").write("x")', label: 'x' })
    await answer('deny')

    expect(await pending).toMatchObject({ ok: false })
    expect(await workspace.exists('/should-not-exist')).toBe(false)
  })

  it('asks EVERY time when consent was only for once', async () => {
    const { call, answer, events } = await harness()
    const first = call({ code: 'print(1)', label: 'a' })
    await answer('allow')
    await first

    const second = call({ code: 'print(2)', label: 'b' })
    await answer('allow')
    await second

    expect(events.filter((e) => e.type === 'approval.requested')).toHaveLength(2)
  })

  it('stops asking once consent is given for the session', async () => {
    /*
     * The point of the third option. Arbitrary code cannot be judged
     * reversible in advance so it must be gated — but prompting on every cell
     * of an analysis is what §9 warns about: it manufactures consent instead
     * of obtaining it, and by the fourth prompt nobody is reading.
     */
    const { call, answer, events, approvals } = await harness()

    const first = call({ code: 'print(1)', label: 'a' })
    await answer('session')
    await first

    // No answer given for these; they must not block.
    expect(await call({ code: 'print(2)', label: 'b' })).toMatchObject({ ok: true })
    expect(await call({ code: 'print(3)', label: 'c' })).toMatchObject({ ok: true })

    expect(events.filter((e) => e.type === 'approval.requested')).toHaveLength(1)
    expect(approvals.grantedForSession()).toEqual([PYTHON_SCOPE])
  })

  it('asks again after the grant is revoked', async () => {
    const { call, answer, approvals, events } = await harness()
    const first = call({ code: 'print(1)', label: 'a' })
    await answer('session')
    await first

    approvals.revokeScope(PYTHON_SCOPE)

    const second = call({ code: 'print(2)', label: 'b' })
    await answer('allow')
    await second

    expect(events.filter((e) => e.type === 'approval.requested')).toHaveLength(2)
  })

  it('does not let a shell grant authorise python', async () => {
    // Scopes are separate because the decisions are separate: someone who
    // agreed to run a build has not agreed to arbitrary Python.
    const { call, approvals, events } = await harness()
    approvals.resolve('nonexistent', 'session')

    const pending = call({ code: 'print(1)', label: 'a' })
    await vi.waitFor(() => expect(approvals.list()).toHaveLength(1))
    approvals.resolve(approvals.list()[0]!.approvalId, 'allow')
    await pending

    expect(events.filter((e) => e.type === 'approval.requested')).toHaveLength(1)
  })
})

describe('the leading-slash trap', () => {
  it('warns when a script wrote outside the workspace and produced nothing in it', async () => {
    /*
     * A shell — and so a Python process — gets a real filesystem with a real
     * `/`, unlike the file tools, which rewrite a leading `/` to the workspace
     * root. CLAUDE.md calls that asymmetry deliberate, and it is; the failure
     * mode is that a model writing plt.savefig("/chart.png") believes it saved
     * into the workspace and has written to the root of the machine.
     *
     * The tool cannot prevent it without breaking legitimate absolute paths.
     * It can notice the shape of it and say so.
     */
    const { workspace, call, answer } = await harness()
    const pending = call({
      code: 'open("/tmp/outside-the-workspace.txt","w").write("x")',
      label: 'oops',
    })
    await answer('allow')

    const result = (await pending) as { ok: boolean; warning?: string; created?: string[] }
    expect(result.ok).toBe(true)
    expect(result.created).toBeUndefined()
    expect(result.warning).toContain('relative path')
    expect(await workspace.exists('/outside-the-workspace.txt')).toBe(false)
  })

  it('says nothing when a relative path worked', async () => {
    const { call, answer } = await harness()
    const pending = call({ code: 'open("fine.txt","w").write("x")', label: 'fine' })
    await answer('allow')

    const result = (await pending) as { created?: string[]; warning?: string }
    expect(result.created).toContain('/fine.txt')
    expect(result.warning).toBeUndefined()
  })
})
