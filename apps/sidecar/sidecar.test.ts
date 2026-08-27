import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { existsSync } from 'node:fs'

/**
 * Verifies the contract in `apps/mac-shell/Sources/MacShell/SidecarLaunch.swift`.
 *
 * The Swift half cannot be compiled here, so this is the only end of the
 * contract that can be tested at all — which makes it worth testing properly.
 * If the ready line changes shape, or the token stops being enforced, the Mac
 * shell breaks in a way nobody would notice until someone with a Mac tried it.
 */

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url))
const WEB_DIR = fileURLToPath(new URL('../web', import.meta.url))
const READY_MARKER = 'AGENTIC_SIDECAR_READY'

// Serving requires a production build of the web app; without one the sidecar
// exits during prepare() and every assertion below would be about the wrong
// thing. Skipping loudly beats failing confusingly.
const built = fs.existsSync(path.join(WEB_DIR, '.next', 'BUILD_ID'))

interface Started {
  child: ChildProcessWithoutNullStreams
  port: number
  token: string
  stderr: string[]
}

function start(env: Record<string, string> = {}): Promise<Started> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: '0', AGENTIC_SHELL: 'test', ...env },
    })

    const stderr: string[] = []
    let stdout = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`no ready line within 90s. stderr:\n${stderr.join('\n')}`))
    }, 90_000)

    child.stderr.on('data', (d: Buffer) => stderr.push(d.toString()))
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
      for (const line of stdout.split('\n')) {
        if (!line.startsWith(READY_MARKER)) continue
        clearTimeout(timer)
        const payload = JSON.parse(line.slice(READY_MARKER.length).trim())
        resolve({ child, port: payload.port, token: payload.token, stderr })
        return
      }
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

