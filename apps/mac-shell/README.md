# mac-shell

**None of this has been compiled or tested.**

It was written on Linux, where Swift, Xcode, SwiftUI, AppKit, WebKit and
Security.framework do not exist. There is no build here that could have caught a typo,
a wrong selector signature or a changed API. Assume the first `./build.sh` produces a
list of errors, and read [`NOTES.md`](./NOTES.md) before you start fixing them — it
lists what I am least sure about, roughly in the order it is likely to bite.

What *is* true: it is small (about 2,000 lines across nine files), every function has a
real body, and the design decisions that are hard to see from the code are written down
in the comments next to them.

---

## What it is

A native shell around the web workspace (§8 of `docs/strategy/PLAN-V2.md`):

| File | What it does |
|---|---|
| `MacShellApp.swift` | `@main`, one window, standard menus, AppKit delegate for quit |
| `AppServices.swift` | process-wide singletons and the app's data directory |
| `SidecarLaunch.swift` | resolving Node and the server script; the ready-line contract; line buffering |
| `SidecarController.swift` | launch, port discovery, supervision, backoff, clean shutdown |
| `WorkspaceWebView.swift` | `WKWebView` host, load-failure retry, off-origin containment |
| `RootView.swift` | status / workspace / failure states |
| `SettingsView.swift` | provider key pane, Seatbelt probe pane |
| `KeychainStore.swift` | typed generic-password read / write / delete |
| `SandboxExec.swift` | one command under a deny-by-default Seatbelt profile |

Not implemented, deliberately — each is a subsystem in its own right and none of them
can be written blind: the FSEvents + `clonefile` checkpoint store, the egress proxy,
Spotlight cataloguing, launchd scheduling, notifications with inline Undo, Vision OCR,
TCC/PPPC prompting, Sparkle updates, and the content-blind wake relay.

## Requirements

- **macOS 14** or later. The floor is set in `Package.swift`; nothing in the source
  needs an `@available` check below it.
- **Xcode 15.0** or later for the bundled Swift 5.9 toolchain. Xcode 16 and 17 both
  work — the package stays on `swift-tools-version:5.9` so the target builds in the
  Swift 5 language mode, where SwiftUI's and AppKit's remaining actor-isolation
  mismatches are warnings rather than errors. Raising the tools-version is a separate
  piece of work, not a formality.
- Command line tools on `PATH`: `swift`, `codesign`. `xcrun notarytool` and
  `xcrun stapler` only for distribution.
- **Node**, for the sidecar. A shipping build bundles its own runtime; a development
  build falls back to `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/usr/bin/node`
  or `$AGENTIC_NODE_PATH`. It does **not** search your shell `PATH` when launched from
  Finder, because a GUI app inherits launchd's `PATH` and a Homebrew install is
  invisible to it.

## Build and run

```sh
cd apps/mac-shell
./build.sh --run                                  # debug, ad-hoc signed, launched with logs here
./build.sh --release --sidecar ../../dist/sidecar # bundles the server into Resources
./build.sh --release --universal --sign "Developer ID Application: … (TEAMID)"
```

`--run` executes `Contents/MacOS/MacShell` directly rather than going through `open`,
so stdout, stderr and any crash text land on your terminal. `Bundle.main` still
resolves to the `.app`, because the binary is inside it.

Without a bundled sidecar, point the app at one:

```sh
AGENTIC_SIDECAR_PATH=/path/to/server.js "build/Agentic Workspace.app/Contents/MacOS/MacShell"
```

Logs:

```sh
log stream --style compact --predicate 'subsystem == "co.apolitical.agentic.macshell"'
```

## Why `Package.swift` + `build.sh` and not an Xcode project

An `.xcodeproj` is a `project.pbxproj` full of generated 96-bit hex identifiers with
cross-references between build phases, file references and target dependencies.
Hand-writing one on a machine that cannot open it produces a file that Xcode is as
likely to reject as to read, and if it *is* subtly wrong the failure is inscrutable.
`Package.swift` is twenty lines with a published schema.

The cost is that SwiftPM emits a bare Mach-O executable, and a SwiftUI app run that way
is wrong in ways that are not obvious: no `Info.plist` means no bundle identifier,
which means App Transport Security has no configuration, the Keychain has no service
identity, and `os_log` has no subsystem. So `build.sh` does the bundling — about sixty
lines of `mkdir`, `cp` and a heredoc'd plist, all of it inspectable. That is also the
layout `Bundle.main.resourceURL` expects at runtime, so there is one resource story
rather than two.

