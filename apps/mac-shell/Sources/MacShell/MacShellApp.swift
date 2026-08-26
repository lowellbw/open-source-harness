import AppKit
import SwiftUI

@main
struct MacShellApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        // `Window`, not `WindowGroup`. The shell is one workspace surface; a second
        // window would mean a second client on the same sidecar session, which the
        // agent core does not expect. Using `Window` also means SwiftUI never
        // synthesises a File > New Window item, so there is nothing to strip.
        Window("Agentic Workspace", id: Self.mainWindowID) {
            RootView()
                .environmentObject(AppServices.shared)
                .environmentObject(AppServices.shared.sidecar)
                .environmentObject(AppServices.shared.conversation)
                .environmentObject(AppServices.shared.sessions)
                // Both a floor and a ceiling, and both are load-bearing under
                // `.windowResizability(.contentMinSize)`.
                //
                // That modifier makes the window's minimum size the *content's*
                // minimum. Without an explicit `maxHeight`, a NavigationSplitView full
                // of lists reports a minimum of nearly the whole screen, so the window
                // is forced to grow to about 1370pt tall — and on the way there the
                // content is briefly taller than the window it sits in, which draws as
                // a transcript starting behind the title bar, a composer below the
                // bottom edge, and two columns rendering nothing at all.
                //
                // `maxHeight: .infinity` says the content is happy at any size, which
                // is what stops it dictating one.
                .frame(
                    minWidth: 900, idealWidth: 1280, maxWidth: .infinity,
                    minHeight: 620, idealHeight: 860, maxHeight: .infinity
                )
        }
        .defaultSize(width: 1280, height: 860)
        // Unified toolbar with no visible title bar separator, which is what every
        // document-shaped Mac app has looked like since Big Sur.
        .windowToolbarStyle(.unified)
        // Deliberately NOT `.windowResizability(.contentMinSize)`.
        //
        // That mode makes the window's minimum size the content's minimum, and a
        // NavigationSplitView of lists reports a minimum close to the height of the
        // screen. The window is then forced to roughly 1370pt tall, and while it is
        // getting there the content is taller than the window containing it: the
        // transcript starts behind the title bar, the composer sits below the bottom
        // edge, and both columns render empty. Nothing logs a warning; it just looks
        // like a broken app.
        //
        // The default resizability lets the window be whatever size the user wants and
        // the content adapt, which is what every other document-shaped Mac app does.
        .commands { WorkspaceCommands() }

        // The other shell's surface, in a window of its own.
        //
        // Not the product — the product is the native UI above. It is here because
        // the web workspace and the Mac app are meant to stay at parity, and the only
        // honest way to check that is to look at both against the same sidecar.
        Window("Web Workspace", id: Self.webWindowID) {
            WebWorkspaceWindow()
                .environmentObject(AppServices.shared)
                .environmentObject(AppServices.shared.sidecar)
                .frame(minWidth: 700, minHeight: 500)
        }
        .defaultSize(width: 1100, height: 760)

        Settings {
            SettingsView()
                .environmentObject(AppServices.shared)
                .environmentObject(AppServices.shared.sidecar)
        }
    }

    static let mainWindowID = "workspace"
    static let webWindowID = "web-workspace"
}

/// Menu items that act on the shell rather than on the content inside it.
struct WorkspaceCommands: Commands {
    @Environment(\.openWindow) private var openWindow

