import AppKit
import SwiftUI

/// The conversations source list.
///
/// A `List` with `.sidebar` style and a `selection:` binding, which is what makes it
/// behave like every other Mac source list: arrow keys move, the selection keeps its
/// tint when the list loses focus, and the row highlight is the system's.
struct SessionListView: View {
    @EnvironmentObject private var library: SessionLibrary
    @EnvironmentObject private var conversation: ConversationStore

    @State private var renamingID: String?
    @State private var draftTitle = ""

    var body: some View {
        List(selection: selection) {
            Section("Conversations") {
                ForEach(library.visibleSessions) { session in
                    row(for: session)
                        .tag(session.id)
                }
            }
        }
        .listStyle(.sidebar)
        .layoutProbe("sessions")
        // A field in the sidebar rather than `.searchable`.
        //
        // `.searchable(placement: .sidebar)` only lands in a sidebar when there is a
        // `NavigationSplitView` to own one; outside of it the placement is ignored and
        // the field is pushed into the window toolbar, on the far side from the list it
        // filters. This is the same control, where it belongs.
        .safeAreaInset(edge: .top, spacing: 0) {
            HStack(spacing: Space.xs) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                    .font(.caption)
                TextField("Search conversations", text: $library.searchText)
                    .textFieldStyle(.plain)
                if !library.searchText.isEmpty {
                    Button {
                        library.searchText = ""
                    } label: {
                        Label("Clear search", systemImage: "xmark.circle.fill")
                            .labelStyle(.iconOnly)
                            .foregroundStyle(.dsMuted)
                            .hitTarget(20)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, Space.s)
            .padding(.vertical, Space.xs)
            .background(Color.dsSurface, in: Radius.shape(Radius.small))
            .overlay(Radius.shape(Radius.small).strokeBorder(Color.dsBorder))
            .padding(.horizontal, Space.m)
            .padding(.vertical, Space.s)
            .chromeSurface()
        }
        .overlay {
            if library.sessions.isEmpty {
                ContentUnavailableView(
                    "No Conversations",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("Press ⌘N to start one.")
                )
            } else if library.visibleSessions.isEmpty {
                ContentUnavailableView.search(text: library.searchText)
            }
        }
        .safeAreaInset(edge: .bottom) {
            Button {
                conversation.startNewSession()
            } label: {
                Label("New Conversation", systemImage: "square.and.pencil")
                    .font(Typo.secondary)
                    // Padding inside the label, not outside the Button. Outside, the
                    // 14pt side strips and 9pt top/bottom strips were not
                    // hit-testable, so clicking the obvious bar near its edges did
                    // nothing.
                    .padding(.horizontal, Space.m)
                    .padding(.vertical, Space.s)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .chromeSurface()
            .overlay(alignment: .top) {
                Rectangle().fill(.dsBorder).frame(height: Metric.hairline)
            }
        }
    }

    /// Selecting a row switches the conversation. Written as a computed `Binding` so
    /// the source of truth stays the library rather than a second copy in view state
    /// that has to be kept in step with it.
    private var selection: Binding<String?> {
        Binding(
            get: { library.selectedID },
            set: { newValue in
                guard let newValue, let summary = library.sessions.first(where: { $0.id == newValue })
                else { return }
                library.select(newValue)
                conversation.open(summary)
            }
        )
    }

    @ViewBuilder
    private func row(for session: SessionSummary) -> some View {
        if renamingID == session.id {
            TextField("Title", text: $draftTitle)
                .textFieldStyle(.roundedBorder)
                .onSubmit { commitRename(session.id) }
                .onExitCommand { renamingID = nil }
        } else {
            VStack(alignment: .leading, spacing: Space.hair) {
                Text(session.title)
                    .font(Typo.body)
                    // Explicit, not inherited. A `.sidebar` list is vibrant, and
                    // vibrancy desaturates unemphasised label colours — the row
                    // titles came out as pale grey against a pale material.
                    .foregroundStyle(.dsText)
                    .lineLimit(1)
                    .truncationMode(.tail)

                HStack(spacing: Space.xs) {
                    Text(Self.relative(session.updatedAt))
                        .monospacedDigit()
                    if session.turnCount > 0 {
                        Text("·")
                        Text("\(session.turnCount) turn\(session.turnCount == 1 ? "" : "s")")
                    }
                    if session.sessionUsd > 0 {
                        Text("·")
                        Text(Format.usd(session.sessionUsd))
                    }
                    if session.contextLost {
                        // The transcript survived the sidecar; the agent's memory of
                        // it did not. Saying so is the whole point of the badge.
                        Image(systemName: "clock.arrow.circlepath")
                            .help("Archived. The agent has no memory of this conversation — the sidecar restarted since.")
                    }
                }
                .font(Typo.micro)
                .foregroundStyle(.dsMuted)
                .lineLimit(1)
            }
            .padding(.vertical, Space.hair)
            .contextMenu {
                Button("Rename…") {
                    draftTitle = session.title
                    renamingID = session.id
                }
                Button("Copy Transcript") { copyTranscript(session.id) }
                Divider()
                Button("Delete", role: .destructive) { library.delete(session.id) }
            }
        }
    }

    private func commitRename(_ id: String) {
        library.rename(id, to: draftTitle)
        renamingID = nil
    }

    private func copyTranscript(_ id: String) {
        let turns = id == conversation.sessionID ? conversation.turns : library.transcript(for: id)
        let text = turns.map { turn -> String in
            switch turn.role {
            case .user: return "You: \(turn.text)"
            case .assistant:
                let tools = turn.tools.map { "  [\($0.name)] \($0.state == .failed ? "failed" : "ok")" }
                return (["Assistant: \(turn.text)"] + tools).joined(separator: "\n")
            case .notice: return "— \(turn.text)"
            }
        }.joined(separator: "\n\n")

        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()

    private static func relative(_ date: Date) -> String {
        // Anything inside a minute reads as "now" rather than "0s ago", which looks
        // like a stuck clock.
        guard Date().timeIntervalSince(date) > 60 else { return "Just now" }
        return relativeFormatter.localizedString(for: date, relativeTo: Date())
    }
}
