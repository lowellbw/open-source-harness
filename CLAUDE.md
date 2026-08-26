# The Agentic Workspace

A TypeScript agent core behind three shells — a native Mac app, a web workspace embedded in the
Apolitical platform, and an admin console — with a pluggable execution plane and centrally
administered model access.

## Read these first

| Document | What it is |
|---|---|
| `docs/strategy/PLAN-V2.md` | **Canonical strategy.** The *why*: parity target, competitive read, economics, compliance posture. Annotated where verification has since corrected a claim. |
| `docs/BUILD-PLAN.md` | **The build.** The *what and when*: milestones, repo layout, verification. |
| `docs/adr/` | Decision records. `0001-harness.md` settles the core-framework question. |

**Foundation (ADR-0001):** a thin harness we own, on the Vercel AI SDK v7 — not a full agent
framework. We own `packages/protocol` (event contract), `packages/workspace` (execution seam),
the condenser, policy pinning, approvals and the model gateway; we take a narrow slice of the
AI SDK (`streamText`/`generateText`, `prepareStep`, provider adapters).

Section references below (§n) point into `docs/strategy/PLAN-V2.md`.

## Invariants

These must hold in every session. They are restated here rather than left to the strategy doc
because they are the ones that quietly decay over a long context.

- **Inference is pass-through.** No code path in `gateway-model` may bill model tokens to us.
  The org's keys, the org's bill, our meter. (§5, §13)
- **No Anthropic document-skill derivatives** may enter `packages/documents`. That licence
  forbids derivative works, distribution and sublicensing verbatim. Reimplement clean-room from
  ECMA-376 and open libraries. (§10)
- **The MCP client is the official SDK v2** (`@modelcontextprotocol/client`). Do not hand-roll
  one — the 2026-07-28 spec is stateless with no `initialize` handshake, and tracking it by hand
  is a standing liability. Keep legacy fallback on: most deployed servers predate the revision,
  and the SDK itself defaults to the 2025-era protocol. (§11 and its update callout)
- **Policy pinning goes in `prepareStep`, re-injected every step.** Never rely on a constraint
  staying in conversation history — compaction demonstrably evicts it (recall 53% after one
  round, 10% by five). And pinning is a mitigation, not a fix: spend limits, tool scope and data
  boundaries are enforced in the gateway, where the model cannot argue with them.
- **`exec` and the file API disagree about `/` on purpose.** The file API rewrites a leading `/`
  to the workspace root so model-authored paths stay contained; a shell has a real filesystem
  and its own `/`. Containment for `exec` comes from `capabilities.isolated`, never from path
  rewriting — which is why `LocalWorkspace` must not back untrusted work.
- **Budgets, quotas and model gating are enforced at the gateway, never only in the UI.**
  Assume the UI is bypassed. (§4)
- **Never share a sandbox across orgs.** Per-org pools, ephemeral per-user within an org,
  default-deny egress. (§4)
- **Never blanket-allow a model vendor's API surface** in an egress allowlist. That is the
  documented exfiltration path. (§6.3, §9)
- **Org policy, permissions and scope re-inject every turn** — pinned outside compactable
  history, never stated only at session start. Compaction otherwise decays constraint
  adherence to measurable violation rates. (§9)
- **`apps/mac-shell` cannot be built or tested on Linux.** Seatbelt, TCC/PPPC, Keychain,
  FSEvents+`clonefile` and notarization need a Mac runner. Do not attempt them in CI here.

## Conventions

- pnpm workspaces, Node 22+, ESM.
- `packages/protocol` depends on nothing else in the repo. Everything speaks to it.
- Playwright uses the pre-installed Chromium at `/opt/pw-browsers`. Never run `playwright install`.
