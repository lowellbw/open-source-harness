# The Agentic Workspace — Plan v2

> **Status: canonical strategy.** Authored 24 Aug 2026. Annotated 26 Aug 2026 with corrections
> from a second verification pass — these appear inline as `> **Update (26 Aug 2026):**`
> callouts and as items 8–11 in §15. The original text is otherwise preserved as authored;
> only table and code-block formatting has been repaired so the document renders.
>
> For the *what and when*, see [`../BUILD-PLAN.md`](../BUILD-PLAN.md).

*24 Aug 2026. Supersedes the Mac-app plan and addendum. Scope expanded per your brief: ships as a Mac app **and** deployable inside the Apolitical web app; org admins connect model providers in an admin tool; users pick models inside the workspace; Apple design language; functional parity target is Claude Cowork / ChatGPT Work.*

*Everything load-bearing in this document has been re-verified against primary sources (vendor docs, official repos, spec changelogs). §15 lists the corrections that verification forced, and §16 what remains uncertain.*

---

## 1. What changed, and what it means

The brief moved from "a Mac-native BYO-key app for compliance-constrained buyers" to **one product, two deployment surfaces**: a Mac app, and the same workspace embedded in your existing multi-tenant web platform, with centrally administered model access.

Three consequences up front:

**a) The architecture must be one core, three shells.** A TypeScript agent core (loop, condenser, subagents, MCP, provider adapters, skills) that runs identically behind (1) a native Swift Mac shell, (2) a web workspace on a subdomain embedded in your app, and (3) is administered from (4) an admin console. The execution plane is pluggable: Seatbelt-sandboxed local processes on the Mac, per-org pooled cloud sandboxes on the web. OpenHands' SDK proves this exact abstraction works — the same agent code runs against `LocalWorkspace`, `DockerWorkspace`, or `RemoteAPIWorkspace` by swapping the workspace type. Steal that seam on day one.

**b) The web half changes the compliance story — but less than it would for a standalone startup.** A hosted workspace makes the operator a data processor for chat transcripts, files and connector content, with everything that follows (DPA scope, sub-processors, tenant-isolation evidence, key custody). For a standalone company that's a ~$50–150k first-year compliance bill. For Apolitical it's an *extension of a compliance program you already run* for government customers — the marginal items are sandbox isolation evidence, model-provider sub-processor disclosure, and key custody. The Mac app retains the "work never leaves the device" mode as a *feature within the same product* for the customers who need it.

**c) You have a new competitor and a new shortcut, and they're the same thing.** On 5 Aug 2026 Cloudflare open-sourced **Cloudflare OS** (Apache-2.0, verified): a full agentic workspace — persistent workspace with files and an isolated code runtime, **Gatekeepers** (credential-holding proxy workers so agents never see keys), MCP portals, skills, scheduled and event-triggered workflows, BYO model with per-person budgets. It is concept-identical to what you're building, welded to Cloudflare's stack, and free. The strategic reading: "a web agentic workspace with connectors, orchestration and skills" is no longer differentiating on its own. Your differentiation is (1) the government/learning vertical and your existing distribution, (2) the Mac-native local-execution mode nobody else pairs with a hosted product, and (3) the admin/governance layer tuned for public-sector buyers. Mine cloudflare-os for its Gatekeeper and sandboxed-artifact patterns regardless.

---

## 2. Product definition — parity target

What "functionality of Cowork / ChatGPT Work" concretely means, mapped to what those products verifiably do:

| Capability | Cowork / ChatGPT Work | Ours |
|---|---|---|
| Multi-step agentic tasks over files | Yes (Cowork: real docx/xlsx/pptx out) | Yes — document engine §10 |
| Code execution in a sandbox | Yes (Cowork VM / Work microVM) | Yes — Seatbelt local, cloud sandbox hosted §5 |
| Connectors (Drive, M365, Slack, etc.) | Yes | Yes — MCP-first §11 |
| Skills / plugins | Yes (SKILL.md, plugin marketplaces) | Yes — SKILL.md standard, curated registry |
| Subagents / parallel work | Yes | Yes — read-only scouts, one writer §9 |
| Scheduled + event-triggered runs | Yes (Cowork scheduled tasks; Work Automations) | Yes — trivial on web; wake-relay pattern on Mac §12 |
| Model choice | **No — single vendor** | **Yes — admin-curated multi-provider picker §6** |
| Runs on your machine | **No longer by default** (Cowork cloud-default since 7 Jul 2026, verified) | **Yes — Mac app local mode** |
| Admin governance (model gating, budgets, audit) | Partial (Claude Enterprise, ChatGPT Enterprise) | Yes — core product §6–7 |

