import Combine
import Foundation
import OSLog

/// Process-wide singletons, created once and owned outside the view tree.
///
/// SwiftUI would normally own these in a `@StateObject`, but `AppDelegate` has to
/// reach the sidecar at quit time and a delegate gets no view environment. Rather
/// than keep two paths to the same object, there is one: this. Views still receive
/// it through `.environmentObject` so they observe changes normally.
@MainActor
final class AppServices: ObservableObject {
    static let shared = AppServices()

    let sidecar: SidecarController
    let keychain: KeychainStore

    /// The transcript, the file tree and the connector list — everything derived from
    /// the sidecar's event stream. Owned here rather than in a `@StateObject` for the
    /// same reason the sidecar is: the menu bar acts on it, and menu commands get no
    /// view environment.
    let conversation: ConversationStore

    /// Conversations on disk, and the list the source list renders.
    let sessions: SessionLibrary

    /// `~/Library/Application Support/<bundle id>/`. Everything the shell writes
    /// lives under here so an uninstall is one `rm -rf`.
    let dataDirectory: URL

    /// The only directory the Seatbelt profile grants write access to.
    let workspaceRoot: URL

    /// Bumped by the Reload command. `WorkspaceWebView` compares it against the
    /// value it last acted on, which turns "reload now" into ordinary SwiftUI state
    /// rather than a side channel (NotificationCenter, a delegate, a shared web view
    /// reference) that has to be torn down by hand.
    @Published private(set) var reloadNonce: UInt64 = 0

    /// Bumped by the Focus Composer command. The composer compares it against the
    /// value it last acted on, which turns "put the caret in the input" into ordinary
    /// SwiftUI state rather than a side channel that has to be torn down by hand.
    @Published private(set) var composerFocusNonce: UInt64 = 0

    private let log = Logger(subsystem: AppInfo.subsystem, category: "services")

    private init() {
        let support = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")

        let base = support.appendingPathComponent(AppInfo.bundleIdentifier, isDirectory: true)
        dataDirectory = base
        workspaceRoot = base.appendingPathComponent("workspace", isDirectory: true)

        let keychain = KeychainStore(service: AppInfo.bundleIdentifier)
        self.keychain = keychain
        sidecar = SidecarController(dataDirectory: base, keychain: keychain)

        let sessions = SessionLibrary(dataDirectory: base)
        self.sessions = sessions
        conversation = ConversationStore(library: sessions)
    }

    func start() {
        do {
            try FileManager.default.createDirectory(at: workspaceRoot, withIntermediateDirectories: true)
        } catch {
            // Not fatal on its own — the sidecar will fail with a clearer message if
            // it also cannot write here — but it is the first thing to look at.
            log.error("Could not create workspace root \(self.workspaceRoot.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
        sidecar.start()

        // Open the most recent conversation, or start one. A shell that launches to
        // an empty screen with a full history one click away is just a worse shell.
        if let latest = sessions.sessions.first {
            conversation.open(latest)
        } else {
            conversation.startNewSession()
        }
    }

    func shutdown() {
        // Archive before the sidecar goes away: this is the last moment anything can
        // be written, and the transcript is the only part of a session that is ours
        // to keep.
        conversation.persist()
        sidecar.stopBlocking(timeout: 2.0)
    }

    func requestReload() {
        reloadNonce &+= 1
        Task { await conversation.refreshAll() }
    }

    func focusComposer() {
        composerFocusNonce &+= 1
    }

    func restartSidecar() {
        sidecar.restartNow()
    }
}

/// Identity constants read from the bundle, with literals as the fallback so a
/// `swift run` outside an .app bundle still produces sane logging and Keychain keys.
enum AppInfo {
    static let bundleIdentifier: String = Bundle.main.bundleIdentifier ?? "co.apolitical.agentic.macshell"

    /// os_log subsystem. Kept identical to the bundle id so
    /// `log stream --predicate 'subsystem == "co.apolitical.agentic.macshell"'` works.
    static let subsystem: String = bundleIdentifier

    static let displayName: String =
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
        ?? (Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String)
        ?? "Agentic Workspace"

    static let versionString: String = {
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        return "\(short) (\(build))"
    }()
}
