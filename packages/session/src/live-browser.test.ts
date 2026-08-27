import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { WorkspaceEvent } from '@workspace/protocol'
import { LocalWorkspace } from '@workspace/workspace'
import { ApprovalGate } from './approvals.js'
import { buildBrowserTools } from './tools-browser.js'

/**
 * Against real Chromium.
 *
 * The unit tests use a fake browser, which proves the gating and the framing
 * and nothing about whether Playwright actually launches here. This drives the
 * pre-installed build against a local page — served from 127.0.0.1, so it
 * needs `allowPrivateNetwork`, which is itself a check that the refusal is
 * doing something rather than being decorative.
 *
 * Not opt-in behind RUN_LIVE: it costs nothing and touches no network beyond
 * loopback. It skips if Chromium is absent rather than failing, because a
 * machine without it is a configuration, not a bug.
 */
const servers: http.Server[] = []
const tmpDirs: string[] = []

afterEach(async () => {
  servers.splice(0).forEach((s) => s.close())
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

const hasChromium =
  Boolean(process.env.PLAYWRIGHT_BROWSERS_PATH) ||
  ['/opt/pw-browsers/chromium/chrome-linux/chrome'].some((p) => {
    try {
      return require('node:fs').existsSync(p)
    } catch {
      return false
    }
  })

const withChromium = hasChromium ? it : it.skip

describe('real Chromium', () => {
  withChromium('loads a page, reads it, and clicks something', { timeout: 120_000 }, async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      if (req.url === '/next') {
        res.end('<html><head><title>Second</title></head><body><h1>Second page</h1><p>You clicked through.</p></body></html>')
        return
      }
      res.end(
        '<html><head><title>First page</title></head><body><h1>First page</h1>' +
          '<p>Rendered by JavaScript:</p><div id="late"></div>' +
          '<a id="go" href="/next">Continue</a>' +
          '<script>document.getElementById("late").textContent = "it ran"</script>' +
          '</body></html>',
      )
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    servers.push(server)
    const port = (server.address() as { port: number }).port

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'live-browser-'))
    tmpDirs.push(root)
    const workspace = new LocalWorkspace({ root })
    await workspace.start()

    const events: WorkspaceEvent[] = []
    const approvals = new ApprovalGate((e) => {
      events.push(e)
      if (e.type === 'approval.requested') {
        approvals.resolve((e as { approvalId: string }).approvalId, 'session')
      }
    })

    const tools = buildBrowserTools({
      workspace,
      approvals,
      emit: (e) => events.push(e),
      // Loopback is refused by default; opting in here is itself a check that
      // the refusal is real.
      allowPrivateNetwork: true,
    })
    const call = (name: string, args: unknown) =>
      (tools[name]!.execute as (a: unknown, o: unknown) => Promise<never>)(args, {})

    const opened = (await call('browse', { url: `http://127.0.0.1:${port}/` })) as {
      ok: boolean
      title: string
      content: string
      screenshot: string
    }

    console.log('  result:', JSON.stringify(opened).slice(0, 300))

    expect(opened.ok).toBe(true)
    expect(opened.title).toBe('First page')
    // Proof it is a real browser and not fetchUrl: this text exists only
    // because a script wrote it after load.
    expect(opened.content).toContain('it ran')

    const shot = await workspace.readBytes(opened.screenshot)
    expect(Array.from(shot.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(shot.byteLength).toBeGreaterThan(1_000)

    const clicked = (await call('browserAct', {
      action: 'click',
      selector: '#go',
    })) as { ok: boolean; content: string }

    expect(clicked.ok).toBe(true)
    expect(clicked.content).toContain('You clicked through')

    await call('browserClose', {})
  })
})
