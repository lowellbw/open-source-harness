#!/usr/bin/env node
//
// The Node sidecar the macOS shell launches.
//
// It exists to satisfy one contract, written down in SidecarLaunch.swift and in the
// shell's README, which the Next.js app cannot satisfy on its own:
//
//   1. read PORT from the environment; PORT=0 means "bind any free port"
//   2. once the listener is accepting, print exactly one line to stdout:
//
//        AGENTIC_SIDECAR_READY {"port":51234,"token":"…"}
//
//   3. exit when stdin reaches EOF
//   4. treat the loopback listener as untrusted
//
// It also carries the /api/* surface the native Mac UI talks to, unchanged — the
// wrapper only owns the socket and the credential check, and hands every request
// straight to Next.
//
// `next start` cannot do any of this: it binds a fixed port, prints a banner rather
// than a machine-readable line, and has no stdin contract. So this is a thin wrapper
// that owns the socket and hands accepted requests to Next's request handler.
//
// The order below is the part that matters. The port is discovered by binding first,
// and the ready line is printed only after Next has finished `prepare()`. Printing
// on `listen` alone would be within the letter of the contract and still wrong: the
// shell would connect to a socket that answers 503 until the framework caught up.

import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const READY_MARKER = 'AGENTIC_SIDECAR_READY'
const SESSION_COOKIE = 'agentic_session'
const HERE = path.dirname(fileURLToPath(import.meta.url))

// Everything this script says for itself goes to stderr. stdout carries the ready
// line and Next's own output, and a stray log line that happened to contain the
// marker would be parsed as a port.
const note = (...args) => console.error('[sidecar]', ...args)

// --- locating the web app ----------------------------------------------------
//
// Two layouts, because there are two ways this runs. A packaged build has the web
// app copied in next to this file (build.sh --sidecar copies the whole directory
// into Contents/Resources/sidecar). A development run points AGENTIC_SIDECAR_PATH at
// this file inside the repo, where the app is at apps/web.

function resolveAppDir() {
  const candidates = []
  if (process.env.AGENTIC_WEB_DIR) candidates.push(process.env.AGENTIC_WEB_DIR)
  candidates.push(path.join(HERE, 'web'))

  // Walk up looking for apps/web. Bounded, so a misconfigured run fails with the
  // list of places it looked rather than climbing to /.
  let dir = HERE
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, 'apps', 'web'))
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) return path.resolve(candidate)
  }
  note('could not find the web app. Looked in:')
  for (const candidate of candidates) note('   ', candidate)
  note('Set AGENTIC_WEB_DIR to the directory containing the Next.js app.')
  process.exit(78) // EX_CONFIG
}

const appDir = resolveAppDir()

// --- the shell's credential name is not the gateway's ---------------------------
//
// The Swift side exports AGENTIC_PROVIDER_API_KEY, on purpose: the shell has no
// business knowing which provider is behind the gateway, and a managed deployment
// has no local key at all — the org's key lives in the gateway, which is also where
// budgets and model gating are enforced.
//
// `ModelGateway` reads OPENROUTER_API_KEY. Without this line the two never meet and
// every /api route answers HTTP 500 with "No model provider key", which reads as the
// shell being broken rather than as a naming mismatch. This wrapper is the seam
// between the two contracts, so the translation belongs here rather than in the Swift
// or in the gateway.
if (process.env.AGENTIC_PROVIDER_API_KEY && !process.env.OPENROUTER_API_KEY) {
  process.env.OPENROUTER_API_KEY = process.env.AGENTIC_PROVIDER_API_KEY
  note('mapped AGENTIC_PROVIDER_API_KEY to OPENROUTER_API_KEY for the gateway')
}

// `dev` defaults to off. A shipped app must never run a dev server: it recompiles on
// demand, writes into the bundle, and takes seconds to answer the first request.
const dev = process.env.AGENTIC_SIDECAR_DEV === '1'

if (!dev && !fs.existsSync(path.join(appDir, '.next', 'BUILD_ID'))) {
  note(`no production build at ${path.join(appDir, '.next')}`)
  note('Run `pnpm --filter @workspace/web build` first, or set AGENTIC_SIDECAR_DEV=1')
  process.exit(78)
}

// Resolved from the app's own directory, not from this file's. In the repo layout
// this script sits in apps/mac-shell, which has no node_modules of its own, and
// Node's upward resolution would never reach apps/web/node_modules.
const requireFromApp = createRequire(path.join(appDir, 'package.json'))
const nextModule = requireFromApp('next')
const next = typeof nextModule === 'function' ? nextModule : nextModule.default

// --- the loopback listener is not a security boundary ------------------------
//
// Any local process running as any user can connect to 127.0.0.1. The token is
// printed on the ready line, which only the shell can read — it arrives over the
// pipe the shell owns — and the shell hands it straight back as `?t=` on the first
// request. That request is exchanged for a session cookie; everything afterwards is
// authenticated by the cookie.
//
// The token stays valid for the life of the process rather than being consumed on
// first use. A single-use token is a nicer property on paper, but WKWebView's
// persistent data store can drop the cookie (a website-data reset, a new profile)
// while the shell keeps reloading the same URL, and the failure mode is a workspace
// that 401s with no way back. Both secrets are per-process and never touch disk.
const token = randomBytes(24).toString('base64url')
const sessionSecret = randomBytes(32).toString('base64url')

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function readCookie(header, name) {
  if (!header) return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return null
}

