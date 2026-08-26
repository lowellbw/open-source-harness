# The Agentic Workspace

An agent workspace with your files, your tools, and your choice of model.

Strategy lives in [`docs/strategy/PLAN-V2.md`](docs/strategy/PLAN-V2.md); the build in
[`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md); the core-framework decision in
[`docs/adr/0001-harness.md`](docs/adr/0001-harness.md).

## Run it

Needs Node 22+, pnpm, and a model provider key.

```bash
pnpm install
export OPENROUTER_API_KEY=sk-or-...   # the only credential required
pnpm dev                              # http://localhost:3000
```

Docker is optional. Without it everything still works — you lose only the container-backed
workspace, and its conformance tests skip rather than fail.

## What works today

- **Chat with streaming**, tool calls shown inline, reasoning collapsible.
- **A real workspace** — upload, read, write, download, and shell commands, all confined to
  the workspace root.
- **Model choice** across Anthropic, OpenAI and Google, picked by alias rather than provider
  model ID, with per-role gating and a cheap always-available floor.
- **A live cost meter**, four buckets, priced per model, with a hard spend ceiling enforced in
  the gateway rather than the UI.
- **Approvals before anything irreversible.** Overwriting a file or running a command stops and
  asks; creating a new file does not, because prompting on everything trains people to click
  through without reading.
- **Context compaction** that elides losslessly before it summarises, and re-injects org policy
  on every single request so constraints survive compaction.
- **MCP connectors** with deferred tool loading, so a dozen connected servers do not put tens of
  thousands of tokens of schema in front of the model before it has done anything. Tools are not
  callable until you have read what they claim to do, and a tool whose description changes after
  approval is quarantined until you read it again.

Copy `apps/web/mcp.config.example.json` to `apps/web/mcp.config.json` to connect servers.

## Tests

```bash
pnpm test          # 188 tests; Docker conformance skips if the daemon is absent
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
```

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
| `packages/mcp` | MCP client, tool-description pinning, deferred loading. |
| `apps/web` | The workspace you open. |
| `apps/sidecar` | Node process the Mac shell launches. Serves the same app; token-gated loopback. |
| `apps/mac-shell` | Swift shell — **source only, never compiled.** See its README. |

## Known limits

- `apps/mac-shell` has never been built or run. It was written on Linux, where SwiftUI, AppKit,
  WebKit and Security.framework do not exist. Treat it as a starting point, not a working app.
- Sessions live in server memory and workspaces in a temp directory, which suits the local
  single-user case this currently is. The hosted multi-tenant path needs per-org sandbox pools
  instead — never a shared process.
- MCP tool approvals persist to a file beside the workspace, but sessions themselves do not
  survive a restart.
