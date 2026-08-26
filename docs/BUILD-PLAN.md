# Build Plan

The *what and when*. For the *why* — parity target, competitive read, economics, compliance
posture — see [`strategy/PLAN-V2.md`](strategy/PLAN-V2.md). Section references (§n) point there.

## Context

This repo was empty. Plan v2 set the strategy; this turns it into a build.

One finding reshapes the sequencing. §9 assumed we write the agent core — loop, condenser,
subagents, MCP client, approvals — from scratch. Two Apache-2.0 TypeScript harnesses shipped
*after* that assumption was formed:

- **`@cline/sdk`** (May 2026) — `@cline/core` (sessions, tools, persistence, scheduling,
  plugins), `@cline/agents` (stateless loop, browser-compatible), `@cline/llms` (model gateway
  with provider clients and catalogs — overlapping §6.3), `@cline/shared`.
- **Mastra Harness** (June 2026) — agent modes (≈ planner/executor), forked subagents inheriting
  context, tool approvals with resumable suspensions, model switching on-thread, persistent
  threads across restarts, subscribable event stream.

Between them they cover most of §9 and part of §6.3. Writing that from scratch without testing
the alternatives risks spending the Phase 1 spine budget on undifferentiated work.

Two further facts make the choice cheap to reverse, and set the architecture:

- **Neither emits AG-UI.** Mastra emits its own (`message_update`, `tool_approval_required`,
  `tool_suspended`, `display_state_changed`). So the AG-UI layer is ours either way — which
  means it can be the contract each candidate is adapted *to*.
- **Neither documents context compaction.** So §9's condenser contract stays in-house — which is
  necessary anyway, because Governance Decay pinning requires owning context assembly.

**Outcome:** a private product monorepo whose core-framework decision is made by measurement in
two weeks, not by assumption, with the two seams we must own regardless (AG-UI, condenser)
defined first so the decision stays reversible.

## Decisions taken

| Decision | Choice |
|---|---|
| Repo purpose | Time-boxed harness bake-off → ADR + kept adapter |
| First milestones | **All four** — priced model-switch, execution-plane seam, web workspace embed, document gates |
| Licence posture | Private product monorepo (built on OSS, not published as such) |

"All four" is a sequence, not a sprint: ~13–15 weeks below. Two spikes parallelise from day one
because they don't depend on the harness decision.

## Architecture: adopt vs own

| Layer | Posture | Why |
|---|---|---|
| Agent loop, sessions, tool dispatch, persistence | **Adopt** (bake-off winner) | Commodity; two mature Apache-2.0 options |
| Condenser + policy pinning | **Own** | Governance Decay: invariants must sit outside compactable history |
| AG-UI event contract | **Own** | Neither harness emits it; it is the swap seam |
| Execution plane (`Local` / `Docker` / `Remote`) | **Own** (OpenHands shape) | §3's day-one seam; Mac vs cloud parity |
| Model gateway (virtual keys, budgets, meter) | **Own thin layer**, adopt provider adapters | Multi-tenancy and budgets are the product |
| MCP client | **Adopt** SDK v2 | Spec churn is severe; track upstream |
| Document engine | **Own, clean-room** | §10 licence trap is explicit |

## Repo layout

```
CLAUDE.md            auto-loaded by every agent session — invariants live here
docs/     strategy/PLAN-V2.md · BUILD-PLAN.md · adr/
apps/     workspace-web/ · admin-console/ · mac-shell/ (stub — see constraints)
packages/ core/ protocol/ workspace/ gateway-model/ gateway-connector/
          mcp/ documents/ skills/ tokens/
bakeoff/  candidate adapters · fixed task · scorer   (M0 only)
infra/    sandbox pool · egress proxy · KMS wiring
```

pnpm workspaces, Node 22+, ESM. `packages/protocol` depends on nothing else in the repo —
everything speaks to it.

**Reuse, don't rebuild:** `@ag-ui/core` typed events (16 kinds — don't invent a wire format) ·
`@modelcontextprotocol/client` v2, using
`client.connect(transport, { prior: { kind: 'modern', discover } })` so the stateless gateway
fleet skips the discovery probe · AI Elements + assistant-ui for shell components ·
Style Dictionary for DTCG tokens → CSS vars + SwiftUI constants.

## Step 0 — Bootstrap ✅ done

`CLAUDE.md`, `docs/strategy/PLAN-V2.md`, `docs/BUILD-PLAN.md`, `docs/adr/0001-harness.md`.
Plan v2 previously existed only as a chat message; an agent opening this repo found nothing.
Corrections from the verification pass are inline callouts in the strategy doc rather than
rewrites, so authorship is preserved and no agent acts on a stale claim.

`CLAUDE.md` is the load-bearing one: it is auto-loaded into every agent session, which is the
same trick §9 prescribes for the agent itself — invariants that decay over a long context get
re-injected every turn rather than stated once at the start.

## Milestones

### M0 — Harness bake-off (2 wks, hard stop)

Define `packages/protocol` (AG-UI contract) and `packages/workspace` (execution interface)
**first** — they are the harness-independent contracts each candidate is adapted to.

**Candidates:** `@cline/sdk` · Mastra Harness · from-scratch baseline on Vercel AI SDK (the
control and the floor).

