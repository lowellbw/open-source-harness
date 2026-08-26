# sidecar

The Node process the Mac shell launches. It serves the same Next.js application
the web shell serves — one UI, one API surface, one set of behaviours — rather
than a parallel implementation that would drift.

## The contract

Specified by `apps/mac-shell/Sources/MacShell/SidecarLaunch.swift`, and verified
by `sidecar.test.ts`. The Swift half cannot be compiled on Linux, so this is the
only end of the contract that can be tested at all.

| Clause | Behaviour |
|---|---|
| `PORT` | `0` means any free port. The shell never picks one — a fixed port is a collision waiting to happen. |
| Ready line | Exactly one line on stdout, **after** the listen callback: `AGENTIC_SIDECAR_READY {"port":51234,"token":"…"}` |
| stdout | Nothing else. All logging goes to stderr, because the shell treats other stdout lines as log output. |
| stdin EOF | Shut down. The only signal that survives the shell being SIGKILLed. |
| `AGENTIC_DATA_DIR` | Where workspaces and state live. On the Mac that is Application Support, not a temp directory. |
| `AGENTIC_PROVIDER_API_KEY` | Present only when the user stored a key locally. A managed deployment has none — the org's key lives in the gateway. |

## Why there is a token

A loopback listener is not a security boundary on a multi-user Mac: any local
process running as any user can reach `127.0.0.1`. So the sidecar mints a token
per launch and announces it on stdout, where only its parent can see it.

The shell loads `http://127.0.0.1:<port>/?t=<token>` once. The sidecar exchanges
that for an httpOnly, SameSite=Strict cookie and redirects to strip the token
from the URL, so it does not linger in history or in a `Referer`. Every request
without the cookie is refused — the API included, since gating the HTML while
leaving the API open would be theatre.

## Running it directly

```sh
pnpm --filter @workspace/web build     # required: it serves a production build
node apps/sidecar/server.mjs
```

It prints the ready line with a token; open the URL it gives you.

The stdin EOF watchdog arms only when stdin is a pipe. Under `/dev/null` — how a
process manager or detached shell commonly spawns a child — EOF arrives
immediately, and an unconditional watchdog killed the sidecar before it served
anything. A pipe reports `isFIFO()`, `/dev/null` reports `isCharacterDevice()`.