/// Rejects a Host header that is not our own loopback listener.
///
/// Without this, a name that resolves to 127.0.0.1 turns any page on the internet
/// into an origin that can talk to the workspace: the browser sends the request to
/// loopback, and the workspace's cookie goes with it. Checking the header costs
/// nothing and closes it.
function hostIsLoopback(req, port) {
  const host = req.headers.host
  if (!host) return false
  const [name, declaredPort] = host.startsWith('[')
    ? [host.slice(1, host.indexOf(']')), host.slice(host.indexOf(']') + 2)]
    : host.split(':')
  if (declaredPort && Number(declaredPort) !== port) return false
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

function authorize(req, res, port) {
  if (!hostIsLoopback(req, port)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Forbidden: unexpected Host header.\n')
    return null
  }

  const url = new URL(req.url, `http://127.0.0.1:${port}`)

  // A native client is not a browser and has no reason to run a cookie exchange.
  // The Mac shell reads the token off the ready line and sends it as a bearer
  // credential on every request, which is both simpler and stateless.
  const authorization = req.headers.authorization
  if (authorization && authorization.startsWith('Bearer ')) {
    if (constantTimeEqual(authorization.slice(7), token)) return req
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Unauthorized: bad bearer token.\n')
    return null
  }

  const cookie = readCookie(req.headers.cookie, SESSION_COOKIE)
  if (cookie && constantTimeEqual(cookie, sessionSecret)) {
    // Strip a token that is still on the URL so a reload does not keep replaying it.
    if (url.searchParams.has('t')) {
      url.searchParams.delete('t')
      req.url = url.pathname + (url.search || '')
    }
    return req
  }

  const presented = url.searchParams.get('t')
  if (presented && constantTimeEqual(presented, token)) {
    url.searchParams.delete('t')
    const target = url.pathname + (url.search || '')
    res.writeHead(303, {
      // No Secure flag: the workspace is plain HTTP on loopback by design, and a
      // Secure cookie would simply never be stored. HttpOnly and SameSite=Strict
      // are the two that do work here.
      'set-cookie': `${SESSION_COOKIE}=${sessionSecret}; Path=/; HttpOnly; SameSite=Strict`,
      // Redirect rather than serve, so the token never reaches the page, its
      // history entry, or a Referer header on the first subresource.
      location: target,
      'cache-control': 'no-store',
    })
    res.end()
    return null
  }

  res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end('Unauthorized: this workspace requires the session token issued to the shell.\n')
  return null
}

// --- listen first, then prepare, then announce -------------------------------

let handleRequest = null
// Run in reverse-registration order at shutdown; Next registers one here once it is
// prepared, and there is nothing to run before that.
const shutdownHooks = []

const server = createServer((req, res) => {
  const port = server.address()?.port ?? 0
  if (!authorize(req, res, port)) return
  if (!handleRequest) {
    // Only reachable if something connected between `listen` and the ready line —
    // which the shell does not do, because it has not been told the port yet.
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Workspace is still starting.\n')
    return
  }
  handleRequest(req, res)
})

// Tracked so shutdown can be immediate. `server.close()` stops accepting but waits
// for every keep-alive connection to go idle, and WKWebView holds several open.
const sockets = new Set()
server.on('connection', (socket) => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
})

server.on('error', (error) => {
  note('listener failed:', error.message)
  process.exit(1)
})

// The shell never picks a port, so PORT is 0 in every real launch; an explicit value
// is honoured for the case where someone is driving this by hand.
const requestedPort = Number(process.env.PORT ?? 0) || 0

// 127.0.0.1, not 0.0.0.0 and not `localhost`. Binding the wildcard address would put
// the workspace on every interface the machine has; binding by name can land on ::1
// only, which is the one address the shell does not dial.
server.listen(requestedPort, '127.0.0.1', async () => {
  const port = server.address().port

  try {
    const app = next({
      dev,
      dir: appDir,
      hostname: '127.0.0.1',
      // Next wants the port for the URLs it constructs, and it can only be told
      // after the bind. This is why the server is created before the framework
      // rather than the other way round.
      port,
      customServer: true,
    })
    await app.prepare()
    handleRequest = app.getRequestHandler()
    shutdownHooks.push(() => app.close?.())
  } catch (error) {
    note('Next.js failed to start:', error?.stack || error)
    process.exit(1)
  }

  // The one line the shell is waiting for, and the only thing this script writes to
  // stdout. Printed here — after prepare() resolved and with the listener already
  // accepting — so the first request the shell makes is served, not raced.
  process.stdout.write(`${READY_MARKER} ${JSON.stringify({ port, token })}\n`)
  note(`listening on http://127.0.0.1:${port} (${dev ? 'dev' : 'production'}, ${appDir})`)
})

// --- shutdown ----------------------------------------------------------------

let shuttingDown = false

function shutdown(reason, code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  note(`shutting down (${reason})`)

  // A hard deadline. Whatever is still holding a handle, this process must not be
  // the thing that outlives the app and keeps a loopback port bound.
  const deadline = setTimeout(() => process.exit(code), 2000)
  deadline.unref()

  server.close(() => {
    Promise.allSettled(shutdownHooks.map((hook) => hook())).then(() => process.exit(code))
  })
  for (const socket of sockets) socket.destroy()
}

// EOF on stdin is the primary stop signal and the only one that survives the shell
// being SIGKILLed: the kernel closes the write end, this process sees EOF, and no
// orphan is left holding the port. SIGTERM covers the orderly case only.
process.stdin.resume()
process.stdin.on('end', () => shutdown('stdin EOF'))
process.stdin.on('close', () => shutdown('stdin closed'))
process.stdin.on('error', () => shutdown('stdin error'))

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGHUP', () => shutdown('SIGHUP'))
