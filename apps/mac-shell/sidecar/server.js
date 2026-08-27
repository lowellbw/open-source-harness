#!/usr/bin/env node
//
// The sidecar the Mac shell launches.
//
// This is an **adapter**, not an implementation. The serving is
// `apps/sidecar/server.mjs`, which is the maintained one and runs the same
// Next app the web shell does — one API surface, one set of behaviours, per
// CLAUDE.md's rule that session behaviour lives in `packages/session` and never
// in a shell. There were briefly two independent implementations of the same
// `AGENTIC_SIDECAR_READY` contract, written about twenty minutes apart; this
// file exists so there is one again.
//
// What is left here is the part that genuinely belongs to the Mac shell: the
// environment contract between `SidecarLaunch.swift` and the backend. The shell
// speaks in deliberately provider-neutral, platform-appropriate names; the
// backend reads different ones; and nothing upstream bridges them. Both gaps are
// silent and total if left alone — one answers HTTP 500 on every route, the
// other writes the user's conversations to the wrong place.

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const note = (...args) => console.error('[sidecar]', ...args)

// --- credential -------------------------------------------------------------
//
// `SidecarLaunch.swift` exports AGENTIC_PROVIDER_API_KEY on purpose: the shell
// has no business knowing which provider is behind the gateway, and a managed
// deployment has no local key at all — the org's key lives in the gateway, which
// is also where budgets and model gating are enforced.
//
// `ModelGateway` reads OPENROUTER_API_KEY. Without this line every /api route
// answers 500 "No model provider key", which reads as a broken shell rather than
// as a naming mismatch.
if (process.env.AGENTIC_PROVIDER_API_KEY && !process.env.OPENROUTER_API_KEY) {
  process.env.OPENROUTER_API_KEY = process.env.AGENTIC_PROVIDER_API_KEY
  note('mapped AGENTIC_PROVIDER_API_KEY to OPENROUTER_API_KEY')
}

// --- data directory ---------------------------------------------------------
//
// The shell passes AGENTIC_DATA_DIR — its Application Support directory, which
// is where a Mac app is actually permitted to write and what an uninstall
// removes. Upstream's server.mjs only *logs* that variable; the backend reads
// AGENTIC_WORKSPACE_HOME and otherwise defaults to ~/.agentic-workspace.
//
// Left unbridged, conversations, the SQLite database and every workspace land
// outside the app's container, and survive its uninstall.
if (process.env.AGENTIC_DATA_DIR && !process.env.AGENTIC_WORKSPACE_HOME) {
  process.env.AGENTIC_WORKSPACE_HOME = process.env.AGENTIC_DATA_DIR
  note(`workspace home: ${process.env.AGENTIC_WORKSPACE_HOME}`)
}

// --- locating the upstream sidecar -----------------------------------------
//
// Two layouts. A development run points AGENTIC_SIDECAR_PATH at this file inside
// the repo, where the real sidecar is a sibling at `apps/sidecar`. A packaged
// build has both copied next to each other under Contents/Resources/sidecar.
function resolveUpstream() {
  const candidates = []
  if (process.env.AGENTIC_UPSTREAM_SIDECAR) candidates.push(process.env.AGENTIC_UPSTREAM_SIDECAR)
  candidates.push(path.join(HERE, 'upstream', 'server.mjs'))

  let dir = HERE
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, 'apps', 'sidecar', 'server.mjs'))
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  note('could not find the upstream sidecar. Looked in:')
  for (const candidate of candidates) note('   ', candidate)
  process.exit(78) // EX_CONFIG
}

const upstream = resolveUpstream()

// --- preflight --------------------------------------------------------------
//
// Upstream runs Next with `dev: false` and has no build precheck, so a missing
// production build dies inside `prepare()` with a stack trace on stderr and no
// hint. The shell shows that as "Sidecar keeps exiting", which is true and
// useless. Say the actual remedy instead.
const webDir = process.env.AGENTIC_WEB_DIR
  ?? path.resolve(path.dirname(upstream), '..', 'web')

if (!fs.existsSync(path.join(webDir, '.next', 'BUILD_ID'))) {
  note(`no production build at ${path.join(webDir, '.next')}`)
  note('Run: pnpm --filter @workspace/web build')
  process.exit(78)
}

// `next` resolves from the upstream sidecar's own node_modules, which is where
// its dependency is declared. `apps/mac-shell` has none of its own.
createRequire(path.join(path.dirname(upstream), 'package.json'))

note(`serving via ${upstream}`)
await import(upstream)
