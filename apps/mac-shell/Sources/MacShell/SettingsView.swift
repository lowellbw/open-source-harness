import AppKit
import SwiftUI

struct SettingsView: View {
    var body: some View {
        TabView {
            ProviderKeySettings()
                .tabItem { Label("Provider Key", systemImage: "key") }
            SandboxSettings()
                .tabItem { Label("Sandbox", systemImage: "lock.shield") }
        }
        .frame(width: 560, height: 400)
    }
}

/// Local storage for a single provider API key.
///
/// This exists for local and single-seat use. In a managed deployment the org's key
/// lives in the gateway's KMS envelope and the shell never holds one: budgets, quotas
/// and model gating are enforced there precisely so that a client with a key cannot
/// route around them.
private struct ProviderKeySettings: View {
    @EnvironmentObject private var services: AppServices

    @State private var secret = ""
    @State private var hasStoredKey = false
    @State private var status = ""

    var body: some View {
        Form {
            Section {
                SecureField("API key", text: $secret)
                    .textFieldStyle(.roundedBorder)

                HStack {
                    Button("Save") { save() }
                        .disabled(secret.isEmpty)
                    Button("Remove") { remove() }
                        .disabled(!hasStoredKey)
                    Spacer()
                    Text(hasStoredKey ? "A key is stored" : "No key stored")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Provider key")
            } footer: {
                Text("Stored in the login keychain under \(services.keychain.service). "
                     + "The value is never written to disk by this app and never leaves the machine "
                     + "except to the provider you configured.")
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            if !status.isEmpty {
                Text(status)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .formStyle(.grouped)
        .onAppear { refresh() }
    }

    /// Presence only. Reading the secret itself can put a keychain access prompt in
    /// front of the user every time this pane opens, and the pane has no use for the
    /// value — it is write-only from here.
    private func refresh() {
        do {
            hasStoredKey = try services.keychain.contains(account: KeychainAccount.providerAPIKey)
            status = ""
        } catch {
            hasStoredKey = false
            status = error.localizedDescription
        }
    }

    private func save() {
        do {
            try services.keychain.write(secret, account: KeychainAccount.providerAPIKey)
            secret = ""
            status = "Saved. Restart the sidecar (Shift-Command-R) to apply it."
        } catch {
            status = error.localizedDescription
        }
        refresh()
    }

    private func remove() {
        do {
            try services.keychain.delete(account: KeychainAccount.providerAPIKey)
            status = "Removed."
        } catch {
            status = error.localizedDescription
        }
        refresh()
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
        VStack(alignment: .leading, spacing: 12) {
            Text("Workspace root")
                .font(.headline)
            HStack {
                Text(services.workspaceRoot.path)
                    .font(.system(.caption, design: .monospaced))
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
                .font(.headline)
            TextField("command", text: $command)
                .textFieldStyle(.roundedBorder)
                .font(.system(.body, design: .monospaced))
                .disabled(isRunning)

            HStack {
                Button(isRunning ? "Running…" : "Run") { run() }
                    .disabled(isRunning || command.isEmpty)
                Spacer()
                Text("Deny by default, no network, writes confined to the workspace root.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            ScrollView {
                Text(output.isEmpty ? "Denials are logged by the kernel. To watch them while tuning:\n\nlog stream --style compact --predicate 'senderImagePath CONTAINS \"Sandbox\"'" : output)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .background(Color(nsColor: .textBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(Color(nsColor: .separatorColor))
            )
        }
        .padding(20)
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
