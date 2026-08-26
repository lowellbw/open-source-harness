// swift-tools-version:5.9
//
// Deliberately pinned at 5.9 rather than 6.x. A 6.x tools-version opts the target
// into the Swift 6 language mode, where every actor-isolation mismatch that SwiftUI
// and AppKit still produce becomes a hard error rather than a warning. This shell is
// small and single-threaded at the UI layer; buying strict concurrency here costs a
// day of churn and buys nothing. Raise it once the app has actually shipped once.

import PackageDescription

let package = Package(
    name: "MacShell",
    platforms: [
        // WKWebView.isInspectable (13.3), Window scene (13), underPageBackgroundColor (12).
        // 14 is the floor the product targets anyway; nothing here needs an availability check.
        .macOS(.v14)
    ],
    products: [
        .executable(name: "MacShell", targets: ["MacShell"])
    ],
    targets: [
        // No `resources:` on purpose. SwiftPM's resource bundling produces a
        // `MacShell_MacShell.bundle` alongside the binary and a `Bundle.module`
        // accessor that only resolves when the layout matches what SwiftPM expects.
        // build.sh assembles a real .app around this binary and puts everything under
        // Contents/Resources, which is where `Bundle.main.resourceURL` looks. One
        // resource story, not two.
        .executableTarget(
            name: "MacShell",
            path: "Sources/MacShell"
        )
    ]
)
