import AppKit
import PDFKit
import SwiftUI

/// What the right-hand pane can be showing.
///
/// Hidden is the default and the common case. The pane used to be a permanent third
/// column, which meant most of the time a third of the window said "No files yet" and
/// "No connectors configured" — chrome describing its own emptiness. It now appears
/// when there is something to appear for.
enum PaneMode: Equatable {
    case preview(String)
    case files
}

/// A workspace file, classified for display.
///
/// The cases mirror `inlineType()` in `apps/web/lib/serving.ts` **by extension**,
/// deliberately, rather than sniffing a content type off the response. That allowlist
/// is a security boundary — it excludes HTML and SVG on purpose, because agent-authored
/// markup is executable — and a client that sniffs instead of mirroring will happily
/// render something the server declined to serve inline.
enum ArtifactKind: Equatable {
    case markdown
    case image
    case pdf
    case text
    case unsupported

    init(path: String) {
        switch (path as NSString).pathExtension.lowercased() {
        case "md", "markdown":
            self = .markdown
        case "png", "jpg", "jpeg", "webp", "gif", "avif":
            self = .image
        case "pdf":
            self = .pdf
        case "txt", "csv", "json", "ts", "js", "py", "css", "yml", "yaml", "sh":
            self = .text
        default:
            // Notably html and svg, which land here rather than in a web view. They
            // need an isolated, non-persistent data store with network denied before
            // they can be rendered at all, and that is not built yet. Offering the
            // file to Finder is honest; rendering it in the app's own web view would
            // hand agent-authored script the app's origin.
            self = .unsupported
        }
    }
}

/// The right-hand pane: a document, or the workspace behind it.
struct ArtifactPane: View {
    @EnvironmentObject private var conversation: ConversationStore

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(.dsBorder)
            switch conversation.paneMode {
            case .preview(let path):
                ArtifactPreview(path: path)
                    // Keyed on the path so switching documents tears down the old
                    // load rather than showing it under the new title.
                    .id(path)
            case .files:
                SidebarView()
            }
        }
        .background(.dsInspector)
    }

    private var header: some View {
        HStack(spacing: Space.s) {
            Picker("View", selection: Binding(
                get: { conversation.paneMode.isPreview ? 0 : 1 },
                set: { conversation.showPane($0 == 0 ? conversation.lastPreview.map(PaneMode.preview) ?? .files : .files) }
            )) {
                Text("Document").tag(0)
                Text("Files").tag(1)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .disabled(conversation.lastPreview == nil)

            Spacer(minLength: Space.s)

            // Auto-follow is convenient until you are reading one file and the agent
            // writes another. The pin is what makes it safe to leave on by default.
            Button {
                conversation.followsNewDocuments.toggle()
            } label: {
                Image(systemName: conversation.followsNewDocuments ? "pin.slash" : "pin.fill")
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.dsMuted)
            .help(conversation.followsNewDocuments
                  ? "Stop opening each new document automatically"
                  : "Open each new document automatically")

            Button {
                conversation.hidePane()
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.dsMuted)
            .help("Close this pane")
        }
        .padding(.horizontal, Space.m)
        .padding(.vertical, Space.s)
        .chromeSurface()
    }
}

private extension PaneMode {
    var isPreview: Bool { if case .preview = self { return true } else { return false } }
}

// MARK: - Preview

/// One file, rendered according to its kind.
private struct ArtifactPreview: View {
    @EnvironmentObject private var conversation: ConversationStore
    let path: String

    @State private var data: Data?
    @State private var failure: String?
    @State private var isLoading = true

    private var name: String { (path as NSString).lastPathComponent }
    private var kind: ArtifactKind { ArtifactKind(path: path) }

    var body: some View {
        VStack(spacing: 0) {
            title
            Divider().overlay(.dsBorder)
            Group {
                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let failure {
                    EmptyPaneState(
                        symbol: "exclamationmark.triangle",
                        title: "Could not open this file",
                        detail: failure
                    )
                } else if let data {
                    content(data)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .task { await load() }
    }

    private var title: some View {
        HStack(spacing: Space.xs) {
            Image(systemName: symbol)
                .imageScale(.small)
                .foregroundStyle(.dsAccent)
            Text(name)
                .font(Typo.caption)
                .foregroundStyle(.dsText)
                .lineLimit(1)
                .truncationMode(.middle)
                .help(path)
            Spacer(minLength: Space.s)
            Button("Open") { open() }
                .buttonStyle(.borderless)
                .font(Typo.micro)
                .help("Open in the default application for this file type")
        }
        .padding(.horizontal, Space.m)
        .padding(.vertical, Space.xs)
    }

    private var symbol: String {
        switch kind {
        case .markdown: "doc.richtext"
        case .image: "photo"
        case .pdf: "doc.text.image"
        case .text: "doc.plaintext"
        case .unsupported: "doc"
        }
    }

    @ViewBuilder
    private func content(_ data: Data) -> some View {
        switch kind {
        case .markdown:
            ScrollView {
                MarkdownText(String(decoding: data, as: UTF8.self))
                    .padding(Space.l)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

        case .text:
            ScrollView([.horizontal, .vertical]) {
                Text(String(decoding: data, as: UTF8.self))
                    .font(Typo.monoSmall)
                    .foregroundStyle(.dsText)
                    .textSelection(.enabled)
                    .padding(Space.m)
            }
            .defaultScrollAnchor(.topLeading)

        case .image:
            if let image = NSImage(data: data) {
                ScrollView([.horizontal, .vertical]) {
                    Image(nsImage: image)
                        .resizable()
                        .scaledToFit()
                        .padding(Space.m)
                }
            } else {
                EmptyPaneState(
                    symbol: "photo",
                    title: "Not a readable image",
                    detail: "The bytes are there but macOS could not decode them."
                )
            }

        case .pdf:
            PDFPreview(data: data)

        case .unsupported:
            EmptyPaneState(
                symbol: "doc",
                title: name,
                detail: "\(Format.bytes(data.count)) · no inline preview for this type.",
                actionTitle: "Open"
            ) { open() }
        }
    }

    private func load() async {
        // The unsupported kinds are still worth a byte count, and a `frame`-class file
        // must not be fetched and handed to anything that could execute it.
        do {
            let bytes = try await conversation.download(path: path)
            data = bytes
            failure = nil
        } catch {
            failure = error.localizedDescription
        }
        isLoading = false
    }

    private func open() {
        Task {
            if let url = await conversation.materialise(path: path) {
                NSWorkspace.shared.open(url)
            }
        }
    }
}

/// PDFs, through the framework that already knows how to page them.
private struct PDFPreview: NSViewRepresentable {
    let data: Data

    func makeNSView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.backgroundColor = Palette.inspector.ns
        view.document = PDFDocument(data: data)
        return view
    }

    func updateNSView(_ view: PDFView, context: Context) {
        if view.document?.dataRepresentation() != data {
            view.document = PDFDocument(data: data)
        }
    }
}

// MARK: - Empty states

struct EmptyPaneState: View {
    let symbol: String
    let title: String
    var detail: String?
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: Space.s) {
            Image(systemName: symbol)
                .font(Typo.heading)
                .foregroundStyle(.dsMuted)
            Text(title)
                .font(Typo.secondary)
                .foregroundStyle(.dsText)
                .multilineTextAlignment(.center)
            if let detail {
                Text(detail)
                    .font(Typo.caption)
                    .foregroundStyle(.dsMuted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .controlSize(.small)
                    .padding(.top, Space.xs)
            }
        }
        .padding(Space.l)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