The two bold rows are the pitch.

---

## 3. Architecture

```
┌───────────────┐  ┌────────────────────┐  ┌──────────────────┐
│  MAC SHELL     │  │  WEB WORKSPACE      │  │  ADMIN CONSOLE    │
│  SwiftUI       │  │  workspace.<domain> │  │  providers, keys, │
│  native chrome │  │  iframe-embedded in │  │  model catalog,   │
│  TCC, Keychain │  │  the main app       │  │  budgets, audit   │
└───────┬───────┘  └─────────┬──────────┘  └────────┬─────────┘
        │    same UI components (shadcn + AI Elements +        │
        │    assistant-ui primitives, DTCG design tokens)      │
        └─────────────────────┼────────────────────────────────┘
                    ┌─────────┴──────────┐
                    │  AGENT CORE (TS)    │  loop · condenser ·
                    │  one codebase       │  subagents · skills ·
                    │                     │  MCP client · planner/
                    │                     │  executor · taint
                    └─────────┬──────────┘
              ┌───────────────┼───────────────┐
      ┌───────┴──────┐ ┌──────┴───────┐ ┌─────┴────────┐
      │ MODEL GATEWAY │ │ EXECUTION    │ │ CONNECTOR    │
      │ virtual keys, │ │ Mac: Seatbelt│ │ GATEWAY      │
      │ budgets, org  │ │ Web: per-org │ │ OAuth broker,│
      │ model catalog │ │ sandbox pool │ │ token vault  │
      └───────────────┘ └──────────────┘ └──────────────┘
```

**The agent core is the same code everywhere.** On the Mac it runs as the Node sidecar inside the app bundle; on the web it runs server-side next to the sandbox pool. The core never touches raw provider keys, never holds OAuth tokens, and addresses its execution environment through one interface: `run(command) → output`, `read/write(path)`, plus lifecycle (`suspend/resume/snapshot`).

**The three gateway services are where multi-tenancy lives**, and they are shared between Mac and web deployments (the Mac app calls the model gateway too when the org administers keys centrally — see §6; it can also run fully local with user-supplied keys, which stays the personal/BYO mode).

> **Update (26 Aug 2026):** OpenHands' SDK is **Python**. Its `Workspace()` factory shape —
> `LocalWorkspace` / `DockerWorkspace` / `RemoteAPIWorkspace` behind one interface, with the
> factory resolving to local when only a working directory is given and to remote when host or
> runtime parameters are present — is a pattern to port into TypeScript, not code to reuse.
> The seam is still the right day-one steal; it just has to be written, and it lives in
> `packages/workspace`.

---

## 4. The web workspace

**Integration pattern (verified against what everyone ships):** a separate app on `workspace.<yourdomain>`, rendered in the main product as an **iframe with a postMessage bridge**, sharing SSO. This is the pattern of every embedded-agent product checked (Intercom Fin, CustomGPT, Amazon Quick Suite, ServiceNow VA). Module federation couples release cycles, pollutes the host JS scope, and removes the security boundary you *want* around agent-rendered content.

Mechanics that matter:

- **Auth handoff:** host session → short-lived, audience-scoped workspace JWT (claims: org, user, roles, model entitlements) minted by your existing backend, passed via postMessage or one-time-code redirect; the iframe exchanges it for its own httpOnly cookie on the workspace origin. Never run an IdP redirect *inside* the iframe — that's the documented Copilot-Studio-embed failure. Sibling subdomain of the same registrable domain avoids the third-party-cookie mess.

- **CSP:** host sets `frame-src workspace.…`; workspace sets `frame-ancestors 'self' *.<domain>` plus its own strict CSP. Streaming (SSE/fetch-streams, not WebSockets unless bidirectional is needed) happens inside the iframe's origin, so the host's `connect-src` is untouched.

- **Agent-rendered artifacts** (HTML the model wrote) go in a second, deeper-sandboxed iframe with RPC-only communication — exactly what Cloudflare OS does.

