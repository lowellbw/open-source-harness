#!/usr/bin/env node
/**
 * The Node sidecar the Mac shell launches.
 *
 * `apps/mac-shell/Sources/MacShell/SidecarLaunch.swift` specifies the contract
 * this implements, and nothing satisfied it before this file existed — the
 * shell would compile and then sit on its failure screen forever.
 *
 * Contract, in full:
 *
 *   - Read PORT from the environment. 0 means "any free port". The shell never
 *     picks one: a fixed port is a collision waiting to happen.
 *   - Print exactly one line on stdout once the listener is accepting:
 *
 *         AGENTIC_SIDECAR_READY {"port":51234,"token":"…"}
 *
 *     After the listen callback, never before, or the shell races the listener.
 *   - Everything else on stdout is treated as log output.
 *   - Shut down when stdin reaches EOF. That is the only signal that survives
 *     the shell being SIGKILLed, and without it the sidecar outlives the app.
 *
 * It serves the same Next.js application the web shell serves, rather than a
 * parallel implementation. One UI, one API surface, one set of behaviours.
 */

import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { fstatSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import next from 'next'

const READY_MARKER = 'AGENTIC_SIDECAR_READY'
const COOKIE_NAME = 'agentic_sidecar'

/** Log to stderr. stdout carries the ready line and must not be polluted. */
const log = (...args) => console.error('[sidecar]', ...args)

/**
 * A loopback listener is not a security boundary on a multi-user Mac: any local
 * process running as any user can connect to 127.0.0.1. So the sidecar mints a
 * token, announces it on stdout where only its parent can see it, and refuses
 * every request that does not present it.
 *
 * The shell hands it back once as `?t=…`; we exchange that for an httpOnly
 * cookie and redirect to strip it from the URL, so it never lingers in history
 * or a Referer header.
 */
const token = randomBytes(32).toString('hex')

const webDir = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  process.env.AGENTIC_WEB_DIR ?? '../web',
)

const app = next({ dev: false, dir: webDir })
const handle = app.getRequestHandler()

function readCookie(header, name) {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return undefined
}

/**
 * Constant-time compare, so a caller cannot recover the token by timing how
 * long a rejection takes.
 */
function tokenMatches(candidate) {
  if (typeof candidate !== 'string' || candidate.length !== token.length) return false
  let mismatch = 0
  for (let i = 0; i < token.length; i++) mismatch |= token.charCodeAt(i) ^ candidate.charCodeAt(i)
  return mismatch === 0
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)

  // Token exchange: present it once, get a cookie, and lose the token from the
  // address bar via a redirect.
  const presented = url.searchParams.get('t')
  if (presented !== null) {
    if (!tokenMatches(presented)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('Invalid token\n')
      return
    }
    url.searchParams.delete('t')
    res.writeHead(302, {
      // Session cookie, httpOnly, SameSite=Strict: not readable from page
      // scripts and not sent on a cross-site navigation.
      'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict`,
      Location: `${url.pathname}${url.search}`,
    })
    res.end()
    return
  }

  if (!tokenMatches(readCookie(req.headers.cookie, COOKIE_NAME))) {
    res.writeHead(401, { 'Content-Type': 'text/plain' })
    res.end('Unauthorized\n')
    return
  }

  handle(req, res).catch((err) => {
    log('request failed:', err)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

let shuttingDown = false
async function shutdown(reason) {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutting down (${reason})`)

  // Stop accepting, then give in-flight requests a moment. An agent turn may be
  // mid-tool-call with real side effects; killing it instantly is worse than
  // waiting a beat.
  server.close()
  const forced = setTimeout(() => process.exit(0), 5_000)
  forced.unref()

  try {
    await app.close?.()
  } catch (err) {
    log('close failed:', err)
  }
  process.exit(0)
}

/**
 * EOF on stdin is the shutdown signal that survives the parent being SIGKILLed:
 * applicationWillTerminate does not run on a crash or on a SIGTERM to the app,
 * so without this the sidecar is orphaned and keeps holding the port.
 *
 * Armed only when stdin is a pipe. Under `/dev/null` — how a process manager or
 * a detached shell commonly spawns things — EOF arrives immediately and the
 * sidecar would exit before it ever served a request. A pipe reports isFIFO();
 * /dev/null reports isCharacterDevice(), so the two are cleanly separable.
 */
function stdinIsPipe() {
  try {
    const stat = fstatSync(0)
    return stat.isFIFO() || stat.isSocket()
  } catch {
    return false
  }
}

if (stdinIsPipe()) {
  process.stdin.resume()
  process.stdin.on('end', () => void shutdown('stdin EOF'))
  process.stdin.on('close', () => void shutdown('stdin closed'))
} else {
  log('stdin is not a pipe — EOF watchdog disabled; shutdown relies on signals')
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

try {
  await app.prepare()
} catch (err) {
  log('failed to prepare the web application:', err)
  process.exit(1)
}

const requestedPort = Number(process.env.PORT ?? 0)

server.listen(Number.isFinite(requestedPort) ? requestedPort : 0, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : requestedPort

  // The one line on stdout, and only now — the listener is accepting.
  process.stdout.write(`${READY_MARKER} ${JSON.stringify({ port, token })}\n`)

  log(`listening on 127.0.0.1:${port}`)
  log(`data dir: ${process.env.AGENTIC_DATA_DIR ?? '(unset)'}`)
  log(`shell: ${process.env.AGENTIC_SHELL ?? 'unknown'}`)
})

server.on('error', (err) => {
  log('listener failed:', err)
  process.exit(1)
})
