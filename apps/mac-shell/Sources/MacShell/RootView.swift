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
    @EnvironmentObject private var conversation: ConversationStore

    var body: some View {
        content
            // The endpoint moves on every sidecar restart, and the API client is built
            // around it. Connecting here, from the one view that is always mounted,
            // keeps that in one place instead of spread across the views that use it.
            .onAppear { conversation.connect(to: sidecar.state.endpoint) }
            .onChange(of: sidecar.state.endpoint) { _, endpoint in
                conversation.connect(to: endpoint)
            }
    }

    @ViewBuilder
    private var content: some View {
        switch sidecar.state {
        case .running:
            // Returned bare, and that is load-bearing.
            //
            // `NavigationSplitView` has to be the root of the scene's content. Wrapping
            // it in a `ZStack` alongside a sibling that calls `.ignoresSafeArea()` — the
            // background fill the other states use — hands the split view a safe area
            // that starts above the toolbar. The result is not a warning or a crash: the
            // columns lay out against the wrong height, the transcript draws from behind
            // the title bar, the composer ends up below the bottom of the window, and
            // both lists render nothing at all. It looks like a broken app rather than a
            // misplaced view, which is what made it expensive to find.
            WorkspaceView()

        case .idle:
            StatusScreen { StatusPanel(title: "Starting the workspace", detail: nil) }

        case .starting(let attempt):
            StatusScreen {
                StatusPanel(
                    title: "Starting the workspace",
                    detail: attempt > 1 ? "Attempt \(attempt)" : nil
                )
            }

        case .restarting(let attempt, let delay, let reason):
            StatusScreen {
                StatusPanel(
                    title: "Restarting the workspace",
                    detail: "\(reason). Attempt \(attempt) in \(Self.format(delay))."
                )
            }

        case .failed(let failure):
            StatusScreen {
                FailurePanel(
                    title: failure.summary,
                    detail: failure.detail,
                    output: sidecar.recentOutput,
                    actionTitle: "Try Again",
                    action: { services.restartSidecar() }
                )
            }
        }
    }

    private static func format(_ delay: TimeInterval) -> String {
        delay < 1 ? "under a second" : "\(Int(delay.rounded())) seconds"
    }
}

/// The workspace proper.
///
/// Conversations on the left, the transcript in the middle, the workspace itself on
/// the right — three panes with draggable dividers, which is the shape of most Mac
/// apps that show a library, a document and its properties.
///
/// `HSplitView`, not `NavigationSplitView` with an `.inspector`. The SwiftUI
/// containers are the more fashionable choice and they do not size correctly here:
/// measured with every child stubbed out, `NavigationSplitView` reports 1267pt tall
/// when it is proposed 808pt, so in any window smaller than the display the content
/// overflows the window that contains it. Nothing is clipped and nothing is logged —
/// the transcript starts behind the title bar, the composer lands below the bottom
/// edge, and the side columns render blank. `HSplitView` is a real `NSSplitView`,
/// respects the size it is given, and hands the user divider handles for free.
private struct WorkspaceView: View {
    @EnvironmentObject private var services: AppServices
    @EnvironmentObject private var conversation: ConversationStore

    @State private var draft = ""
    @State private var showSessions = true
    @State private var showInspector = true

