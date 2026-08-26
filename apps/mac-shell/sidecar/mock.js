#!/usr/bin/env node
//
// A mock sidecar that speaks the same /api surface as the real one.
//
// The real sidecar needs a provider key before it will answer anything: every
// route calls getSession(), which builds the gateway, which throws without one. That
// makes the native UI impossible to develop or verify on a machine with no key, and
// impossible to test against the awkward states — a tool that fails, an approval that
// blocks a run, a compaction mid-turn — which is exactly the UI worth getting right.
//
// So this serves canned but structurally real WorkspaceEvents. It implements the same
// ready-line contract, the same bearer credential and the same routes, so the Swift
// client cannot tell the difference and no "if mock" branch exists on that side.
//
//   AGENTIC_SIDECAR_PATH=$PWD/sidecar/mock.js \
//     "build/Agentic Workspace.app/Contents/MacOS/MacShell"

import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'

const READY_MARKER = 'AGENTIC_SIDECAR_READY'
const token = randomBytes(24).toString('base64url')
const note = (...a) => console.error('[mock]', ...a)

const MODELS = [
  { alias: 'Economy',  tier: 'small',  contextWindow: 200_000,   inputPerMtok: 0.25, outputPerMtok: 1.25, isFloor: true },
  { alias: 'Standard', tier: 'medium', contextWindow: 400_000,   inputPerMtok: 3,    outputPerMtok: 15,   isFloor: false },
  { alias: 'Deep',     tier: 'large',  contextWindow: 1_000_000, inputPerMtok: 15,   outputPerMtok: 75,   isFloor: false },
]
let current = 'Standard'
let sessionUsd = 0

const files = {
  '/': [
    { name: 'notes.md',   path: '/notes.md',   type: 'file',      size: 2481 },
    { name: 'data.csv',   path: '/data.csv',   type: 'file',      size: 91_204 },
    { name: 'report.pdf', path: '/report.pdf', type: 'file',      size: 442_119 },
    { name: 'src',        path: '/src',        type: 'directory', size: 0 },
  ],
  '/src': [
    { name: 'analyse.py', path: '/src/analyse.py', type: 'file', size: 3120 },
    { name: 'plot.py',    path: '/src/plot.py',    type: 'file', size: 1044 },
  ],
}

const mcp = {
  servers: [
    { id: 'filesystem', name: 'Filesystem', status: 'connected', toolCount: 6 },
    { id: 'linear',     name: 'Linear',     status: 'connected', toolCount: 14 },
  ],
  errors: [{ serverId: 'notion', message: 'handshake timed out after 10s' }],
  approved: [{ name: 'filesystem.read_file', serverId: 'filesystem' }],
  pending: [
    { name: 'create_issue', qualifiedName: 'linear.create_issue', serverId: 'linear',
      description: 'Create a new issue in a Linear team.', status: 'new' },
    { name: 'write_file', qualifiedName: 'filesystem.write_file', serverId: 'filesystem',
      description: 'Write bytes to a path. NOTE: description changed since you approved it.',
      status: 'changed' },
  ],
}

const pendingApprovals = new Map()