**UI kit:** shadcn/ui base + **Vercel AI Elements** (Apache-2.0, copy-in shadcn components for threads, reasoning, tool calls) + **assistant-ui** primitives (MIT, YC-backed, production-grade: streaming threads, generative UI mapping tool calls to components, human-approval workflows, AI SDK adapter). Adopt **AG-UI** (CopilotKit's open agent↔UI event protocol) as the wire format between core and shells so the Mac shell and web shell speak the same protocol.

**Multi-tenant execution:** per-run sandboxes drawn from a warm per-org pool — never share a sandbox across orgs; ephemeral per-user within an org. Default-deny egress. Since your end users include government learners who can trigger runs, enforce quotas **at the gateway, not the UI**: per-seat and per-org budgets on the virtual key, rpm and concurrency caps, model-tier gating by role (learners default to the cheap-tier floor), 50/80/100% soft-limit notifications (Cursor's pattern), hard org ceiling as backstop.

---

## 5. Execution economics for the hosted half

Verified vendor pricing, then the seat model (assumptions: 42 sandbox-hours/month = 2h/day, 2 vCPU / 4 GiB, 20 GB persistent workspace):

| Substrate | ~$/seat/month | Idle billing | Note |
|---|---|---|---|
| **Modal** | ~$5 | **Zero when idle** | Caveat from verification: Modal *Sandboxes* bill higher than Modal Functions (~$0.142/core-hr vs $0.047) — use the sandbox rate in your model, which roughly triples this line. Still cheap |
| **Cloudflare** | ~$6.50 | Sleeps, active-CPU billing | Pairs with Gatekeeper/outbound-worker pattern natively |
| Vercel Sandbox | ~$7 | Active-CPU only | |
| E2B | ~$8.50 | **Wall-clock while running** | $150/mo plan floor; fine at 100+ seats |
| Fly Sprites | ~$14–23 | Zero idle | |

**The one lever that matters is suspend discipline.** Keeping workspaces warm 10h/day instead of 2h takes E2B to ~$36/seat — the entire price of a seat, gone. Pick a zero-idle substrate (Modal, Cloudflare, Fly) and make suspend-on-idle an architectural commitment, not an optimisation.

**The line that can't be crossed: do not resell inference.** Sandbox + control plane + observability + support is roughly **$10–17/seat/month COGS with customer-side (or org-side) model keys** — healthy at a $25–40 seat price. Absorbing token costs yourself models out at ~$170/seat/month for two hours of agent loops a day (a third-party audit of 30 teams found median $480/dev/month on agentic coding work, 62% of it re-sent context — knowledge work is lighter, not 20× lighter). Inference is always pass-through: the org's keys, the org's bill, your meter.

---

## 6. The model layer and the admin tool

This is the section your new brief added, and the research was rich. The good news: the pattern you want is well-established, and the best reference implementations are open.

### 6.1 The shape

**An org admin connects providers; the org gets a curated model catalog; users pick from it in the workspace.** Copy three specific design decisions from the products that do this best (all verified against their docs):

- **Claude Team/Enterprise:** a two-level design — an org-wide model ceiling (enable/disable per model), role-level allowlists beneath it, and **a cheap model that is always available as a floor** so no configuration can brick the product. Copy all three.

- **Cursor Enterprise:** allow/blocklists at provider *and* model level, plus an **"auto-block newly released models by default"** toggle. For government customers that toggle is exactly right — new models join the catalog only after an admin opts in.

- **Portkey's Model Catalog:** admins define provider integrations centrally, then publish a budgeted, rate-limited model list to workspaces. That's your admin console's information architecture.

### 6.2 Per-org configuration schema

```yaml
org:
  providers:
    - id: anthropic-eu
      type: anthropic | openai | vertex | bedrock | azure | openrouter | openai-compatible
      base_url: "…"                    # incl. regional endpoints
      key_ref: "kms://org_123/…"       # reference — never the key itself
      region_pin: "eu"
  models:
    - alias: "Standard"                # user-facing name, decoupled from provider IDs
      provider: anthropic-eu
      upstream_model: "claude-sonnet-…"
      fallbacks: [vertex-eu/…]
      enabled_for_roles: [staff, learner]
      budgets: { per_seat_monthly_usd: 10, org_monthly_usd: 2000, rpm: 20 }
  defaults: { model: "Light", always_available: true }
```

Users see **aliases and tiers, not provider model IDs** — which also means an admin can swap the upstream model behind "Standard" without retraining anyone.

### 6.3 Gateway implementation

**Self-host LiteLLM as the org gateway** — its MIT core covers exactly this: OpenAI-compatible gateway, virtual keys, per-key/team/user budgets and spend tracking, model access groups, fallbacks. One licensing caution from verification: the repo is MIT *except* an `enterprise/` directory, and the boundary is enforced inconsistently (documented in their own issue tracker) — the admin UI itself is MIT, but treat anything the UI labels "enterprise" as commercially licensed intent and either pay or rebuild those pieces. Alternative: build a thin gateway yourself on the AI SDK; the surface you actually need (key vault ref → provider call, budget check, usage log) is small.

> **Update (26 Aug 2026):** This caution **generalises to the whole open-core category** and is
> now a scoring dimension, not a footnote. Mastra ships an `ee/` directory under the Mastra
> Enterprise Licence — the identical boundary problem. `@cline/llms` (Apache-2.0, no enterprise
> carve-out) is a TypeScript **in-process** alternative to a separately deployed LiteLLM,
> carrying provider clients and model catalogs, and should be scored in the bake-off against
> both LiteLLM and the thin-custom option this section already names.

**The critical pattern — the sandbox never sees a key.** Two tiers:

1. **Minimum viable (build first): short-lived virtual keys.** Each agent run gets a scoped credential for *your* gateway — budget-capped, TTL'd, model-allowlisted. A leaked key from a compromised sandbox is bounded by budget × TTL × allowlist. This is ~5% of the work of full interception for ~80% of the value.

2. **Full gatekeeper (when you run arbitrary agent code at scale):** default-deny sandbox egress; all HTTP through a forward proxy that allowlists hosts per org policy and injects credentials at the proxy, so the sandbox literally never holds them. This is Cloudflare OS's Gatekeeper design and Cloudflare Sandboxes' Outbound Workers (per-sandbox ephemeral CA, dynamic mid-run policy) — and Coder ships the same idea as "AI Bridge" + "Agent Boundaries". The pattern is becoming the industry standard; the PromptArmor exfiltration (via the vendor's own allowlisted domain) is why the allowlist must never blanket-include a model vendor's general API surface.

**Key custody:** per-tenant envelope encryption under a cloud KMS (per-tenant DEK wrapped by a KMS master key), decrypt only in the request path, rotation + audit trail. For a small team this beats running Vault, which is an ops liability. SOC 2 auditors care about the documented policy, rotation, least-privilege on decrypt, and the audit trail — not the vendor.

### 6.4 Data residency — the deciding admin feature for government

Verified state, and it's messier than expected:

- **OpenAI:** EU residency exists via the regional endpoint `eu.api.openai.com` — but eligibility is gated (sales-approved orgs).

- **Anthropic first-party API: still no EU data residency as of mid-2026.** EU-resident Claude means **Bedrock EU regions or Vertex AI EU regions**. Claude on Microsoft Foundry is GA but global-standard only — no EU data zone. (Flagged as a moving target; re-verify before committing to a customer.)

- **Google Vertex:** regional endpoints with at-rest residency — but API-key auth silently uses the *global* endpoint; you must configure the regional endpoint explicitly.

- **Azure:** regional + EU Data Zone deployment types, enforceable by Azure Policy.

So the admin console's `region_pin` is not decoration — it's the difference between winnable and unwinnable public-sector deals, and it's also why **enterprise cloud auth (Bedrock SigV4, Vertex service accounts, Azure Entra) is P0**, not a later add-on: for UK/EU government orgs, "Claude via Bedrock eu-west-2 under our own AWS account" is the answer that passes review.

### 6.5 What survives from the BYO-key thesis

Everything, one level up. The *user* no longer pastes keys; the *org* does. Model switching remains a first-class priced operation (strip provider reasoning artifacts — Anthropic signed thinking blocks, OpenAI reasoning items, Gemini thought signatures which hard-fail if dropped; switch only at compaction boundaries where the cache miss is already sunk — Cognition's Devin Fusion rule, verified, with their 35→60% cost-reduction claims). The four-bucket cost meter (uncached input / cache write at 1.25–2× / cache read at 0.1× / output incl. reasoning tokens) now feeds both the user's session view and the admin's org dashboard. Anthropic and Google have token-count endpoints; OpenAI doesn't — show estimates as ranges, reconcile from `usage`.

Personal Mac-app users without an org still get direct key entry (Keychain, device-only) — that's the free/personal tier, and Anthropic's verified Feb 2026 ban on subscription-OAuth in third-party tools means it's API keys only, no "sign in with Claude".

---

## 7. Design system — Apple vibes, legally

Verification confirmed the bright legal line: **Apple's SF Pro fonts and SF Symbols are licensed solely for software running on Apple platforms.** Self-hosting SF Pro on your web app would violate the licence, and SF Symbols carry the same restriction. So:

- **Type:** `-apple-system / system-ui` stack in the Mac app's views (the user's OS legally supplies SF there) and **Inter Variable** on the web — the de-facto SF stand-in used by the Linear/Notion-Calendar class of products — with tuned `font-feature-settings`. Zero SF assets in the repo.

- **Icons:** Lucide (shadcn's default) or Phosphor — closest weight-matched read to SF Symbols.

- **"Liquid Glass":** the translucent/refractive look is achievable on web — `backdrop-filter` blur/saturate for the base, SVG displacement-map refraction as a Chromium-only progressive enhancement — and shipping glassmorphism is standard practice with no realistic trade-dress exposure. The real risks are using "Liquid Glass" as a marketing term, shipping SF assets, or pixel-cloning Apple screens. Avoid those three, imitate freely otherwise. Performance: cap stacked blur layers, honour `prefers-reduced-transparency`.

- **What actually makes it feel Apple:** restraint, not glass. The Apple-quality web apps get the vibe from typography, tight spacing rhythm, muted borders, springy micro-interactions, and translucency used *sparingly* — on floating chrome (command palette, popovers, sidebars), never on content surfaces.

- **One token source:** a DTCG-format `tokens.json` (the W3C Design Tokens format became a real standard in 2026) compiled by Style Dictionary to CSS variables *and* SwiftUI constants. Colour, space, type, radius in tokens; each platform owns its materials (SwiftUI gets `.glassEffect` natively on macOS 26).

---

## 8. The Mac app

Unchanged in substance from the v1 plan — compressed here to what the dual-target changes.

The Swift shell owns TCC/permissions, Keychain, the FSEvents + `clonefile` checkpoint store, Seatbelt supervision, the egress proxy, Spotlight catalogue, launchd scheduling, notifications with inline Undo, and Vision-framework OCR. The web-shared UI components render inside it (WKWebView for the workspace surface is acceptable; native chrome around it), speaking the same AG-UI protocol as the web shell.

Still true, all verified: Mac App Store is unavailable (guideline 2.5.2 verbatim prohibits executing downloaded code that changes functionality — though "Apple has rejected agentic apps" should be softened to "the entire category ships direct-download, consistent with 2.5.2"); Developer ID + notarization + Sparkle; **never App Sandbox**. Seatbelt is deprecated-but-functional with no announced successor (Apple's own containerization repo has the unanswered issue) — ship the degraded path day one. `apple/container` 1.0 (now 1.2.2) as opt-in hard tier, macOS 26+ Apple silicon, Linux-only binaries. MDM facts verified: FDA/Accessibility/Apple Events are PPPC-grantable, **Screen Recording and Camera are not** (deny-only), Intune requires signed .pkg under 2GB. The enterprise deployment guide (mobileconfig samples, PPPC table with the `codesign -dr -` string, managed-prefs JSON schema, Installomator label) remains the highest-ROI compliance artifact — no AI vendor ships one.

**The one genuine capability gap on desktop is event-triggered automation** — webhooks need a public endpoint. The answer is not "move everything to cloud": it's a **content-blind wake relay** (the pattern Happy uses) — the relay receives the webhook, holds ciphertext or a bare "wake and fetch" signal, and pushes to the Mac app, which fetches the payload itself over its own authenticated connection. The relay never sees content, so the local mode's legal position survives. In the hosted deployment this is moot — webhooks land on the workspace server directly.

---

## 9. The agent core

Unchanged from v1; the essentials, all verified:

> **Update (26 Aug 2026):** "Unchanged from v1" no longer holds on the **build-vs-adopt**
> question — the engineering contracts below are all still correct and still required.
> Two Apache-2.0 TypeScript harnesses shipped after v1 was written:
> **`@cline/sdk`** (May 2026 — `@cline/core` sessions/tools/persistence/scheduling/plugins,
> `@cline/agents` stateless loop, `@cline/llms` provider clients and catalogs) and
> **Mastra Harness** (June 2026 — agent modes ≈ planner/executor, forked subagents inheriting
> context, tool approvals with resumable suspensions, on-thread model switching, persistent
> threads, subscribable event stream). Between them they cover most of this section.
>
> Two facts keep the choice reversible and set the architecture: **neither emits AG-UI**
> (Mastra emits its own `message_update` / `tool_approval_required` / `tool_suspended` /
> `display_state_changed`), and **neither documents context compaction**. So the AG-UI contract
> and the condenser below stay ours either way — which is exactly what lets each candidate be
> adapted to a common contract and scored. Resolved by bake-off; see
> [`../adr/0001-harness.md`](../adr/0001-harness.md).

- **Condenser contract:** keep-first (system + task) + keep-recent-verbatim + summarise-the-middle, recorded as an explicit event; compaction-before-summarisation (replace old tool outputs with path references first — lossless — and only then summarise).

- **Pin invariants outside compactable history.** Governance Decay (arXiv 2606.22528, verified): violations 0% → 30%, up to 59% after compaction; constraint pinning restores 0%; a working compaction-eviction attack exists. Permissions, scope and org policy re-inject every turn, never only at session start.

- **Subagents: read-only scouts, one writer.** Cline's exact rule set verified from their docs: subagents cannot edit files, use the browser, access MCP, or spawn subagents; own context and budget; return file-path reports. Read-heavy parallelises, write-heavy is single-threaded (the Cognition/Anthropic/LangChain triangle, all three posts verified).

- **Filesystem as context:** SKILL.md with progressive disclosure (cross-vendor standard now), todo recitation (Manus: ~50 tool calls causes drift), plan files as the compaction mechanism and human review surface.

- **Prompt-injection defence is architectural:** Rule of Two, egress allowlisting (never blanket-allow a vendor domain — PromptArmor, verified), planner/executor split with taint tracking, payload-showing approvals gated on irreversibility only.

---

## 10. Documents, and 11. Connectors — what the dual-target changes

**Documents: unchanged.** The Anthropic document skills licence trap is verified verbatim ("may not create derivative works… distribute, sublicense, or transfer"). Reimplement from ECMA-376 + open libraries (docx-js, pptxgenjs, openpyxl + mandatory LibreOffice recalc, Typst for PDF); the three-gate verification loop (XSD → recalc → render-and-look in a fresh subagent) is the product. The OfficeCLI-vs-LibreOffice spike still leads Phase 0 — on the web side, a single .NET binary vs a 700MB LibreOffice container image is also a COGS and cold-start question.

**Connectors: the web half flips the OAuth answer.** On desktop, "the org's IT admin creates the OAuth client and pastes the ID" was elegant. On a hosted multi-tenant product it survives legally (Google's internal-use exemption is about *who uses the app*, not where it runs — verified) but becomes an onboarding tax that kills self-serve; n8n's split is the map (managed OAuth on their cloud, BYO client for self-host). So: **plan for CASA on the hosted product** (third-party assessor estimates ~$540–4,500/yr — Google doesn't publish pricing; annual re-verification is in Google's docs) for Gmail/Drive restricted scopes, while shipping day one with (a) official remote MCP servers (Notion, Slack, Linear, Asana, Atlassian, Box…) which carry their own compliance, (b) `drive.file` per-file picker scope where possible, and (c) BYO-OAuth-client as the enterprise/on-prem option — which for government Workspace/M365 tenants is often what their IT *prefers* anyway. Microsoft: admin-consent flow (`/adminconsent`, `.default`) on day one. Token custody on the hosted side: same KMS envelope pattern as model keys; LibreChat's single-`CREDS_KEY` design is the documented anti-pattern (one env leak decrypts every tenant).

**MCP:** spec 2026-07-28 verified in full (sessions removed, Roots/Sampling/Logging deprecated, SSE resumability gone, CIMD replacing DCR). Build stateless; deferred tool loading from day one; hash-pin tool descriptions and re-approve on change; curated signed registry, no open marketplace (the ClawHavoc numbers held up: ~1,184 malicious skills, roughly a fifth to a quarter of that registry, distributing Atomic macOS Stealer).

> **Update (26 Aug 2026):** The four changes listed above are correct but **incomplete, and the
> omissions are the ones that determine client design.** Re-verified against the 2026-07-28
> changelog:
>
> - The entire `initialize` / `notifications/initialized` handshake is **removed**. Every request
>   now carries its own protocol version and client capabilities in `_meta`
>   (`io.modelcontextprotocol/protocolVersion`, `…/clientCapabilities`).
> - `server/discover` is added and servers **MUST** implement it.
> - **MRTR restructures rather than merely deprecates server-initiated requests.** Instead of
>   `roots/list` / `sampling/createMessage` / `elicitation/create`, servers return an
>   `InputRequiredResult` (`resultType: "input_required"`) carrying `inputRequests`; the client
>   retries the original request with `inputResponses`. `notifications/elicitation/complete`
>   and `elicitationId` are gone with it.
> - Every result now requires a `resultType` field (`"complete"` or `"input_required"`).
> - `CacheableResult` adds **required** `ttlMs` and `cacheScope` on all list/read results.
> - `subscriptions/listen` replaces the HTTP GET endpoint and `resources/subscribe`.
> - `ping` and `logging/setLevel` are removed; log level is per-request via `_meta`.
>
> **Do not hand-roll the client.** The official TypeScript SDK v2
> (`@modelcontextprotocol/client`, ESM-only, split from the monolithic package) implements this
> with automatic fallback to the `initialize` handshake for pre-2025-11-25 servers. For a
> stateless multi-tenant gateway fleet,
> `client.connect(transport, { prior: { kind: 'modern', discover } })` wraps a persisted
> `DiscoverResult` so workers skip the discovery probe entirely.

---

## 12. Scheduling, background work, and the workspace lifecycle

Hosted: cron and event triggers are server-side and trivial; suspend-on-idle is the COGS lever (§5); event-triggered workflows are a headline feature Cowork and Work both ship, so match them.

Mac: launchd via SMAppService + NSBackgroundActivityScheduler (thermal/battery-gated), notifications deliver results with inline Undo, and the wake relay (§8) covers event triggers without breaking the local-mode story.

Cross-device continuity — start on web, continue on Mac — falls out of the event-sourced session log if sessions are stored (or mirrored) server-side for org users. Local-mode personal sessions stay local; that asymmetry is a feature, not a bug, and should be legible in the UI.

---

## 13. Economics (revised for dual-target)

- **Hosted seat:** $10–17/seat/month COGS with org-side keys (inference pass-through). Priced inside your platform's existing packaging or at a $25–40 add-on, the margin holds. The fixed costs that dominate a standalone startup's case (SOC 2 from scratch, trust infrastructure) are marginal additions to your existing program.

- **Mac personal:** free tier (local models + direct keys) → paid personal licence. The verified reference points stand: BoltAI at $79–99 one-time with 1-year updates; TypingMind's ~$800k ARR is a third-party *estimate* (corrected from v1, where I cited it as fact) but the order of magnitude — BYO-key personal apps are lifestyle-business-sized — is well supported.

- **Where the real revenue is: org seats with governance.** The admin console, model catalog with residency pinning, budgets, audit export, MDM deployment — sold to the public-sector orgs you already serve. The earlier compliance research stands: "no data leaves the device" (Mac mode) removes 30–40% of a security questionnaire; the hosted mode leans on your existing processor status; the artifact that unblocks deals fastest is the deployment guide + architecture whitepaper, not a certification.

---

## 14. Roadmap v2 (3–4 engineers + your existing platform team for SSO/embed)

**Phase 0 — spikes, 3–4 wks (mostly unchanged, one addition):**

OfficeCLI vs LibreOffice on real docs · Seatbelt profile + degraded path · FSEvents+clonefile restore of an `rm -rf` · Swift⇄Node signed/notarized on a clean machine · **NEW: iframe embed spike** — workspace shell inside the Apolitical app with JWT handoff, SSE streaming through the iframe, CSP locked; and a Modal-vs-Cloudflare sandbox pool spike with suspend/resume timings.

**Phase 1 — the spine, ~6 wks:**

Agent core + condenser + AG-UI protocol · model gateway v1 (LiteLLM or thin custom; virtual keys per run; four-bucket metering) · admin console v1 (providers, key vault, model catalog with aliases/tiers/role gating, always-available floor, auto-block-new-models toggle) · web workspace shell with threads/tool-calls/approvals on AI Elements + assistant-ui. **Milestone: the priced model-switch demo — running in the web workspace, administered from the console.**

**Phase 2 — the workspace, ~8–10 wks:**

Cloud execution plane (per-org pools, default-deny egress, suspend discipline) · document engine + three-gate verification · MCP client + curated connectors + admin connector approval (ChatGPT-Enterprise-style: connectors off by default) · subagent scouts · skills + signed registry · scheduled/event workflows · audit log (hash-chained, org-exportable) · quotas/budgets enforced at the gateway. **Milestone: a multi-step task over Drive + uploaded files producing a verified deck, inside the embedded workspace, on an admin-configured EU-pinned model.**

**Phase 3 — the Mac app, ~8 wks (overlapping):**

Swift shell hosting the shared workspace UI · local execution plane (Seatbelt, checkpoints/undo, semantic diffs) · Keychain/local keys personal mode · org mode against the same gateway · wake relay · MDM packaging + deployment guide. **Milestone: same session opened on web, continued on Mac; and the local-mode demo — task runs with network verifiably closed except the model endpoint, one-click full undo.**

**Phase 4 — hardening:**

CASA (if managed Google OAuth is wanted) · EDR allowlisting · pen test incl. sandbox + iframe boundary + gateway · Tier-1 `apple/container` · admin analytics.

> **Update (26 Aug 2026):** [`../BUILD-PLAN.md`](../BUILD-PLAN.md) resequences this into what is
> actually being built, and inserts a two-week harness bake-off (hard stop) ahead of the Phase 1
> spine — see the §9 callout. Phase 0's two harness-independent spikes (OfficeCLI-vs-LibreOffice,
> iframe embed) run in parallel with it rather than behind it. The Mac-specific Phase 0 and
> Phase 3 items are excluded from that schedule: they cannot be built or tested on Linux and
> need a Mac runner.

---

## 15. Corrections from the verification pass

Fixed in this document; flagging them explicitly since earlier drafts circulated:

1. **The Berkeley "agents pass 25% of real tasks" claim was wrong as I stated it.** The benchmark is Berkeley RDI's *Agents' Last Exam* (~1,500 tasks, 55 sub-industries). 25.2% is the *best* agent on the *CLI subset*; the average full-pass rate overall is **below 1%**, and the hardest tier is **0%**. The honest framing is harsher than the one I used: agents fully complete only a few percent of long-horizon professional tasks end-to-end, while producing artifacts that *rate* above human baseline on bounded deliverables (GDPval-AA Elo ~1,845 vs human 1,000 — that part verified). The delta — the verification layer — is a *bigger* opportunity than v1 claimed, not smaller.

2. **"Apple has rejected agentic apps from MAS"** — anecdotal; softened to "the category ships direct-download, consistent with guideline 2.5.2" (the guideline text itself verified verbatim).

3. **CASA prices** ($540–4,500) are third-party assessor estimates, not Google-published — labelled as such.

4. **Modal pricing:** Modal *Sandboxes* bill ~3× Modal Functions rates (~$0.142/core-hr). The seat math in §5 uses the correct sandbox rate.

5. **TypingMind ~$817k ARR** is a GetLatka estimate, not company-reported.

6. **ClawHavoc proportion** is approximate (registry size moved); the 1,184-malicious-skills count and AMOS distribution are solid.

7. Manus's blog was unreachable during verification (maintenance page); its claims are corroborated by contemporaneous secondary coverage and stand, but the primary link should be rechecked before external citation.

Everything else — Cowork's timeline and cloud-default, the skills licence, the MCP changelog, Seatbelt status, the Anthropic OAuth ban, PPPC grantability, Intune constraints, Cline's subagent rules, Governance Decay's numbers, Devin Fusion, Cloudflare OS, LibreChat's feature set, prompt-caching rates, PromptArmor and SharedRoot — **confirmed against primary sources.**

### Added by the second pass (26 Aug 2026)

8. **§9's build-from-scratch assumption is superseded on the build-vs-adopt question.** Two
   Apache-2.0 TypeScript harnesses (`@cline/sdk`, May 2026; Mastra Harness, June 2026) now cover
   most of the agent core, and `@cline/llms` covers part of §6.3. The engineering contracts in
   §9 are unaffected and still required. Resolved by bake-off, not by assumption.

9. **§11's MCP summary is incomplete in the ways that matter for implementation.** The four
   listed changes are right; the removal of the `initialize` handshake, the addition of
   `server/discover`, MRTR replacing server-initiated requests, required `resultType`, and
   required `ttlMs`/`cacheScope` are the ones that actually shape a client. See the §11 callout.
   Consequence: use the official TypeScript SDK v2 rather than hand-rolling.

10. **OpenHands' SDK is Python**, so §3's "steal that seam on day one" is a pattern to port into
    TypeScript, not code to reuse.

11. **§6.3's open-core licensing caution generalises** beyond LiteLLM — Mastra's `ee/` directory
    reproduces the same boundary. Treat it as a bake-off scoring dimension.

## 16. Still open

- Anthropic first-party EU data residency (moving target; Bedrock/Vertex EU is the answer today).

- OpenAI EU endpoint eligibility criteria for your org size.

- LiteLLM enterprise-boundary licensing — get written clarity or budget the rebuild.

- Cloudflare Sandboxes' multi-tenant quota story (public docs thin).

- Whether Microsoft publisher verification genuinely covers native desktop clients (ambiguous docs; get a written answer).

- EU AI Act Art. 50(2) synthetic-content marking as applied to agent-generated documents — worth a legal opinion, especially selling to government.

- assistant-ui / AI Elements maturity under your exact load — spike, don't trust the README.

**Added 26 Aug 2026:**

- Does the bake-off-winning harness track MCP 2026-07-28, or do we swap in SDK v2 immediately?

- Mastra's `ee/` boundary needs the same written clarity as LiteLLM's `enterprise/`.

- Does `@cline/llms` displace or merely complement the gateway's provider layer?
