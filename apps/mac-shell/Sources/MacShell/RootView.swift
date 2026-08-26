import AppKit
import SwiftUI

/// The window's whole content: sidecar status until there is a port, the workspace
/// after that.
///
/// `sidecar` is injected separately rather than reached through `services.sidecar`.
/// SwiftUI only observes the object it was handed, and a nested `ObservableObject`
/// publishes nothing through its parent — reading `services.sidecar.state` would
/// render the first value and then never update again.
struct RootView: View {
    @EnvironmentObject private var services: AppServices
    @EnvironmentObject private var sidecar: SidecarController

    @State private var loadState: WebLoadState = .loading

    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
                .ignoresSafeArea()
            content
        }
    }

    @ViewBuilder
    private var content: some View {
        switch sidecar.state {
        case .idle:
            StatusPanel(title: "Starting the workspace", detail: nil)

        case .starting(let attempt):
            StatusPanel(
                title: "Starting the workspace",
                detail: attempt > 1 ? "Attempt \(attempt)" : nil
            )

        case .restarting(let attempt, let delay, let reason):
            StatusPanel(
                title: "Restarting the workspace",
                detail: "\(reason). Attempt \(attempt) in \(Self.format(delay))."
            )

        case .running(let endpoint):
            workspace(endpoint)

        case .failed(let failure):
            FailurePanel(
                title: failure.summary,
                detail: failure.detail,
                output: sidecar.recentOutput,
                actionTitle: "Try Again",
                action: { services.restartSidecar() }
            )
        }
    }

    private func workspace(_ endpoint: SidecarEndpoint) -> some View {
        ZStack(alignment: .topTrailing) {
            WorkspaceWebView(
                url: endpoint.url,
                reloadNonce: services.reloadNonce,
                loadState: $loadState
            )

            if loadState == .loading {
                ProgressView()
                    .controlSize(.small)
                    .padding(10)
                    .transition(.opacity)
            }

            if case .failed(let message) = loadState {
                // Opaque, because what is underneath is either a blank web view or
                // WebKit's own error page, and neither is something to show a user.
                ZStack {
                    Color(nsColor: .windowBackgroundColor)
                        .ignoresSafeArea()
                    FailurePanel(
                        title: "The workspace did not load",
                        detail: "\(message)\n\n\(endpoint.url.absoluteString)",
                        output: [],
                        actionTitle: "Reload",
                        action: {
                            loadState = .loading
                            services.requestReload()
                        },
                        secondaryActionTitle: "Restart Sidecar",
                        secondaryAction: { services.restartSidecar() }
                    )
                }
            }
        }
    }

    private static func format(_ delay: TimeInterval) -> String {
        delay < 1 ? "under a second" : "\(Int(delay.rounded())) seconds"
    }
}

private struct StatusPanel: View {
    let title: String
    let detail: String?

    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
                .controlSize(.small)
            Text(title)
                .font(.headline)
            if let detail {
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(32)
        .frame(maxWidth: 460)
    }
}

private struct FailurePanel: View {
    let title: String
    let detail: String
    let output: [String]
    let actionTitle: String
    let action: () -> Void
    var secondaryActionTitle: String? = nil
    var secondaryAction: (() -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
                Text(title)
                    .font(.headline)
            }

            Text(detail)
                .font(.callout)
                .foregroundStyle(.secondary)
                // Every string in this panel is something the user will be asked to
                // paste into a bug report.
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)

            if !output.isEmpty {
                ScrollView {
                    Text(output.joined(separator: "\n"))
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
                .frame(maxHeight: 180)
                .background(Color(nsColor: .textBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(Color(nsColor: .separatorColor))
                )
            }

            HStack {
                Button(actionTitle, action: action)
                    .keyboardShortcut(.defaultAction)
                if let secondaryActionTitle, let secondaryAction {
                    Button(secondaryActionTitle, action: secondaryAction)
                }
            }
        }
        .padding(28)
        .frame(maxWidth: 560)
    }
}