**One fixed task, run identically against each:** a workspace holding a messy CSV and a 40-page
PDF; produce a 6-slide deck; one MCP tool lookup; one approval on an irreversible action; long
enough to force ≥2 compaction cycles; switch provider mid-run and finish. Exercises loop, tools,
MCP, approvals, compaction, model switch, file I/O and a read-only scout in one pass.

**Scoring** — first two are pass/fail gates:

| Dimension | Gate |
|---|---|
| Can we own context assembly (condenser + per-turn org-policy re-injection)? | **Hard** |
| Can we swap execution environment behind one interface? | **Hard** |
| MCP client on 2026-07-28, or cleanly replaceable with SDK v2 | Weighted |
| Reasoning-artifact handling on provider switch | Weighted |
| Approvals gated on irreversibility + taint propagation | Weighted |
| Subagents: read-only scouts, one writer | Weighted |
| Licence hygiene for private redistribution | Weighted |
| Same code headless (server) and in-process (Mac sidecar) | Weighted |
| Tokens/run and wall-clock on the fixed task | Measured |

**Output:** `docs/adr/0001-harness.md` completed; winning adapter promoted into `packages/core`;
losing adapters deleted, rationale kept. **If no clear winner at the time box, the from-scratch
baseline wins by default** — no extensions.

**Parallel from day one** (neither depends on the decision): the OfficeCLI-vs-LibreOffice spike
(§14 puts it at the head of Phase 0; on the hosted side it is also a COGS and cold-start
question — one .NET binary vs a ~700MB container image), and the iframe-embed spike.

### M1 — The spine → *priced model-switch demo* (3 wks)

Core on the chosen harness · **our** condenser (keep-first + keep-recent-verbatim +
summarise-middle, recorded as an explicit event; compaction-before-summarisation — replace old
tool outputs with path references first, lossless, then summarise) · invariant pinning outside
compactable history · AG-UI stream · `gateway-model` v1 (virtual keys per run, budget check,
four-bucket meter) · provider adapters stripping reasoning artifacts, switching **only at
compaction boundaries** where the cache miss is already sunk.

### M2 — Execution plane → *the seam* (2–3 wks)

`Local` and `Docker` implementations behind one interface plus lifecycle
(`suspend`/`resume`/`snapshot`), measured suspend/resume timings, default-deny egress, per-run
scoped virtual keys (§6.3 tier 1 — ~5% of the work of full interception for ~80% of the value).
Substrate choice for the remote implementation (Modal vs Cloudflare) is decided by this spike's
timings, not now.

### M3 — Web workspace + embed → *the integration* (3 wks)

Workspace shell on `workspace.<domain>` · JWT handoff by postMessage (never an IdP redirect
inside the iframe) · SSE streaming inside the iframe's origin · `frame-ancestors` and host
`frame-src` locked · agent-rendered artifacts in a deeper-sandboxed inner frame, RPC-only ·
`admin-console` v1: providers, key vault refs, model catalog with aliases/tiers/role gating,
always-available cheap floor, auto-block-new-models toggle.

### M4 — Document engine → *the gates* (3–4 wks)

Clean-room docx/pptx/xlsx from ECMA-376 + open libraries, and the three-gate loop: XSD validate
→ LibreOffice recalc → render-and-look in a fresh subagent. Seeded by the M0-parallel spike.

## Constraints and assumptions

- **Linux only here.** `apps/mac-shell` is a stub carrying the protocol contract; Seatbelt,
  TCC/PPPC, Keychain, FSEvents+`clonefile` and notarization (§8) need a Mac runner. The
  Mac-specific Phase 0 spikes are excluded from this schedule.
- Inference stays pass-through (§5). No path in `gateway-model` may bill tokens to us.
- Nothing from Anthropic's document skills enters `packages/documents` (§10 licence trap is
  verbatim and explicit).

## Verification

Each is a real check, runnable in CI:

- **Bake-off:** `pnpm bakeoff:run --candidate=<name>` executes the fixed task and writes a
  scorecard JSON; the three scorecards are the ADR's evidence.
- **Governance-decay regression** (the important one): golden transcript asserting org-policy
  invariants are still honoured after N compaction cycles. Must stay at 0% violations; a
  compaction-eviction attack case is a permanent test, not a one-off.
- **Workspace conformance:** one suite run unchanged against `Local` and `Docker`; asserts
  identical observable behaviour and a clean suspend→resume→continue round-trip.
- **Model switch:** asserts per-provider artifact stripping, and that a dropped Gemini thought
  signature **fails loudly** rather than silently degrading.
- **Meter reconciliation:** four-bucket estimate vs provider-reported `usage` within tolerance;
  ranges where no token-count endpoint exists.
- **Budget enforcement at the gateway, not the UI:** `curl` the gateway directly, bypassing the
  workspace, and assert the cap still holds.
- **Embed:** Playwright (Chromium pre-installed at `/opt/pw-browsers` — never run
  `playwright install`) drives host → iframe; asserts JWT handoff, SSE frames arriving, and zero
  CSP violations.
- **Documents:** each generated artifact passes all three gates or fails the build.

## Open questions

Carried from §16, plus those added by the second verification pass — see
[`strategy/PLAN-V2.md#16-still-open`](strategy/PLAN-V2.md).
