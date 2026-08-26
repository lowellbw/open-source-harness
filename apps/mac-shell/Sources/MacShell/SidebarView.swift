import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// The source list: what is in the workspace, and what the agent may reach outside it.
///
/// Both panes answer the same question from different sides — "what can this thing
/// touch?" — which is why they share a sidebar rather than living in separate windows.
struct SidebarView: View {
    var body: some View {
        VStack(spacing: 0) {
            FileTree()
            Divider()
            ConnectorsPane()
        }
    }
}

// MARK: - Files

private struct FileTree: View {
    @EnvironmentObject private var conversation: ConversationStore
    @EnvironmentObject private var services: AppServices

    @State private var isTargeted = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader(title: "Workspace", systemImage: "folder") {
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([services.workspaceRoot])
                } label: {
                    Image(systemName: "arrow.up.forward.app")
                }
                .buttonStyle(.borderless)
                .help("Reveal the workspace folder in Finder")

                Button {
                    Task { await conversation.refreshFiles(path: "/") }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Refresh")
            }

            List(flattened, id: \.entry.id) { row in
                FileRow(entry: row.entry, depth: row.depth)
            }
            .listStyle(.sidebar)
            .overlay {
                if (conversation.entries["/"] ?? []).isEmpty {
                    VStack(spacing: 6) {
                        Image(systemName: "tray")
                            .font(.title2)
                            .foregroundStyle(.tertiary)
                        Text("No files yet")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("Drop files here to add them")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    .allowsHitTesting(false)
                }
            }
            // Dropping onto the list is how a file gets into the workspace without a
            // file picker, which is the way people actually move a CSV into a tool.
            .onDrop(of: [.fileURL], isTargeted: $isTargeted) { providers in
                load(providers)
                return true
            }
            .overlay {
                if isTargeted {
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(Color.accentColor, style: StrokeStyle(lineWidth: 2, dash: [5]))
                        .padding(4)
                        .allowsHitTesting(false)
                }
            }
        }
        .frame(minHeight: 180)
    }

    private struct Row {
        let entry: DirEntry
        let depth: Int
    }

    /// Flattened in code rather than drawn with `OutlineGroup`.
    ///
    /// Children arrive from a separate request per directory, so the tree is
    /// assembled as it loads rather than being known up front — `OutlineGroup` wants
    /// the whole shape at once. Flattening also keeps the row view non-recursive,
    /// which a recursive `some View` cannot be.
    private var flattened: [Row] {
        var rows: [Row] = []
        func walk(_ path: String, depth: Int) {
            for entry in conversation.entries[path] ?? [] {
                rows.append(Row(entry: entry, depth: depth))
                if entry.isDirectory, conversation.expandedDirectories.contains(entry.path) {
                    walk(entry.path, depth: depth + 1)
                }
            }
        }
        walk("/", depth: 0)
        return rows
    }

    private func load(_ providers: [NSItemProvider]) {
        for provider in providers {
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                guard let url else { return }
                Task { @MainActor in conversation.upload([url]) }
            }
        }
    }
}

private struct FileRow: View {
    @EnvironmentObject private var conversation: ConversationStore
    let entry: DirEntry
    let depth: Int