function authorized(req, res) {
  const h = req.headers.authorization || ''
  const presented = h.startsWith('Bearer ') ? h.slice(7) : new URL(req.url, 'http://x').searchParams.get('t')
  const a = Buffer.from(String(presented)), b = Buffer.from(token)
  if (a.length === b.length && timingSafeEqual(a, b)) return true
  res.writeHead(401).end('Unauthorized\n')
  return false
}

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** One scripted turn, shaped to exercise every branch of the transcript UI. */
async function streamTurn(req, res, message) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })
  const runId = 'run-' + Date.now()
  let open = true
  res.on('close', () => { open = false })
  const send = (event) => { if (open) res.write(`data: ${JSON.stringify({ runId, ts: Date.now(), ...event })}\n\n`) }

  const messageId = 'm-' + Date.now()
  send({ type: 'run.started', threadId: 'thread-1' })
  send({ type: 'status', state: 'thinking' })
  send({ type: 'message.started', messageId })

  for (const chunk of ['I looked at ', 'what you asked ', 'about — ', `"${message.slice(0, 60)}". `]) {
    await sleep(90); send({ type: 'message.delta', messageId, delta: chunk })
  }
  for (const chunk of ['The file is a CSV. ', 'I should read it before answering, ', 'rather than guessing at the columns.']) {
    await sleep(80); send({ type: 'reasoning.delta', messageId, delta: chunk })
  }

  // A tool that succeeds.
  await sleep(200)
  send({ type: 'status', state: 'calling_tool' })
  send({ type: 'tool.call.started', toolCallId: 'tc-1', name: 'read_file', args: { path: '/data.csv', maxBytes: 4096 } })
  await sleep(700)
  send({ type: 'tool.call.finished', toolCallId: 'tc-1', isError: false,
         result: { bytes: 4096, preview: 'region,quarter,revenue\nEMEA,Q1,184320\nAMER,Q1,271004\n…' } })

  // A tool that fails — the transcript must show this differently.
  send({ type: 'tool.call.started', toolCallId: 'tc-2', name: 'exec', args: { command: 'python3 src/analyse.py' } })
  await sleep(600)
  send({ type: 'tool.call.finished', toolCallId: 'tc-2', isError: true,
         result: { exitCode: 1, stderr: "ModuleNotFoundError: No module named 'pandas'" } })

  await sleep(150)
  send({ type: 'message.delta', messageId, delta: '\n\nThe analysis script needs `pandas`, which is not installed. ' })
  send({ type: 'message.delta', messageId, delta: 'I can write a version that uses only the standard library instead.' })

  // An approval that genuinely blocks the run until the user answers.
  const approvalId = 'ap-' + Date.now()
  send({ type: 'status', state: 'awaiting_approval' })
  send({ type: 'approval.requested', approvalId, toolCallId: 'tc-3', irreversible: true,
         reason: 'Overwrite src/analyse.py with a standard-library version.',
         payload: { path: '/src/analyse.py', bytes: 1806, overwrites: true } })

  const decision = await new Promise((resolve) => {
    pendingApprovals.set(approvalId, resolve)
    setTimeout(() => { if (pendingApprovals.delete(approvalId)) resolve('deny') }, 120_000)
  })

  if (decision === 'allow') {
    send({ type: 'status', state: 'calling_tool' })
    send({ type: 'tool.call.started', toolCallId: 'tc-3', name: 'write_file', args: { path: '/src/analyse.py' } })
    await sleep(500)
    send({ type: 'tool.call.finished', toolCallId: 'tc-3', isError: false, result: { path: '/src/analyse.py', bytes: 1806 } })
    send({ type: 'workspace.file.changed', path: '/src/analyse.py', op: 'modified' })
    send({ type: 'message.delta', messageId, delta: '\n\nRewritten and ready to run.' })
  } else {
    send({ type: 'message.delta', messageId, delta: '\n\nLeft the file alone.' })
  }

  // Compaction, so the transcript's system notice has something to render.
  await sleep(200)
  send({ type: 'context.compacted', strategy: 'tool-result-elision',
         beforeMessages: 48, afterMessages: 22, beforeTokens: 186_402, afterTokens: 41_388 })

  const runUsd = 0.0234
  sessionUsd += runUsd
  const buckets = (usd) => ({ uncachedInputTokens: 18_204, cacheWriteTokens: 2_048, cacheReadTokens: 96_112,
                              outputTokens: 1_902, reasoningTokens: 640, usd })
  send({ type: 'cost.updated', run: buckets(runUsd), session: buckets(sessionUsd) })

  send({ type: 'message.finished', messageId })
  send({ type: 'status', state: 'idle' })
  send({ type: 'run.finished', reason: 'complete' })
  if (open) { res.write('data: {"type":"__done"}\n\n'); res.end() }
}

const server = createServer(async (req, res) => {
  if (!authorized(req, res)) return
  const url = new URL(req.url, 'http://127.0.0.1')
  note(`${req.method} ${url.pathname}`)

  const body = async () => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
  }

  if (url.pathname === '/api/models') {
    const zero = { uncachedInputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0,
                   outputTokens: 0, reasoningTokens: 0, usd: 0 }
    return json(res, { current, models: MODELS,
      totals: { run: zero, session: { ...zero, usd: sessionUsd } },
      // Shape copied from BudgetGuard.remaining(), not invented. A mock that guesses
      // the server's shape only proves the client agrees with the guess.
      budget: { runUsd: 5, sessionUsd: 25 - sessionUsd } })
  }
  if (url.pathname === '/api/files') {
    return json(res, { path: url.searchParams.get('path') ?? '/', entries: files[url.searchParams.get('path') ?? '/'] ?? [] })
  }
  if (url.pathname === '/api/mcp' && req.method === 'GET') return json(res, mcp)
  if (url.pathname === '/api/mcp' && req.method === 'POST') {
    const { qualifiedName, all } = await body()
    const taken = all ? mcp.pending.splice(0) : mcp.pending.splice(mcp.pending.findIndex((t) => t.qualifiedName === qualifiedName), 1)
    taken.forEach((t) => mcp.approved.push({ name: t.qualifiedName, serverId: t.serverId }))
    return json(res, { ok: true, approved: taken.map((t) => t.qualifiedName) })
  }
  if (url.pathname === '/api/approve' && req.method === 'POST') {
    const { approvalId, decision } = await body()
    const resolve = pendingApprovals.get(approvalId)
    if (!resolve) return json(res, { ok: false, reason: 'No such pending approval' }, 404)
    pendingApprovals.delete(approvalId)
    resolve(decision)
    return json(res, { ok: true })
  }
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    const { message, modelAlias } = await body()
    if (modelAlias) current = modelAlias
    return streamTurn(req, res, message ?? '')
  }
  res.writeHead(404).end('Not found\n')
})

server.listen(Number(process.env.PORT ?? 0) || 0, '127.0.0.1', () => {
  const { port } = server.address()
  process.stdout.write(`${READY_MARKER} ${JSON.stringify({ port, token })}\n`)
  note(`mock workspace API on http://127.0.0.1:${port}`)
})

process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
