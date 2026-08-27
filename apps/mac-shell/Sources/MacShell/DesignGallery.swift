#if DEBUG
import AppKit
import SwiftUI

/// Every component, in every state, in one scrollable window.
///
/// A developer surface in a window of its own, following the precedent already set by
/// `WebWorkspaceWindow` — not a mode inside the product window.
///
/// It exists because the states worth designing against are the ones that are painful
/// to reach: a tool that failed, an approval blocking a run, prose with real Markdown,
/// a compaction notice. Reaching those in the running app means driving the UI through
/// System Events and waiting on a scripted sidecar, and against the real gateway it
/// costs tokens per screenshot. Here they are all on screen at once, deterministically,
/// and the whole thing can be captured in light and dark by relaunching with
/// `AGENTIC_APPEARANCE=dark`, or with the fallback chrome via `AGENTIC_LEGACY_CHROME=1`.
///
/// Open it with ⌥⌘G, or Workspace ▸ Design Gallery.
struct DesignGalleryWindow: View {
    @StateObject private var model = GalleryModel()

    /// Paged rather than one long scroll, because capturing it is the point and a
    /// screenshot cannot scroll. `AGENTIC_GALLERY_PAGE` picks the opening page so
    /// each one can be captured by relaunching.
    enum Page: String, CaseIterable, Identifiable {
        case tokens, transcript, panes

        var id: String { rawValue }
        var title: String { rawValue.capitalized }
    }

    @State private var page: Page =
        Page(rawValue: ProcessInfo.processInfo.environment["AGENTIC_GALLERY_PAGE"] ?? "") ?? .tokens

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $page) {
                ForEach(Page.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(Space.m)
            .frame(maxWidth: 420)

            Divider().overlay(.dsBorder)

            ScrollView {
                VStack(alignment: .leading, spacing: Space.xxl) {
                    switch page {
                    case .tokens: tokens
                    case .transcript: transcript
                    case .panes: panes
                    }
                }
                .padding(Space.xl)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(.dsCanvas)
        .navigationTitle("Design Gallery")
    }

    @ViewBuilder private var tokens: some View {
        GallerySection("Colour") { ColourSwatches() }
        GallerySection("Type") { TypeRamp() }
        GallerySection("Space and radius") { SpaceAndRadius() }
        GallerySection("Banners") { Banners() }
    }

    @ViewBuilder private var transcript: some View {
        Group {
                GallerySection("Transcript") {
                    TranscriptView()
                        .environmentObject(model.conversation)
                        .frame(height: 760)
                        .card(radius: Radius.card)
                }

                GallerySection("Approval sheet") {
                    if let approval = model.conversation.pendingApproval {
                        ApprovalSheet(approval: approval) { _ in }
                            .card(radius: Radius.card)
                    }
                }
        }
    }

    @ViewBuilder private var panes: some View {
        Group {
                GallerySection("Conversations pane") {
                    SessionListView()
                        .environmentObject(model.conversation)
                        .environmentObject(model.library)
                        .frame(width: Layout.sidebarIdeal, height: 320)
                        .card(radius: Radius.card)
                }

                GallerySection("Workspace inspector") {
                    SidebarView()
                        .environmentObject(model.conversation)
                        .environmentObject(AppServices.shared)
                        .frame(width: Layout.inspectorIdeal, height: 420)
                        .card(radius: Radius.card)
                }
        }
    }
}

@MainActor
private final class GalleryModel: ObservableObject {
    let library: SessionLibrary
    let conversation: ConversationStore

    init() {
        // A throwaway directory: the gallery must never touch the user's real
        // transcripts, and `SessionLibrary` writes an index on init.
        let scratch = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("agentic-design-gallery", isDirectory: true)
        try? FileManager.default.removeItem(at: scratch)
        library = SessionLibrary(dataDirectory: scratch)
        library.createSession()
        conversation = ConversationStore(library: library)
        conversation.applyDesignFixture(.withOverlays)
    }
}

// MARK: - Sections

private struct GallerySection<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            Text(title).dsHeading(Typo.subhead)
            content
        }
    }
}

private struct ColourSwatches: View {
    private let tokens: [(String, ColorToken)] = [
        ("bg", Palette.bg), ("surface", Palette.surface), ("inspector", Palette.inspector),
        ("border", Palette.border), ("text", Palette.text), ("muted", Palette.muted),
        ("accent", Palette.accent), ("danger", Palette.danger), ("ok", Palette.ok),
        ("codeFill", Palette.codeFill),
    ]

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 132), spacing: Space.m)],
                  spacing: Space.m) {
            ForEach(tokens, id: \.0) { name, token in
                VStack(alignment: .leading, spacing: Space.xs) {
                    Radius.shape(Radius.control)
                        .fill(token.color)
                        .frame(height: 44)
                        .overlay(Radius.shape(Radius.control)
                            .strokeBorder(.dsBorder, lineWidth: Metric.hairline))
                    Text(name).font(Typo.micro).foregroundStyle(.dsMuted)
                }
            }
        }
    }
}

private struct TypeRamp: View {
    private let ramp: [(String, Font)] = [
        ("display", Typo.display), ("heading", Typo.heading), ("subhead", Typo.subhead),
        ("body", Typo.body), ("secondary", Typo.secondary), ("caption", Typo.caption),
        ("micro", Typo.micro), ("mono", Typo.mono), ("monoSmall", Typo.monoSmall),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            ForEach(ramp, id: \.0) { name, font in
                HStack(spacing: Space.m) {
                    Text(name)
                        .font(Typo.micro)
                        .foregroundStyle(.dsMuted)
                        .frame(width: 80, alignment: .leading)
                    Text("The quick brown fox jumps over the lazy dog")
                        .font(font)
                        .foregroundStyle(.dsText)
                }
            }
            Text("EYEBROW").dsEyebrow()
        }
    }
}

private struct SpaceAndRadius: View {
    private let spaces: [(String, CGFloat)] = [
        ("hair", Space.hair), ("xs", Space.xs), ("s", Space.s),
        ("m", Space.m), ("l", Space.l), ("xl", Space.xl), ("xxl", Space.xxl),
    ]
    private let radii: [(String, CGFloat)] = [
        ("inline", Radius.inline), ("small", Radius.small), ("control", Radius.control),
        ("card", Radius.card), ("surface", Radius.surface),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            HStack(alignment: .bottom, spacing: Space.m) {
                ForEach(spaces, id: \.0) { name, value in
                    VStack(spacing: Space.xs) {
                        Rectangle().fill(.dsAccent).frame(width: value, height: 32)
                        Text(name).font(Typo.micro).foregroundStyle(.dsMuted)
                    }
                }
            }
            HStack(spacing: Space.m) {
                ForEach(radii, id: \.0) { name, value in
                    VStack(spacing: Space.xs) {
                        Radius.shape(value)
                            .fill(.dsSurface)
                            .overlay(Radius.shape(value).strokeBorder(.dsBorder))
                            .frame(width: 56, height: 40)
                        Text(name).font(Typo.micro).foregroundStyle(.dsMuted)
                    }
                }
            }
        }
    }
}

private struct Banners: View {
    var body: some View {
        VStack(spacing: Space.m) {
            InlineBanner(tone: .error,
                         message: "The workspace server did not respond in time.",
                         dismiss: {})
            InlineBanner(tone: .info,
                         message: "Archived conversation. The agent has no memory of this thread.")
        }
        .frame(maxWidth: 560)
    }
}
#endif