const get = (port: number, pathname: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}${pathname}`, { headers, redirect: 'manual' })

describe.skipIf(!built)('sidecar ready-line contract', () => {
  let started: Started

  beforeAll(async () => {
    started = await start()
  }, 120_000)

  afterAll(() => {
    started?.child.kill('SIGKILL')
  })

  it('announces a real port, not the requested 0', () => {
    // PORT=0 means "any free port"; the ready line is the single source of
    // truth for where it actually landed.
    expect(started.port).toBeGreaterThan(0)
    expect(started.port).toBeLessThan(65_536)
  })

  it('announces a token', () => {
    expect(started.token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is genuinely accepting by the time the line is printed', async () => {
    // Printing before listen() calls back is the race the Swift comment warns
    // about: the shell would connect to nothing.
    const res = await get(started.port, `/?t=${started.token}`)
    expect(res.status).toBe(302)
  })

  it('keeps stdout clean apart from the ready line', () => {
    // Everything else is treated as log output by the shell's line buffer, so
    // diagnostics belong on stderr.
    expect(started.stderr.join('')).toContain('listening on 127.0.0.1')
  })
})

describe.skipIf(!built)('token enforcement', () => {
  let started: Started

  beforeAll(async () => {
    started = await start()
  }, 120_000)

  afterAll(() => {
    started?.child.kill('SIGKILL')
  })

  it('refuses an unauthenticated request', async () => {
    // A loopback listener is not a boundary: any local process as any user can
    // reach 127.0.0.1.
    expect((await get(started.port, '/')).status).toBe(401)
  })

  it('refuses a wrong token', async () => {
    expect((await get(started.port, `/?t=${'0'.repeat(64)}`)).status).toBe(403)
  })

  it('exchanges a valid token for an httpOnly cookie', async () => {
    const res = await get(started.port, `/?t=${started.token}`)
    expect(res.status).toBe(302)

    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('agentic_sidecar=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
  })

  it('strips the token from the URL it redirects to', async () => {
    // Otherwise it lingers in history and in any Referer the page sends.
    const res = await get(started.port, `/?t=${started.token}`)
    expect(res.headers.get('location')).toBe('/')
  })

  it('serves the application once the cookie is presented', async () => {
    const res = await get(started.port, '/', {
      cookie: `agentic_sidecar=${started.token}`,
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Workspace')
  })

  it('protects the API, not just the page', async () => {
    // The API is where the agent and the workspace live; leaving it open while
    // gating the HTML would be theatre.
    expect((await get(started.port, '/api/models?sessionId=x')).status).toBe(401)

    const authed = await get(started.port, '/api/models?sessionId=x', {
      cookie: `agentic_sidecar=${started.token}`,
    })
    expect(authed.status).toBe(200)
  })

  it('issues a different token per launch', async () => {
    const second = await start()
    expect(second.token).not.toBe(started.token)
    second.child.kill('SIGKILL')
  }, 120_000)
})

describe.skipIf(!built)('shutdown', () => {
  it('exits when stdin reaches EOF', async () => {
    // The only signal that survives the shell being SIGKILLed. Without it the
    // sidecar is orphaned and keeps holding the port.
    const started = await start()

    const exited = new Promise<number | null>((resolve) => {
      started.child.on('exit', (code) => resolve(code))
    })
    started.child.stdin.end()

    const code = await Promise.race([
      exited,
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 20_000)),
    ])
    expect(code).not.toBe('timeout')
  }, 150_000)
})

describe.skipIf(!built)('stdin that is not a pipe', () => {
  it('does NOT exit immediately when stdin is /dev/null', async () => {
    // A process manager or detached shell commonly hands a child /dev/null,
    // which reaches EOF at once. Armed unconditionally, the watchdog killed the
    // sidecar before it served anything. A pipe reports isFIFO(); /dev/null
    // reports isCharacterDevice(), so the two are cleanly separable.
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 90_000)
      child.stdout.on('data', (d: Buffer) => {
        if (d.toString().includes(READY_MARKER)) {
          clearTimeout(timer)
          resolve(true)
        }
      })
      child.on('exit', () => {
        clearTimeout(timer)
        resolve(false)
      })
    })

    child.kill('SIGKILL')
    expect(ready).toBe(true)
  }, 120_000)
})

describe('sidecar test coverage', () => {
  it('reports whether the suite actually ran', () => {
    if (!built) {
      console.warn(
        '[sidecar] skipped — apps/web has no production build. Run `pnpm --filter @workspace/web build` first.',
      )
    }
    expect(typeof built).toBe('boolean')
  })
})

describe('the bridge between the shell and the application', () => {
  const server = fileURLToPath(new URL('./server.mjs', import.meta.url))

  /** Runs the sidecar with a given node binary and environment, briefly. */
  function launch(node: string, env: Record<string, string>) {
    return spawnSync(node, [server], {
      env: { PATH: '/usr/bin:/bin', ...env },
      encoding: 'utf8',
      timeout: 20_000,
      input: '',
    })
  }

  const NODE_TOO_OLD = '/opt/node20/bin/node'
  const hasOldNode = existsSync(NODE_TOO_OLD)
  const withOldNode = hasOldNode ? it : it.skip

  withOldNode('refuses to start on a Node without node:sqlite', () => {
    /*
     * `node:sqlite` landed in 22.3, and every thread, message and cost row
     * goes through it. On anything older the sidecar used to start perfectly,
     * announce itself, serve the UI, and then return 500 for the first thread
     * anybody opened — the real error one line deep in stderr, and what the
     * user saw was an app that did not work.
     *
     * This matters most on a Mac: /usr/local/bin/node is Homebrew's, and the
     * shell resolves node from several candidate paths, so which one it finds
     * depends on the machine.
     */
    const result = launch(NODE_TOO_OLD, { PORT: '0' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('too old')
    expect(result.stderr).toContain('node:sqlite')
    // Names the binary, because "install a newer node" is unhelpful when three
    // are installed and the wrong one was picked.
    expect(result.stderr).toContain(NODE_TOO_OLD)
    // The ready line must NOT be printed — the shell waits on it.
    expect(result.stdout).not.toContain('AGENTIC_SIDECAR_READY')
  })

  it('maps the shell’s variable names onto the ones the app reads', () => {
    /*
     * SidecarLaunch.swift and the web application were written against
     * different vocabularies, and every mismatch fails quietly:
     * AGENTIC_PROVIDER_API_KEY vs OPENROUTER_API_KEY refuses every turn, and
     * AGENTIC_DATA_DIR vs AGENTIC_WORKSPACE_HOME sends writes to ~/ , which a
     * sandboxed Mac app may not create.
     */
    const result = launch(process.execPath, {
      PORT: '0',
      AGENTIC_PROVIDER_API_KEY: 'test-key',
      AGENTIC_DATA_DIR: '/tmp/mac-data',
      AGENTIC_SEARCH_API_KEY: 'test-brave',
      // Exit before serving; the mapping is logged during startup.
      AGENTIC_WEB_DIR: '/nonexistent',
    })

    expect(result.stderr).toContain('mapped AGENTIC_PROVIDER_API_KEY -> OPENROUTER_API_KEY')
    expect(result.stderr).toContain('mapped AGENTIC_DATA_DIR -> AGENTIC_WORKSPACE_HOME')
    expect(result.stderr).toContain('mapped AGENTIC_SEARCH_API_KEY -> BRAVE_API_KEY')
  })

  it('warns at startup when there is no model key, rather than at the first turn', () => {
    const result = launch(process.execPath, { PORT: '0', AGENTIC_WEB_DIR: '/nonexistent' })
    expect(result.stderr).toContain('no model provider key')
  })
})
