# What I am least sure about

Written on Linux with no Swift toolchain and no Apple frameworks. Nothing here has been
compiled or run. This is the list I would work through first on a real Mac, ordered by
how much doubt I have rather than by how bad the failure is.

Two of these fail *silently* — 2 and 6. Those are the ones worth deliberately testing
rather than waiting to notice.

---

### 1. The Seatbelt profile's system-minimum allow set

`SandboxExec.profile`. The workspace rules I am confident about; the block that lets a
process start at all is written from how Apple's own `/usr/share/sandbox/*.sb` profiles
are shaped, not from a trace on a real machine. A deny-by-default profile that is
missing one `dyld` path or one `mach-lookup` name fails at `exec` with an opaque error
and no obvious cause.

Specifically unverified:

- whether `(allow file-read-metadata)` is accepted with no filter argument;
- the exact `mach-lookup` global names, especially the opendirectoryd ones;
- `(allow process-info* (target self))` syntax;
- whether `(param "WORKSPACE_ROOT")` is accepted *inside* `(subpath …)` in the current
  SBPL, and whether `-D` must precede `-p` on the command line.

How to check: Settings → Sandbox, run `id && pwd && printf ok > probe.txt && cat probe.txt`,
with `log stream --style compact --predicate 'senderImagePath CONTAINS "Sandbox"'` open
in a terminal. To generate a candidate allowance set instead of guessing, add
`(trace "/tmp/seatbelt.trace")` to the profile temporarily.

If `(param …)` turns out not to work inside `subpath`, the fallback is to write the
profile to a temporary file with the path interpolated and shell-escaped, and use `-f`.
I chose `-D` because interpolating a path into a Scheme string literal is a policy
injection waiting to happen — a workspace directory with a `"` in its name would end
the literal early and rewrite the rules.

### 2. `WKNavigationDelegate` selector signatures — fails silently

These are optional Objective-C protocol methods. If a signature does not match what the
SDK declares, there is **no compile error**: the method is simply never called. The one
that matters is

```swift
func webView(_:decidePolicyFor:decisionHandler:)
```

because it is what keeps a link in model-rendered output from navigating the shell
window somewhere else. Recent SDKs annotate the completion handler
(`@MainActor @Sendable`), and there is also an `async` overload. If the app compiles but
an external link opens *inside* the window instead of in your browser, this is why.

Test: put an `<a href="https://example.com">` in the workspace page and click it. It
should open in the default browser and the shell should stay where it was.

### 3. App Transport Security and a raw loopback IP

`build.sh` writes `NSAllowsLocalNetworking` plus an exception domain for `localhost`.
`NSExceptionDomains` takes domain names, so it cannot cover `127.0.0.1`, and I am not
certain `NSAllowsLocalNetworking` extends to the loopback IP in a `WKWebView` load.

If the first load fails with `NSURLErrorAppTransportSecurityRequiresSecureConnection`
(-1022), change `SidecarEndpoint.url` to use `localhost` — the exception domain already
covers it. I used `127.0.0.1` to avoid a resolver round trip and the case where the name
resolves to `::1` while the sidecar bound only the IPv4 loopback; if you switch, make
the sidecar bind both or bind `::`.

Do **not** reach for `NSAllowsArbitraryLoads`. It disables ATS for the whole app.

### 4. Keychain: which keychain, and the access prompt

`KeychainStore.useDataProtectionKeychain` defaults to `false`, so items go to the legacy
file keychain. That is the only thing that works for an ad-hoc-signed local build:
the data-protection keychain wants a `keychain-access-groups` entitlement backed by a
real team identifier, and without one `SecItemAdd` returns `errSecMissingEntitlement`
(-34018). Flip it on for Developer ID builds, where `kSecAttrAccessible` also starts
meaning something — the legacy keychain ignores that attribute entirely.

The consequence I am least happy about: `SidecarController.launch()` reads the key on
every launch, and legacy-keychain items are ACL-bound to the signing identity of the
binary that created them. Every rebuild re-signs, so **expect a "wants to access your
keychain" prompt on the first launch after each build**. That is correct behaviour, not
a bug, but it is annoying enough that you may want to gate the read behind "only if a
key was ever stored" during development.

Also unverified: whether `SecItemUpdate` on the legacy keychain accepts a query
containing `kSecAttrAccount` without `kSecAttrAccessible` (it should; that is the
documented split), and whether `contains(account:)` — `SecItemCopyMatching` with a
`NULL` result pointer and no `kSecReturn*` key — is accepted on every macOS 14+ point
release. If it returns `errSecParam`, ask for `kSecReturnAttributes` instead and
discard the result.

### 5. Actor isolation under the Swift 5 language mode

`AppServices` and `SidecarController` are `@MainActor`; `MacShellApp` and
`WorkspaceCommands` are ordinary structs that touch `AppServices.shared`. Under
`swift-tools-version:5.9` that is a warning at most, which is exactly why the
tools-version is pinned there. Command actions already wrap their bodies in
`Task { @MainActor in }` so they are correct either way.

If you raise the tools-version to 6.x, expect these to become errors and budget for it
properly rather than sprinkling `@preconcurrency`.

### 6. The `Binding` captured in `makeCoordinator` — fails silently

`WorkspaceWebView.Coordinator` stores the `Binding<WebLoadState>` handed to it once, at
creation, rather than refreshing a `parent` reference in `updateNSView`. For a
`@State` on a stable parent view this is fine, and `RootView` is stable. But if the
retry overlay ever stops appearing on a failed load while the load genuinely failed,
this is the first thing to check: switch to storing `parent: WorkspaceWebView` and
assigning `context.coordinator.parent = self` at the top of `updateNSView`.

### 7. Sidecar shutdown against a real Node process

The logic I am most confident in and least able to prove. Specifically:

- `Process.terminationHandler` fires exactly once and before Foundation reaps the
  child, which is what makes the `SIGKILL` escalation in `stopBlocking` safe from pid
  reuse. I believe this; I have not watched it.
- `applicationWillTerminate` runs on ⌘Q and on Quit from the Dock, but **not** on
  `SIGTERM` to the app or on a crash. That is what the stdin-EOF watchdog is for — and
  it only works if the sidecar implements it. No sidecar exists yet, so this path is
  entirely untested. Check with `lsof -i` after force-quitting the app.
- Whether a `Task { @MainActor in … }` enqueued from `terminationHandler` during
  application termination ever runs. It should not matter — `stopBlocking` does the
  work synchronously — but if you see a crash at quit, this is where to look.

### 8. The universal build

`swift build --arch arm64 --arch x86_64` is SwiftPM's multi-arch flag and it has been
temperamental across releases. If it fails, build each architecture separately and
`lipo -create` the two binaries before `build.sh` assembles the bundle.

### 9. `os.Logger` interpolation

Every numeric value in a log call is converted with `String(…)` first, because
`OSLogInterpolation` accepts a narrower set of types with a `privacy:` argument than
plain string interpolation does. If any of those lines fail to compile, that is the
reason and the fix is more of the same.

### 10. SwiftUI details that will look wrong before they are wrong

- `Section { } header: { } footer: { }` inside `.formStyle(.grouped)` — the footer may
  not render on macOS. Cosmetic.
- `WKWebView.underPageBackgroundColor` is `NSColor!` in some SDK versions; assignment
  works either way, but it is the kind of thing that changes.
- `Window` (not `WindowGroup`) means macOS provides no File ▸ New Window item. If one
  appears anyway, something has re-added the `.newItem` command group.