    var body: some View {
        HSplitView {
            if showSessions {
                SessionListView()
                    .frame(minWidth: 190, idealWidth: 235, maxWidth: 340)
            }

            conversation_column
                .frame(minWidth: 440, maxWidth: .infinity)

            if showInspector {
                SidebarView()
                    .frame(minWidth: 220, idealWidth: 280, maxWidth: 420)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle(services.sessions.selected?.title ?? "Workspace")
        .navigationSubtitle(subtitle)
        .toolbar {
            WorkspaceToolbar(showSessions: $showSessions, showInspector: $showInspector)
        }
        // A sheet rather than an inline banner: an approval is modal in fact — the
        // run is blocked on it server-side — so it should be modal on screen too.
        .sheet(item: Binding(
            get: { conversation.pendingApproval },
            set: { newValue in
                // Dismissing the sheet any other way — Escape, or the window closing
                // — must not leave the run blocked until the server-side timeout.
                // Treat it as the denial it already is. If `resolve` cleared the
                // approval first, there is nothing left to deny and this is a no-op.
                if newValue == nil, let pending = conversation.pendingApproval {
                    conversation.resolve(pending, decision: .deny)
                }
            }
        )) { approval in
            ApprovalSheet(approval: approval) { decision in
                conversation.resolve(approval, decision: decision)
            }
        }
    }

    private var conversation_column: some View {
        VStack(spacing: 0) {
            if conversation.isArchived {
                ArchivedBanner()
            }
            TranscriptView()
            Divider()
            ComposerView(text: $draft, focusRequest: services.composerFocusNonce)
        }
    }

    private var subtitle: String {
        let cost = Format.usd(conversation.sessionCost.usd)
        guard let budget = conversation.budgetRemaining else { return "\(cost) this session" }
        return "\(cost) this session · \(Format.usd(budget)) left"
    }
}

/// The window toolbar.
///
/// Model, state and spend, in that order. All three are things the user needs at a
/// glance and never needs to hunt for, which is the definition of toolbar content —
/// and all three are things a chat UI usually buries.
private struct WorkspaceToolbar: ToolbarContent {
    @EnvironmentObject private var services: AppServices
    @EnvironmentObject private var conversation: ConversationStore
    @Binding var showSessions: Bool
    @Binding var showInspector: Bool

    var body: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            Button {
                showSessions.toggle()
            } label: {
                Label("Conversations", systemImage: "sidebar.leading")
            }
            .help("Show or hide the conversation list")
        }

        ToolbarItem(placement: .navigation) {
            StatusPill(state: conversation.status, isStreaming: conversation.isStreaming)
        }

        ToolbarItem(placement: .principal) {
            Picker("Model", selection: Binding(
                get: { conversation.selectedModel },
                set: { conversation.selectedModel = $0 }
            )) {
                ForEach(conversation.models) { model in
                    // The floor is labelled because it is the one model the role can
                    // never lose. A picker that can silently empty itself is worse
                    // than one that says where the bottom is.
                    Text(model.isFloor ? "\(model.alias) (always available)" : model.alias)
                        .tag(model.alias)
                }
            }
            .pickerStyle(.menu)
            .frame(minWidth: 130)
            .disabled(conversation.models.isEmpty)
            .help("Switching mid-session takes effect at the next compaction boundary.")
        }

        ToolbarItem(placement: .primaryAction) {
            Button {
                conversation.startNewSession()
            } label: {
                Label("New Conversation", systemImage: "square.and.pencil")
            }
            .help("Start a new conversation (⌘N)")
        }

        ToolbarItem(placement: .primaryAction) {
            Button {
                showInspector.toggle()
            } label: {
                Label("Workspace", systemImage: "sidebar.trailing")
            }
            .help("Show or hide the workspace files and connectors (⌥⌘I)")
        }
    }
}

/// Shown above a conversation whose server-side state is gone.
///
/// The transcript is on disk and reads fine; the agent has no memory of it, because
/// session state lives in the sidecar's process and the sidecar has restarted since.
/// Sending into it starts a fresh context that happens to sit under an old record.
private struct ArchivedBanner: View {
    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "clock.arrow.circlepath")
            Text("Archived conversation. The agent has no memory of this thread — anything you send starts a fresh context.")
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 16)
        .padding(.vertical, 7)
        .background(Color(nsColor: .quaternarySystemFill))
        .overlay(alignment: .bottom) { Divider() }
    }
}

private struct StatusPill: View {
    let state: AgentState
    let isStreaming: Bool

    var body: some View {
        HStack(spacing: 5) {
            if isStreaming && state != .idle {
                ProgressView().controlSize(.small).scaleEffect(0.55).frame(width: 10)
            } else {
                Image(systemName: state.symbol)
                    .font(.system(size: 8))
                    .foregroundStyle(state == .awaitingApproval ? .orange : .green)
            }
            Text(state.label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Color(nsColor: .quaternarySystemFill), in: Capsule())
    }
}

// MARK: - Non-running states

/// Centres one panel on the window background. Only the states that have no split
/// view of their own use this — see the comment on `.running` above.
private struct StatusScreen<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
                .ignoresSafeArea()
            content
        }
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