    var body: some View {
        HStack(spacing: 5) {
            if entry.isDirectory {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(conversation.expandedDirectories.contains(entry.path) ? 90 : 0))
                    .frame(width: 10)
            } else {
                Spacer().frame(width: 10)
            }

            // The real document icon from Launch Services, so a .csv looks like a
            // .csv. A hand-picked SF Symbol per extension is a losing game.
            Image(nsImage: Self.icon(for: entry))
                .resizable()
                .frame(width: 15, height: 15)

            Text(entry.name)
                .lineLimit(1)
                .truncationMode(.middle)

            Spacer(minLength: 4)

            if !entry.isDirectory {
                Text(Format.bytes(entry.size))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
            }
        }
        .padding(.leading, CGFloat(depth) * 12)
        .contentShape(Rectangle())
        .onTapGesture {
            if entry.isDirectory { conversation.toggleDirectory(entry) }
        }
        .contextMenu {
            if !entry.isDirectory {
                Button("Save a Copy…") { save() }
            }
            Button("Copy Path") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(entry.path, forType: .string)
            }
        }
        .help(entry.path)
    }

    private func save() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = entry.name
        panel.canCreateDirectories = true
        // The workspace file is fetched over the API rather than copied off disk:
        // the workspace may not be local at all — the same seam backs a container and,
        // later, a remote sandbox — so there is no path to copy from in general.
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        conversation.download(entry, to: destination)
    }

    private static func icon(for entry: DirEntry) -> NSImage {
        if entry.isDirectory {
            return NSWorkspace.shared.icon(for: .folder)
        }
        let type = UTType(filenameExtension: (entry.name as NSString).pathExtension) ?? .data
        return NSWorkspace.shared.icon(for: type)
    }
}

// MARK: - Connectors

private struct ConnectorsPane: View {
    @EnvironmentObject private var conversation: ConversationStore

    private var status: ConnectorStatus { conversation.connectors }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader(title: "Connectors", systemImage: "puzzlepiece.extension") {
                if !status.pending.isEmpty {
                    Text("\(status.pending.count)")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Color.orange, in: Capsule())
                        .foregroundStyle(.white)
                }
                Button {
                    Task { await conversation.refreshConnectors() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Refresh connectors")
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if status.servers.isEmpty && status.errors.isEmpty && status.pending.isEmpty {
                        Text("No connectors configured.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 4)
                    }

                    ForEach(status.servers) { server in
                        HStack(spacing: 6) {
                            Circle()
                                .fill(server.status == "connected" ? Color.green : Color.secondary)
                                .frame(width: 6, height: 6)
                            Text(server.name ?? server.id)
                                .font(.caption)
                            Spacer(minLength: 0)
                            if let count = server.toolCount {
                                Text("\(count)")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                                    .monospacedDigit()
                            }
                        }
                    }

                    ForEach(status.errors) { error in
                        Label(error.message, systemImage: "exclamationmark.triangle")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                            .lineLimit(2)
                    }

                    if !status.pending.isEmpty {
                        Divider().padding(.vertical, 2)
                        // §11: a tool is not callable until a human has read what it
                        // claims to do. A description that *changed* after approval is
                        // called out separately — something you trusted has moved,
                        // which is a stronger signal than something you have not seen.
                        Text("Waiting for approval")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)

                        ForEach(status.pending) { tool in
                            PendingToolRow(tool: tool)
                        }

                        if status.pending.count > 1 {
                            Button("Approve All") { conversation.approveTool(nil) }
                                .controlSize(.small)
                                .padding(.top, 2)
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 14)
            }
        }
        .frame(minHeight: 150, maxHeight: 340)
    }
}

private struct PendingToolRow: View {
    @EnvironmentObject private var conversation: ConversationStore
    let tool: ConnectorStatus.PendingTool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 5) {
                Text(tool.qualifiedName)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if tool.hasChanged {
                    Text("CHANGED")
                        .font(.system(size: 8, weight: .bold))
                        .padding(.horizontal, 3)
                        .background(Color.orange.opacity(0.25), in: RoundedRectangle(cornerRadius: 3))
                        .foregroundStyle(.orange)
                }
            }
            if !tool.description.isEmpty {
                Text(tool.description)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button("Approve") { conversation.approveTool(tool.qualifiedName) }
                .controlSize(.mini)
        }
        .padding(7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .quaternarySystemFill), in: RoundedRectangle(cornerRadius: 6))
    }
}

// MARK: - Shared chrome

private struct SectionHeader<Accessory: View>: View {
    let title: String
    let systemImage: String
    @ViewBuilder var accessory: Accessory

    var body: some View {
        HStack(spacing: 5) {
            Label(title, systemImage: systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Spacer(minLength: 4)
            accessory
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
    }
}
