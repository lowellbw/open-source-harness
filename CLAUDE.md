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
- **A subagent's read-only-ness is a property of its workspace, not of its prompt.** `readOnly()`
  in `packages/subagents` refuses `write`, `mkdir`, `remove` AND `exec` — a shell is a write
  primitive, so a scout that can run commands is not read-only. This is why scouts search by
  walking the tree in JS rather than reusing the grep-backed tools in `packages/session`. Scouts
  also get their own gateway (own spend ceiling), no MCP, and no spawn tool, so depth is bounded
  at one.
- **Session behaviour lives in `packages/session`, never in a shell.** The toolset, the
  approval gate and connector bring-up are shared code: the Mac sidecar and the web app run
  the same implementation. Putting product behaviour in `apps/*` makes §3's "one core, three
  shells" untrue and guarantees the shells drift.
- **Budgets, quotas and model gating are enforced at the gateway, never only in the UI.**
  Assume the UI is bypassed. (§4)
- **Never share a sandbox across orgs.** Per-org pools, ephemeral per-user within an org,
  default-deny egress. (§4)
- **Never blanket-allow a model vendor's API surface** in an egress allowlist. That is the
  documented exfiltration path. (§6.3, §9)
- **Org policy, permissions and scope re-inject every turn** — pinned outside compactable
  history, never stated only at session start. Compaction otherwise decays constraint
  adherence to measurable violation rates. (§9)
- **The document gates need LibreOffice's FILTERS, not just its binary.** A base image can carry
  `libreoffice-core` and `libreoffice-common` with no `-writer`, `-impress` or `-calc`, and then
  `soffice` exists, exits 0, and converts nothing — every attempt reports "source file could not
  be loaded", including for a plain `.txt`. Gates 2 and 3 skip loudly when it is missing rather
  than passing quietly. Multi-page rendering also needs `poppler-utils`; without it only page one
  is rendered and `RenderResult.via` says `'libreoffice'` so a caller knows.
- **A tool parameter the model cannot see the shape of is a parameter it cannot fill in.**
  `spec: z.unknown()` with the shape in a separate help tool failed every time — the model
  serialised its object and sent a JSON *string*. Put the real schema in the tool definition,
  one tool per document type. And remember the worked example in `SPEC_EXAMPLES` is what the
  model copies: an example that opts into an optional flag produces that flag every time.
- **Builders add nothing the caller did not ask for.** An implicit cover slide turned "three
  slides" into four, the reviewer rejected it correctly, and the model could not express "no
  cover" — so it fought the builder for nine attempts. Implicit content is very hard to drive.
- **A gate that cannot run reports failure, never success.** No judge, no rasteriser, no reviewer
  — all of them fail the document. A verification step that passes when it could not check is how
  verification quietly stops happening.
- **`apps/mac-shell` cannot be built or tested on Linux.** Seatbelt, TCC/PPPC, Keychain,
  FSEvents+`clonefile` and notarization need a Mac runner. Do not attempt them in CI here.

## Conventions

- pnpm workspaces, Node 22+, ESM.
- `packages/protocol` depends on nothing else in the repo. Everything speaks to it.
- Playwright uses the pre-installed Chromium at `/opt/pw-browsers`. Never run `playwright install`.
