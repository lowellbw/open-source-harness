# ADR-0001 — Agent core: adopt a harness, or build one

- **Status:** Proposed — decision pending M0
- **Date opened:** 26 Aug 2026
- **Decides:** what `packages/core` is built on
- **Time box:** 2 weeks, hard stop

## Context

Plan v2 §9 assumed we write the agent core from scratch. Two Apache-2.0 TypeScript harnesses
shipped after that assumption was formed — `@cline/sdk` (May 2026) and Mastra Harness (June 2026)
— and between them they cover most of §9 plus part of §6.3's gateway. Building from scratch
without testing them risks spending the Phase 1 spine budget on undifferentiated work.

Two facts make the decision cheap to reverse and set the method:

- **Neither emits AG-UI.** Mastra emits its own event format (`message_update`,
  `tool_approval_required`, `tool_suspended`, `display_state_changed`).
- **Neither documents context compaction.**

So `packages/protocol` (AG-UI) and the condenser are ours regardless. They are therefore defined
*first*, and each candidate is adapted to them. That makes the comparison apples-to-apples and
keeps the losing adapters cheap to discard.

## Candidates

| Candidate | Licence | Notes |
|---|---|---|
| `@cline/sdk` | Apache-2.0 | `@cline/core` (sessions, tools, persistence, scheduling, plugins), `@cline/agents` (stateless loop, browser-compatible), `@cline/llms` (provider clients + catalogs), `@cline/shared`. Node 22+. Headless-capable. |
| Mastra Harness | Apache-2.0, `ee/` under Mastra Enterprise Licence | Agent modes, forked subagents, tool approvals with resumable suspensions, on-thread model switching, persistent threads, subscribable events. |
| From-scratch on Vercel AI SDK | n/a | The control and the floor. Wins by default if neither candidate clears the gates. |

Not a candidate: **OpenHands SDK** is Python. Its `Workspace()` factory shape is the interface
`packages/workspace` copies, but the code is not reusable in a TypeScript core.

## Method

One fixed task, run identically against each candidate: a workspace holding a messy CSV and a
40-page PDF; produce a 6-slide deck; one MCP tool lookup; one approval on an irreversible action;
long enough to force ≥2 compaction cycles; switch provider mid-run and finish.

That single task exercises the loop, tool dispatch, MCP, approvals, compaction, model switching,
file I/O and a read-only scout in one pass.

## Scoring

The first two are pass/fail. A candidate failing either is out regardless of its other scores.

| Dimension | Gate | Why it matters |
|---|---|---|
| Can we own context assembly — condenser plus per-turn org-policy re-injection? | **Hard** | Governance Decay: invariants must sit outside compactable history, or constraint adherence measurably decays |
| Can we swap the execution environment behind one interface? | **Hard** | §3's day-one seam; Mac local vs cloud sandbox parity |
| MCP client on 2026-07-28, or cleanly replaceable with SDK v2 | Weighted | The spec is stateless with no `initialize` handshake; a harness pinned to the old one is a standing liability |
| Reasoning-artifact handling on provider switch | Weighted | Gemini thought signatures hard-fail if dropped |
| Approvals gated on irreversibility, with taint propagation | Weighted | §9 prompt-injection defence is architectural |
| Subagents: read-only scouts, one writer | Weighted | Read-heavy parallelises; write-heavy must stay single-threaded |
| Licence hygiene for private redistribution | Weighted | Open-core boundaries (Mastra `ee/`, LiteLLM `enterprise/`) |
| Same code headless and in-process (Mac sidecar) | Weighted | One core, three shells |
| Tokens/run and wall-clock on the fixed task | Measured | COGS |

## Decision

*Pending. Completed at the end of M0.*

## Consequences

*Pending.*

## Notes

If no candidate clears both gates with a clear margin at the two-week mark, the from-scratch
baseline wins by default. No extensions — the time box exists to prevent the comparison
becoming the project.