    // Every action hops to the main actor explicitly. `Commands` bodies are not
    // main-actor-isolated in the 5.9 language mode, so calling straight into
    // `AppServices` (which is) is a warning today and an error under Swift 6.
    // One `Task { @MainActor in }` per action makes the isolation correct in both.
    var body: some Commands {
        // Replaces the stock File > New Item group rather than sitting beside it:
        // there is one window, so "New" can only mean a new session.
        CommandGroup(replacing: .newItem) {
            Button("New Conversation") {
                Task { @MainActor in AppServices.shared.conversation.startNewSession() }
            }
            .keyboardShortcut("n", modifiers: .command)
        }

        CommandGroup(after: .textEditing) {
            Button("Focus Message Field") {
                Task { @MainActor in AppServices.shared.focusComposer() }
            }
            .keyboardShortcut("l", modifiers: .command)
        }

        CommandMenu("Workspace") {
            Button("Refresh") {
                Task { @MainActor in AppServices.shared.requestReload() }
            }
            .keyboardShortcut("r", modifiers: .command)

            Button("Stop Turn") {
                Task { @MainActor in AppServices.shared.conversation.cancelTurn() }
            }
            .keyboardShortcut(".", modifiers: .command)

            Divider()

            Button("Restart Sidecar") {
                Task { @MainActor in AppServices.shared.restartSidecar() }
            }
            .keyboardShortcut("r", modifiers: [.command, .shift])

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

            Divider()

            Button("Show Web Workspace") {
                openWindow(id: MacShellApp.webWindowID)
            }
            .keyboardShortcut("w", modifiers: [.command, .option])
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

        // Deferred one turn: SwiftUI has not created the window yet at this point,
        // and there is nothing to size or reposition until it has.
        DispatchQueue.main.async {
            Self.applyFirstRunSize()
            Self.constrainWindowsToScreen()
        }

        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { _ in
            MainActor.assumeIsolated { Self.constrainWindowsToScreen() }
        }
    }

    /// Pulls a window back onto a screen that actually exists.
    ///
    /// AppKit restores a window to the frame it was last closed at, and that frame is
    /// saved in global coordinates. Undock a laptop from an external display and the
    /// saved origin points at empty space: the window opens almost entirely off the
    /// right of the built-in screen, and the sliver that remains renders as a badly
    /// broken app rather than as a misplaced window. AppKit's own cascading does not
    /// catch it because the frame is not invalid, only unreachable.
    ///
    /// Gives the window a sensible size the first time the app is ever run.
    ///
    /// `.defaultSize` does not win here. SwiftUI sizes the window to the content's
    /// ideal instead, and the ideal height of a NavigationSplitView of lists is close
    /// to the height of the screen — so a first launch opens a window tall enough to
    /// fill a large display, which is not a sensible first impression. Once AppKit has
    /// saved a frame under this window's autosave key the user's own size wins and
    /// this does nothing, which is why it is keyed on that default's absence rather
    /// than on a launch counter.
    private static func applyFirstRunSize() {
        let autosaveKey = "NSWindow Frame \(MacShellApp.mainWindowID)"
        guard UserDefaults.standard.object(forKey: autosaveKey) == nil else { return }
        guard let window = NSApp.windows.first(where: { $0.isVisible }),
              let screen = window.screen ?? NSScreen.main else { return }

        let visible = screen.visibleFrame
        let size = CGSize(width: min(1280, visible.width), height: min(860, visible.height))
        let origin = CGPoint(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2)
        window.setFrame(CGRect(origin: origin, size: size), display: true)
    }

    /// The window is nudged back rather than re-centred, so a window the user had
    /// deliberately placed keeps roughly the position they chose.
    private static func constrainWindowsToScreen() {
        for window in NSApp.windows where window.isVisible {
            // `window.screen` is nil when the window is entirely off every display,
            // which is one of the cases being repaired.
            guard let screen = window.screen ?? NSScreen.main else { continue }
            let visible = screen.visibleFrame
            var frame = window.frame
            guard !visible.contains(frame) else { continue }

            frame.size.width = min(frame.width, visible.width)
            frame.size.height = min(frame.height, visible.height)
            frame.origin.x = min(max(frame.minX, visible.minX), visible.maxX - frame.width)
            frame.origin.y = min(max(frame.minY, visible.minY), visible.maxY - frame.height)
            window.setFrame(frame, display: true)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Single-window shell: closing the window means quitting. Without this the
        // app lingers with no window and a live sidecar.
        //
        // The parity window is deliberately not a reason to stay alive — it is a
        // developer surface, and an app kept running by a debug window is a bug.
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        AppServices.shared.shutdown()
    }
}
