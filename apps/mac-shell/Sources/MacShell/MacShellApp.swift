import AppKit
import SwiftUI

@main
struct MacShellApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        // `Window`, not `WindowGroup`. The shell is one workspace surface; a second
        // window would mean a second WKWebView pointed at the same sidecar session,
        // which the web app does not expect. Using `Window` also means SwiftUI never
        // synthesises a File > New Window item, so there is nothing to strip.
        Window("Agentic Workspace", id: Self.mainWindowID) {
            RootView()
                .environmentObject(AppServices.shared)
                .environmentObject(AppServices.shared.sidecar)
                .frame(minWidth: 900, minHeight: 620)
        }
        .defaultSize(width: 1200, height: 820)
        .windowResizability(.contentMinSize)
        .commands { WorkspaceCommands() }

        Settings {
            SettingsView()
                .environmentObject(AppServices.shared)
                .environmentObject(AppServices.shared.sidecar)
        }
    }

    static let mainWindowID = "workspace"
}

/// Menu items that act on the shell rather than on the page inside it.
struct WorkspaceCommands: Commands {
    // Every action hops to the main actor explicitly. `Commands` bodies are not
    // main-actor-isolated in the 5.9 language mode, so calling straight into
    // `AppServices` (which is) is a warning today and an error under Swift 6.
    // One `Task { @MainActor in }` per action makes the isolation correct in both.
    var body: some Commands {
        CommandMenu("Workspace") {
            Button("Reload") {
                Task { @MainActor in AppServices.shared.requestReload() }
            }
            .keyboardShortcut("r", modifiers: .command)

            Button("Restart Sidecar") {
                Task { @MainActor in AppServices.shared.restartSidecar() }
            }
            .keyboardShortcut("r", modifiers: [.command, .shift])

            Divider()

            Button("Reveal Workspace Folder in Finder") {
                Task { @MainActor in
                    NSWorkspace.shared.activateFileViewerSelecting([AppServices.shared.workspaceRoot])
                }
            }

            Button("Copy Workspace URL") {
                Task { @MainActor in
                    guard let url = AppServices.shared.sidecar.state.endpoint?.url else { return }
                    let pasteboard = NSPasteboard.general
                    pasteboard.clearContents()
                    pasteboard.setString(url.absoluteString, forType: .string)
                }
            }
        }
    }
}

/// AppKit lifecycle hooks SwiftUI's `App` does not expose.
///
/// The delegate exists for exactly one reason that matters: `applicationWillTerminate`
/// is the only place the sidecar can be stopped synchronously before the process goes
/// away. A `Scene`-level `.onDisappear` or a `deinit` runs too late, or not at all.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        AppServices.shared.start()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Single-window shell: closing the window means quitting. Without this the
        // app lingers with no window and a live sidecar.
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        AppServices.shared.shutdown()
    }
}
