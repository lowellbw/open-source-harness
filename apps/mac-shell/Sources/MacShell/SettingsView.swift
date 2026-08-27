import AppKit
import SwiftUI

struct SettingsView: View {
    var body: some View {
        TabView {
            KeySettings()
                .tabItem { Label("Keys", systemImage: "key") }
            SandboxSettings()
                .tabItem { Label("Sandbox", systemImage: "lock.shield") }
        }
        .frame(width: 580, height: 460)
    }
}

/// Local storage for the keys the sidecar needs.
///
/// This exists for local and single-seat use. In a managed deployment the org's keys
/// live in the gateway's KMS envelope and the shell never holds one: budgets, quotas
/// and model gating are enforced there precisely so that a client with a key cannot
/// route around them.
private struct KeySettings: View {
    var body: some View {
        Form {
            SecretSection(
                account: KeychainAccount.providerAPIKey,
                title: "Provider key",
                prompt: "API key",
                footer: "Required. Without it every route answers 500 and no turn can start."
            )
            SecretSection(
                account: KeychainAccount.searchAPIKey,
                title: "Search key",
                prompt: "Brave Search API key",
                // The Mac app rendered citations for a while with no way to produce
                // one: the shell never passed a search key, so `BRAVE_API_KEY` was
                // never set and the tool was simply absent from the model's toolset.
                // A missing optional key degrades to "the model never searched",
                // which is indistinguishable from "the model chose not to".
                footer: "Optional. Without it the web-search tool is not offered to the "
                    + "model at all, so answers are asserted rather than sourced — and "
                    + "nothing on screen says so."
            )
        }
        .formStyle(.grouped)
    }
}

/// One write-only secret.
private struct SecretSection: View {
    @EnvironmentObject private var services: AppServices

    let account: String
    let title: String
    let prompt: String
    let footer: String

    @State private var secret = ""
    @State private var hasStoredKey = false
    @State private var status: SettingsStatus?

    var body: some View {
        Section {
            SecureField(prompt, text: $secret)
                .textFieldStyle(.roundedBorder)

            HStack {
                Button("Save") { save() }
                    .disabled(secret.isEmpty)
                Button("Remove") { remove() }
                    .disabled(!hasStoredKey)
                Spacer()
                Text(hasStoredKey ? "A key is stored" : "No key stored")
                    .font(Typo.caption)
                    .foregroundStyle(.dsMuted)
            }

            if let status {
                Label(status.message, systemImage: status.symbol)
                    .font(Typo.caption)
                    .foregroundStyle(status.tone)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } header: {
            Text(title)
        } footer: {
            Text("\(footer) Stored in the login keychain under \(services.keychain.service). "
                 + "The value is never written to disk by this app.")
            .font(Typo.caption)
            .foregroundStyle(.dsMuted)
        }
        .onAppear { refresh() }
    }

    /// Presence only. Reading the secret itself can put a keychain access prompt in
    /// front of the user every time this pane opens, and the pane has no use for the
    /// value — it is write-only from here.
    /// - Parameter clearStatus: false when called straight after a save or a delete,
    ///   which have just set a message the user needs to read. This used to clear it
    ///   unconditionally, on the same run loop, so "Saved. Restart the sidecar…" was
    ///   never visible for a single frame.
    private func refresh(clearStatus: Bool = true) {
        do {
            hasStoredKey = try services.keychain.contains(account: account)
            if clearStatus { status = nil }
        } catch {
            hasStoredKey = false
            status = .failure(error.localizedDescription)
        }
    }

    private func save() {
        do {
            try services.keychain.write(secret, account: account)
            secret = ""
            status = .success("Saved. Restart the sidecar (⇧⌘R) to apply it.")
        } catch {
            status = .failure(error.localizedDescription)
        }
        refresh(clearStatus: false)
    }

    private func remove() {
        do {
            try services.keychain.delete(account: account)
            status = .success("Removed.")
        } catch {
            status = .failure(error.localizedDescription)
        }
        refresh(clearStatus: false)
    }
}

/// The surface for tuning the Seatbelt profile against a real machine.
///
/// Kept in the app rather than in a script because the interesting failures are the
/// ones that only happen under the profile the app actually ships, launched the way
/// the app actually launches it.
private struct SandboxSettings: View {
    @EnvironmentObject private var services: AppServices

    @State private var command = "id && pwd && printf 'ok' > probe.txt && cat probe.txt"
    @State private var output = ""
    @State private var isRunning = false

    var body: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            Text("Workspace root")
                .font(Typo.subhead)
            HStack {
                Text(services.workspaceRoot.path)
                    .font(Typo.monoSmall)
                    .lineLimit(1)
                    .truncationMode(.head)
                    .textSelection(.enabled)
                Spacer()
                Button("Reveal") {
                    NSWorkspace.shared.activateFileViewerSelecting([services.workspaceRoot])
                }
            }

            Divider()

            Text("Run under sandbox-exec")
                .font(Typo.subhead)
            TextField("command", text: $command)
                .textFieldStyle(.roundedBorder)
                .font(Typo.mono)
                .disabled(isRunning)

            HStack {
                Button(isRunning ? "Running…" : "Run") { run() }
                    .disabled(isRunning || command.isEmpty)
                Spacer()
                Text("Deny by default, no network, writes confined to the workspace root.")
                    .font(Typo.caption)
                    .foregroundStyle(.dsMuted)
            }

            ScrollView {
                Text(output.isEmpty ? "Denials are logged by the kernel. To watch them while tuning:\n\nlog stream --style compact --predicate 'senderImagePath CONTAINS \"Sandbox\"'" : output)
                    .font(Typo.monoSmall)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Space.m)
            }
            .background(Color.dsSurface)
            .clipShape(Radius.shape(Radius.card))
            .overlay(
                Radius.shape(Radius.card)
                    .strokeBorder(Color.dsBorder)
            )
        }
        .padding(Space.l)
    }

    private func run() {
        isRunning = true
        output = ""
        let command = self.command
        let root = services.workspaceRoot

        // @MainActor on the Task, not on the call: SandboxExec.run is a nonisolated
        // async function, so it leaves the main actor on its own and the results come
        // back here without a second hop.
        Task { @MainActor in
            do {
                let result = try await SandboxExec.run(command: command, workspaceRoot: root, timeout: 30)
                output = SandboxSettings.describe(result)
            } catch {
                output = "failed to run: \(error.localizedDescription)"
            }
            isRunning = false
        }
    }

    private static func describe(_ result: SandboxedCommandResult) -> String {
        var lines: [String] = [
            "exit \(result.exitCode)\(result.timedOut ? " (timed out)" : "") in \(String(format: "%.2f", result.duration))s",
        ]
        if !result.stdout.isEmpty {
            lines.append("\n--- stdout ---\n\(result.stdout)")
        }
        if !result.stderr.isEmpty {
            lines.append("\n--- stderr ---\n\(result.stderr)")
        }
        return lines.joined(separator: "\n")
    }
}


/// A settings message with a role, so a success and a Keychain failure do not render
/// identically in grey.
enum SettingsStatus {
    case success(String)
    case failure(String)

    var message: String {
        switch self {
        case .success(let text), .failure(let text): return text
        }
    }

    var symbol: String {
        switch self {
        case .success: return "checkmark.circle.fill"
        case .failure: return "exclamationmark.triangle.fill"
        }
    }

    var tone: Color {
        switch self {
        case .success: return .dsOK
        case .failure: return .dsDanger
        }
    }
}
