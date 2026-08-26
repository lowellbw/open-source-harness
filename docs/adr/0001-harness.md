# ADR-0001 — Agent core foundation

- **Status:** Accepted
- **Date:** 26 Aug 2026
- **Decides:** what `packages/core` is built on
- **Supersedes:** the bake-off framing of this ADR. A three-candidate bake-off was scoped and then dropped in favour of a research pass weighted to the last six months, on the grounds that two weeks of measurement was not worth deferring a usable product for when the documented evidence is this specific.

## Decision

**Build a thin harness on the Vercel AI SDK (`ai`, Apache-2.0, v7.0.79). Do not adopt a full agent framework.**

We own the parts that carry our product requirements — the event protocol, the execution seam, the condenser, policy pinning, approvals, the model gateway — and take a deliberately narrow slice of the AI SDK: `streamText`/`generateText`, `prepareStep`, and its provider adapters.

Mastra is the runner-up and a live fallback. LangGraph.js is the reference implementation for the one thing we are choosing to build ourselves that it does better (durable approvals).

## Requirements

Two were hard gates; a candidate failing either was out regardless of its other qualities.

- **R1 — own context assembly.** We must supply our own compaction and guarantee a pinned policy block reaches *every* model request, never evicted by summarisation.
- **R2 — pluggable execution.** Same agent code against local shell, Docker, and later a remote sandbox behind one interface.

Then, weighted: R3 MCP 2026-07-28, R4 model switching and reasoning artifacts, R5 tool approvals, R6 constrainable subagents, R7 licence fitness for closed-source redistribution, R8 headless *and* embeddable, R9 maturity.

## Why R1 is a gate

Compaction silently destroys policy constraints. Two independent 2026 results agree:

- Zerhoudi, Mitrović & Granitzer (University of Passau), *"The Compaction Cliff in Long-Running AI Agent Memory"*, [arXiv:2608.22752](https://arxiv.org/abs/2608.22752), **accepted at CIKM '26** — safety-rule recall holds at 53% after one compaction round and falls to 10% by round five. Type-aware pinning of constraint-class content restores 1.00/0.95/0.80 recall at 50/25/10% compression.
- Chen, *"Governance Decay"*, [arXiv:2606.22528](https://arxiv.org/abs/2606.22528) — violations rise 0% → 30% after compaction, up to 59%; constraint pinning restores 0%.

`PLAN-V2.md` §9 cites only the second. It is the weaker of the two: single author, no confirmed affiliation, not peer-reviewed. **Prefer the Passau paper when citing this externally.** The qualitative finding is corroborated; the exact percentages differ between them and should not be blended.

Worth carrying: TrueFoundry's engineering read is that pinning is a mitigation, not a fix — genuinely load-bearing rules (spend limits, tool scope, data boundaries) belong in infrastructure that the model cannot talk its way past. That matches §4's "enforce at the gateway, not the UI", and is why the budget ceiling is gateway-side rather than a prompt instruction.

## Verdicts

| | Vercel AI SDK v7 | Mastra 1.62 | `@cline/sdk` 0.0.81 | LangGraph.js |
|---|---|---|---|---|
| **R1 own context** | **Pass** — `prepareStep` | **Pass** — Processor pipeline | Partial — hooks, guarantee unverified | **Pass** — `wrapModelCall` |
| **R2 pluggable exec** | Partial — `experimental_sandbox` | **Pass** — many providers | Partial | Partial — via `deepagents` |
| R3 MCP 2026-07-28 | Pass, with legacy fallback | Pass — wraps official SDK v2 | Unverified | Unverified |
| R4 switching + artifacts | Pass | Pass into Anthropic; asymmetric elsewhere | Pass | Pass |
| R5 approvals | Partial — not durable on `ToolLoopAgent` | Pass — durable, resumable | Pass | **Best** — checkpointed |
| R6 constrained subagents | Pattern, not primitive | Pass in isolated mode | Partial | Pass |
| R7 licence | **Apache-2.0, no carve-out** | Apache-2.0 core, `ee/` carve-out | Apache-2.0 | MIT core, **Elastic 2.0 server** |
| R8 deployment | Pass | Pass | Pass | Pass |
| R9 maturity | Pass, with version churn | **Partial — see below** | **Partial — pre-1.0** | **Best** |

I verified R1 for the AI SDK directly against the installed type definitions rather than taking documentation on trust. `PrepareStepFunction` receives "the messages that will be sent to the model for the current step" and states: *"If you return a `messages` override, those messages carry forward to later steps."* That is exactly the guarantee R1 asks for — our code runs before every step, so compaction holds no privileged position over pinning. It also exposes `model` per-step, making mid-session switching native.

## Why not Mastra

Mastra scored better than expected and held up under source-level inspection. Three things decided against it:

1. **We had already solved R2 ourselves.** Mastra's strongest advantage is its `WorkspaceSandbox` interface with a dozen providers. But `packages/workspace` already exists, is ours, and passes a 70-test conformance suite against both Local and Docker. R2 stopped being a differentiator during the same session the research ran.
2. **The licence boundary is in motion, and we redistribute.** The `ee/` licence was reissued **24 Aug 2026 — two days before this decision** — forbidding copy, distribution, sublicensing and sale of covered code, and a type-level import already crosses from `core/src/mcp/types.ts` into `auth/ee`. Today the boundary is scoped to RBAC and Studio UI, clear of everything we need. But the Mac app ships the core as a bundled sidecar: that is distribution, which is precisely what the term targets. Betting a redistributed commercial product on a boundary that moved this week is a poor trade when the alternative is Apache-2.0 with no carve-out.
3. **The primitives we would depend on are self-declared beta.** Mastra's own docs warn that AgentController and Workspace may take "breaking changes without a major version bump" — and the changelog bears it out: 62 minor releases in 31 weeks, 139 "breaking" entries in ~7 months, including a wholesale Harness→AgentController rename in the last two. Adopting a framework means adopting its memory, threads, storage and controller too; that is a lot of surface to be broken by, on the two primitives that matter most to us.

None of this is a quality judgement — it is well-engineered and well-funded ($35M+, ~27.5k stars, dogfooded). It is a fit judgement about redistribution and churn tolerance.

## What we accept by choosing this

Honest costs, not hidden ones:

- **Durable approvals are ours to build.** The AI SDK's `ToolLoopAgent` does not carry restart-resumable approval state. LangGraph's checkpointer pattern is the benchmark to copy: persist the suspension, resume from storage.
- **Subagent orchestration is a convention, not a primitive.** "Pass a restricted tool array" works but we are inventing the pattern rather than adopting a tested one.
- **Reasoning-artifact rules are ours.** Mastra's `ProviderHistoryCompat` is Apache-2.0 and worth reading as a reference for the rules it encodes — strip foreign reasoning when the destination is Anthropic, keep the trailing assistant message byte-identical. Read for patterns, reimplemented, not copied.
- **AI SDK version churn is real.** v5 → v6 → v7 inside a year. Mitigated by taking a narrow slice and pinning deliberately.
- **`experimental_sandbox` is experimental.** Irrelevant to us: we use our own seam and can adapt to theirs later if it stabilises.

## Consequences

- `packages/core` wraps `streamText`/`generateText`; the condenser and policy pinning live in a `prepareStep` implementation that is ours.
- `packages/workspace` stays independent of any framework's sandbox abstraction — already true.
- MCP goes through the official `@modelcontextprotocol/client` v2 directly. **Note:** the SDK speaks the 2025-era protocol unless 2026-07-28 is explicitly opted into, and most deployed servers predate the new revision, so legacy fallback is the correct default rather than a compromise.
- Deferred tool loading is ours to implement. `PLAN-V2.md` §11 reads as though MCP provides it; it does not — it is an application-layer pattern over `tools/list`. The spec's new `ttlMs`/`cacheScope` are a different mechanism and should not be conflated with it.
- Revisit if: Mastra stabilises AgentController and Workspace out of beta and clarifies `ee/` for redistribution; or if durable approvals prove harder to build than budgeted, at which point LangGraph's checkpointer becomes the argument for reconsidering.

## Method note

This decision rests on documentation, source inspection and type definitions — not on running all three candidates against a fixed task. That was the deliberate trade: the bake-off was dropped to reach a usable product sooner. The two hard gates are the residual risk, and R1 is directly verified. R2 is moot because we own it.