If you would rather have a project file: `swift package generate-xcodeproj` is gone,
but opening `Package.swift` in Xcode gives you a working editor, indexing and debugger
against the same package. Use `build.sh` for anything you intend to run.

Two SwiftPM details worth knowing before you edit: a file named `main.swift` would make
`@main` illegal, so `MacShellApp.swift` must keep its name; and the target declares no
`resources:`, on purpose — `Bundle.module` and a hand-assembled `.app` disagree about
where resources live.

This directory has no `package.json`, and should not get one. `pnpm-workspace.yaml`
globs `apps/*`, and pnpm skips directories without a manifest.

## Signing and distribution

**Running locally.** Apple silicon refuses to execute an unsigned binary, so there is
no unsigned path. `build.sh` ad-hoc signs (`codesign --sign -`) by default, which is
enough to launch on your own machine and nowhere else.

**Distributing.** Developer ID Application certificate, hardened runtime
(`--options runtime`), then notarization and stapling:

```sh
ditto -c -k --keepParent "build/Agentic Workspace.app" build/AgenticWorkspace.zip
xcrun notarytool submit build/AgenticWorkspace.zip --keychain-profile <profile> --wait
xcrun stapler staple "build/Agentic Workspace.app"
```

`build.sh` signs inside-out and never uses `--deep`: `--deep` is deprecated, applies
the outer entitlements to nested code, and is the usual cause of a notarization
rejection. The bundled Node runtime is signed first, with its own entitlements
(`Entitlements/Sidecar.entitlements`: JIT, unsigned executable memory, and library
validation disabled for npm-built native addons), then the app itself with
`Entitlements/MacShell.entitlements`, which relaxes nothing.

**The Mac App Store is not available to this app.** Guideline 2.5.2 prohibits
downloading and executing code that changes app functionality, which is what an agent
does. The whole category ships direct-download for the same reason. Expect Sparkle for
updates.

**App Sandbox must not be enabled.** It is not a preference. A sandboxed process cannot
spawn and supervise an arbitrary child outside its container — that is the Node sidecar
— and it cannot usefully call `sandbox-exec`, because Seatbelt profiles do not nest:
the outer container already denies what the inner profile would need to grant. Adding
`com.apple.security.app-sandbox` breaks both features at once, and the symptom is a
launch failure with no useful message.

## The sidecar contract

The shell launches `node <server.js>` with `PORT=0`, a pipe on stdin, and its data
directory as the working directory. The server must:

1. Print exactly one line to **stdout** once `listen` has called back — not before, or
   the shell races the listener:

   ```
   AGENTIC_SIDECAR_READY {"port":51234,"token":"optional-one-time-token"}
   ```

   A bare decimal port (`AGENTIC_SIDECAR_READY 51234`) is also accepted. Everything
   else on stdout and stderr is treated as log output and kept in a 200-line tail for
   the failure panel.

2. **Exit when stdin reaches EOF.** This is the only shutdown signal that survives the
   app being `SIGKILL`ed: the kernel closes the descriptor, the sidecar notices, and no
   orphan is left holding a loopback port. `SIGTERM` covers only the orderly case.

3. Treat the loopback listener as untrusted. Any local process running as any user can
   connect to `127.0.0.1`. If the server issues a token, the shell hands it back as
   `?t=` on the first request; the server is expected to exchange it for a session
   cookie and refuse unauthenticated requests thereafter.

Environment it receives: `PORT=0`, `AGENTIC_DATA_DIR`, `AGENTIC_SHELL=mac`,
`AGENTIC_SHELL_VERSION`, `HOME`, `PATH`, `NODE_ENV`, and `AGENTIC_PROVIDER_API_KEY`
when the user has stored a key locally. In a managed deployment there is no local key:
the org's key lives in the gateway, which is also where budgets, quotas and model
gating are enforced.

## Seatbelt

`SandboxExec` runs one command under `sandbox-exec` with a deny-by-default profile:
read of the system paths a process needs to start, read and write confined to one
workspace root, and no network. The profile is a commented string constant in
`SandboxExec.swift`.

`sandbox-exec` has been formally deprecated since macOS 10.14 and still has no
announced successor. It is also what every macOS agent tool ships today, because the
alternative on Apple silicon is a Linux VM. Treat it as the degraded tier: real
isolation for untrusted work is the container tier, which is why the workspace layer
reports `capabilities.isolated` honestly rather than claiming containment it does not
have.

The Sandbox tab in Settings runs an arbitrary command through that profile. It is there
because the profile's system-minimum allow set is the part of this repository most
likely to be incomplete, and tuning it needs a real machine:

```sh
log stream --style compact --predicate 'senderImagePath CONTAINS "Sandbox"'
```
