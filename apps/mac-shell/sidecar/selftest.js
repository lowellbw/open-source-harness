#!/usr/bin/env node
//
// A stub sidecar for the two failures in NOTES.md that do not produce an error.
//
// Both need the real shell, a real WKWebView and a real load, so neither can be
// covered by a unit test; and both are invisible if you only look at the app — a
// broken delegate signature just means the method is never called. This stub makes
// each one produce an observable signal instead:
//
//   AGENTIC_SELFTEST=links     (default) serves a page whose links go off-origin,
//                              and logs, on stderr, every request it receives. It
//                              also clicks one of them for you, so the test needs no
//                              mouse.  -> NOTES §2, WKNavigationDelegate signatures
//
//   AGENTIC_SELFTEST=deadport  announces a port that nothing is listening on, so the
//                              first load fails for real. The retry overlay must
//                              appear.  -> NOTES §6, the Binding captured in
//                              makeCoordinator
//
// Run it the way the shell runs any sidecar:
//
//   AGENTIC_SELFTEST=links AGENTIC_SIDECAR_PATH=$PWD/sidecar/selftest.js \
//     "build/Agentic Workspace.app/Contents/MacOS/MacShell"

import { createServer } from 'node:http'
import net from 'node:net'

const READY_MARKER = 'AGENTIC_SIDECAR_READY'
const mode = process.env.AGENTIC_SELFTEST || 'links'
const note = (...args) => console.error('[selftest]', ...args)

process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

// --- NOTES §6: a port that is announced and then abandoned -------------------
//
// Bind, read the port back, close. The shell gets a well-formed ready line for a
// listener that is already gone, so the first load fails with a real
// NSURLErrorCannotConnectToHost rather than a simulated one. That exercises the
// whole path: three transient retries, then a write to the Binding the Coordinator
// captured at creation. If the retry overlay does not appear, that Binding is the
// reason — the note says where the fix goes.
if (mode === 'deadport') {
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => {
      // Bare decimal rather than JSON, which also exercises the fallback branch of
      // SidecarController.parseReadyLine.
      process.stdout.write(`${READY_MARKER} ${port}\n`)
      note(`announced port ${port}; nothing is listening on it. Expect the retry overlay.`)
    })
  })
} else {
  // --- NOTES §2: off-origin containment ---------------------------------------
  const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>Shell self-test</title>
<style>
  body { font: 15px/1.6 -apple-system, system-ui; margin: 3rem auto; max-width: 46rem; }
  a { display: block; margin: .4rem 0; }
  #log { font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; }
</style></head><body>
<h1>Shell self-test</h1>
<p>If you can read this, the shell loaded the workspace over loopback.</p>

<a id="ext" href="https://example.com">external link (should open in your browser)</a>
<a id="blank" href="https://example.com" target="_blank">target=_blank (WKUIDelegate path)</a>
<a id="same" href="/same-origin">same-origin link (should navigate here)</a>

<div id="log"></div>
<script>
  const log = (m) => {
    document.getElementById('log').textContent += m + '\\n'
    navigator.sendBeacon('/beacon?m=' + encodeURIComponent(m))
  }
  log('loaded at ' + location.href)

  // A synthetic activation. WebKit reports this to decidePolicyFor as
  // .linkActivated, the same as a mouse click, so the whole delegate path is
  // exercised without needing a mouse or accessibility permission.
  setTimeout(() => { log('clicking the external link'); document.getElementById('ext').click() }, 1200)

  // The decisive signal. If decidePolicyFor did not fire, WKWebView followed the
  // link, this document is gone, and this beacon never arrives.
  setTimeout(() => log('STILL-HERE after the click: ' + location.href), 3200)

  // target=_blank. decidePolicyFor sees it first with a nil targetFrame; if it
  // cancels there, WKUIDelegate's createWebViewWith never runs. Either route must
  // open the browser exactly once, so a second tab here means both fired.
  setTimeout(() => { log('clicking the target=_blank link'); document.getElementById('blank').click() }, 4800)
  setTimeout(() => log('STILL-HERE after target=_blank: ' + location.href), 6800)
</script>
</body></html>`

  const server = createServer((req, res) => {
    note(`${req.method} ${req.url}`)
    if (req.url.startsWith('/beacon')) {
      // sendBeacon POSTs; drain the body so the socket does not stall.
      req.resume()
      res.writeHead(204).end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(page)
  })

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    process.stdout.write(`${READY_MARKER} ${JSON.stringify({ port })}\n`)
    note(`serving the self-test page on http://127.0.0.1:${port}`)
  })
}
