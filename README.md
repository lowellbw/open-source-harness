# The Agentic Workspace

An agent workspace with your files, your tools, and your choice of model.

Strategy lives in [`docs/strategy/PLAN-V2.md`](docs/strategy/PLAN-V2.md); the build in
[`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md); the core-framework decision in
[`docs/adr/0001-harness.md`](docs/adr/0001-harness.md).

## Run it

Needs Node 22+, pnpm, and a model provider key.

```bash
pnpm install
cp .env.example .env.local            # then fill in OPENROUTER_API_KEY
pnpm dev                              # http://localhost:3000
```

`OPENROUTER_API_KEY` is the only credential required. `BRAVE_API_KEY` is optional — see
**Web search** below.

Docker is optional. Without it everything still works — you lose only the container-backed
workspace, and its conformance tests skip rather than fail.

Documents need LibreOffice with its filters, and multi-page previews need poppler:

```bash
apt-get install -y libreoffice-writer libreoffice-impress libreoffice-calc poppler-utils
```

Beware a half-installed LibreOffice: `libreoffice-core` alone gives you an `soffice` that runs,
exits 0, and converts nothing. The document gates skip loudly rather than passing quietly when it
is absent.

## What works today

- **Chat with streaming**, tool calls shown inline, reasoning collapsible.
- **A real toolset** — list, read, write, *surgical edit*, grep, glob, shell commands and web
  fetch, all confined to the workspace root. Edits snapshot the original first, so they are
  undoable and therefore do not interrupt you to ask.
- **Model choice** across Anthropic, OpenAI and Google, picked by alias rather than provider
  model ID, with per-role gating and a cheap always-available floor.
- **A live cost meter**, four buckets, priced per model, with a hard spend ceiling enforced in
  the gateway rather than the UI.
- **Approvals before anything irreversible**, with a third answer beside once and never:
  *allow this class of action for this session*. Arbitrary code cannot be judged reversible in
  advance so it must be gated, but a prompt on every cell of an analysis manufactures consent
  rather than obtaining it. The grant lasts one session and is never written to disk.
- **Context compaction** that elides losslessly before it summarises, and re-injects org policy
  on every single request so constraints survive compaction.
- **Web search**, either way round. With `BRAVE_API_KEY` it is an explicit tool call: visible
  query, inspectable results, its own line in the trace. Without one, the gateway attaches
  OpenRouter's server-side search to the request instead — no second credential, no extra
  sub-processor. Either way the pages the model cited render as links under the answer, because a
  searched answer that shows no sources is indistinguishable from an asserted one.
- **Read-only research subagents.** Send several out at once to chase independent questions; each
  gets its own context and its own spend ceiling, and returns a short report written to a file
  rather than pasted back. They cannot write, run commands, use connectors, or spawn more of
  themselves — enforced by a workspace wrapper that refuses, not by asking the model nicely.
- **Documents that are checked, not just produced.** Word, PowerPoint and Excel from a small
  specification, then three gates before the tool returns: the package structure, whether an
  office suite can open and re-save it, and whether a *fresh* subagent looking at the rendered
  pages thinks it matches the request. That last one is the one everyone skips, and the only one
  that catches a deck which is valid, recalculates, and has its third bullet running off the
  bottom of the slide. Markdown takes the short path — it renders in the panel and needs no
  conversion to be useful.
- **An artifact panel** beside the conversation, showing whatever the agent last made: rendered
  Markdown, images, agent-written pages in a sandboxed frame, and page images for Office files.
- **Images in and out.** Generated through the same gateway as everything else, so image spend is
  metered like any other; attached images and PDFs go to the model as real image and file parts.
- **Python for data analysis.** pandas, numpy, matplotlib and openpyxl in the workspace. Charts
  it saves appear in the artifact panel automatically. Each call is a fresh process — state
  lives in files, which are inspectable and survive a restart, rather than in a kernel whose
  contents go stale against the files underneath it.
- **Browser control**, off by default. Opens a real Chromium, reads pages that need JavaScript
  or a login, clicks and types, and returns a screenshot. Opt-in rather than opt-out because it
  is the widest capability here — a deployment should decide to have it, not discover it.
- **Skills.** Drop a `SKILL.md` into the skills directory and its one-line description joins
  every request; the instructions themselves load only when the model opens it. Twenty skills
  cost a few hundred tokens a turn instead of tens of thousands. Curated local directory only —
  a skill is instructions that get followed, so where it came from is the whole of its trust
  story.
- **MCP connectors** with deferred tool loading, so a dozen connected servers do not put tens of
  thousands of tokens of schema in front of the model before it has done anything. Tools are not
  callable until you have read what they claim to do, and a tool whose description changes after
  approval is quarantined until you read it again.

Copy `apps/web/mcp.config.example.json` to `apps/web/mcp.config.json` to connect servers.

## Tests

```bash
pnpm test          # 339 tests; Docker conformance skips if the daemon is absent
pnpm -r typecheck
```

Performance measurements are opt-in and print rather than assert:

```bash
RUN_BENCH=1 pnpm vitest run packages/store/src/bench.test.ts
```

They exist to answer "does our own code matter", not to be minimised. A model
call is roughly a second; condensing 5,000 messages takes single-digit
milliseconds. Optimising a path that is one percent of the budget is how you
spend a week making nothing faster.

The live provider tests are opt-in, since they cost money and need network:

```bash
RUN_LIVE=1 pnpm vitest run packages/core/src/live.test.ts
RUN_LIVE=1 pnpm vitest run packages/session/src/live-search.test.ts
RUN_LIVE=1 pnpm vitest run packages/session/src/live-subagents.test.ts
RUN_LIVE=1 pnpm vitest run packages/session/src/live-steps.test.ts
RUN_LIVE=1 pnpm vitest run packages/session/src/live-documents.test.ts
```

The document one is the interesting one: it builds a deliberately unreadable deck — forty
bullets on one slide — and asserts that a real reviewer model fails it while the structural
checks pass. If that test ever goes green on all three gates, the third gate has stopped
checking anything.

A full live pass costs well under a cent — it runs on the cheapest tier under the budget guard.

## Layout

| Path | What it is |
|---|---|
| `packages/protocol` | Event contract between core and shells. Depends on nothing else. |
| `packages/workspace` | Execution seam: local and Docker behind one interface. |
| `packages/gateway-model` | Model catalog, cost meter, budget ceiling, reasoning-artifact rules. |
| `packages/core` | Agent loop, condenser, policy pinning. |
| `packages/session` | Session lifecycle, agent toolset, approval gate, connector bring-up. Shared by every shell. |
| `packages/store` | SQLite persistence: threads, messages, cost ledger. |
| `packages/subagents` | Read-only scouts: the workspace wrapper, their toolset, the spawn tool. |
| `packages/documents` | docx/pptx/xlsx builders, LibreOffice rendering, the three verification gates. |
| `packages/skills` | SKILL.md parsing, the curated registry, progressive disclosure. |
| `packages/mcp` | MCP client, tool-description pinning, deferred loading. |
| `apps/web` | The workspace you open. |
| `apps/sidecar` | Node process the Mac shell launches. Serves the same app; token-gated loopback, and the seam that translates the shell's environment contract. |
| `apps/mac-shell` | Swift shell — **source only, never compiled.** See its README. |

## Known limits

- The sidecar needs **Node 22.3 or newer** — `node:sqlite`, which conversation history depends
  on, landed there. It refuses to start on anything older rather than serving a UI that 500s on
  the first thread. Worth knowing on a Mac, where `/usr/local/bin/node` is often Homebrew's and
  may be well behind.
- On macOS LibreOffice is inside its app bundle and **not on PATH**. It is looked for there and
  in the Homebrew prefixes; `LIBREOFFICE_PATH` overrides.
- `apps/mac-shell` has never been built or run. It was written on Linux, where SwiftUI, AppKit,
  WebKit and Security.framework do not exist. Treat it as a starting point, not a working app.
- Sessions live in server memory and workspaces in a temp directory, which suits the local
  single-user case this currently is. The hosted multi-tenant path needs per-org sandbox pools
  instead — never a shared process.
- MCP tool approvals persist to a file beside the workspace.
- Docker conformance skips silently when the daemon is not running, and the daemon in a container
  dies periodically. `pgrep dockerd` before trusting a green run — the skip count is the tell.
