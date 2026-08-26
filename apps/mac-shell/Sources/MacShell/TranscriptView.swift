import AppKit
import SwiftUI

/// The conversation itself.
///
/// A plain `ScrollView` + `LazyVStack` rather than `List`. `List` on macOS brings
/// row selection, alternating backgrounds and inset grouping that all have to be
/// turned off again, and its row height caching fights text that grows a character
/// at a time while a turn streams.
struct TranscriptView: View {
    @EnvironmentObject private var conversation: ConversationStore

    private let bottomAnchor = "transcript.bottom"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    if conversation.turns.isEmpty {
                        EmptyTranscript()
                            .padding(.top, 60)
                    }

                    ForEach(conversation.turns) { turn in
                        TurnView(turn: turn)
                            .id(turn.id)
                    }

                    if conversation.isStreaming, conversation.status != .idle {
                        StatusLine(state: conversation.status)
                    }

                    Color.clear
                        .frame(height: 1)
                        .id(bottomAnchor)
                }
                .frame(maxWidth: 760, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.horizontal, 28)
                .padding(.vertical, 24)
            }
            // Only on a new turn, never on a delta. Following every delta takes the
            // scroll position away from someone reading further up, which is exactly
            // when they are most likely to be reading further up.
            .onChange(of: conversation.scrollAnchor) { _, anchor in
                guard let anchor else { return }
                withAnimation(.easeOut(duration: 0.25)) {
                    proxy.scrollTo(anchor, anchor: .top)
                }
            }
        }
    }
}

private struct EmptyTranscript: View {
    @EnvironmentObject private var conversation: ConversationStore

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "square.stack.3d.up")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(.tertiary)
            Text("Agentic Workspace")
                .font(.title3.weight(.semibold))
            Text("Ask for something. The agent works in a sandboxed folder and shows you every tool it runs.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            if let model = conversation.currentModel {
                Text("\(model.alias) · \(Format.compactTokens(model.contextWindow)) context")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - One turn

private struct TurnView: View {
    let turn: Turn

    var body: some View {
        switch turn.role {
        case .user:
            UserBubble(text: turn.text)
        case .notice:
            NoticeRow(text: turn.text, symbol: turn.symbol ?? "info.circle")
        case .assistant:
            AssistantTurn(turn: turn)
        }
    }
}

private struct UserBubble: View {
    let text: String

    var body: some View {
        HStack {
            Spacer(minLength: 60)
            Text(text)
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(Color.accentColor.opacity(0.14), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(Color.accentColor.opacity(0.22))
                )
        }
    }
}

private struct NoticeRow: View {
    let text: String
    let symbol: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Image(systemName: symbol)
                .font(.caption)
            Text(text)
                .font(.caption)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
        .padding(.horizontal, 10)
        .background(Color(nsColor: .quaternarySystemFill), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

private struct AssistantTurn: View {
    let turn: Turn
    @State private var showReasoning = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !turn.reasoning.isEmpty {
                ReasoningDisclosure(text: turn.reasoning, isExpanded: $showReasoning)
            }

            ForEach(turn.tools) { tool in
                ToolCallRow(tool: tool)
            }

            if !turn.text.isEmpty {
                MarkdownText(turn.text)
                    .textSelection(.enabled)
            }

            if turn.isStreaming && turn.text.isEmpty && turn.tools.isEmpty {
                TypingIndicator()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Reasoning

/// Collapsed by default and labelled as the model's own working.
///
/// It is shown at all because a turn that spends thirty seconds thinking and then
/// says one sentence looks broken otherwise. It is collapsed because it is not an
/// explanation — it is a trace, and presenting it as an explanation is a way of
/// claiming more than the model can support.
private struct ReasoningDisclosure: View {
    let text: String
    @Binding var isExpanded: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    Image(systemName: "brain")
                        .font(.system(size: 10))
                    Text(isExpanded ? "Hide reasoning" : "Reasoning")
                        .font(.caption.weight(.medium))
                }
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                Text(text)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .padding(.leading, 10)
                    .overlay(alignment: .leading) {
                        Rectangle()
                            .fill(Color(nsColor: .separatorColor))
                            .frame(width: 2)
                    }
            }
        }
    }
}

// MARK: - Tool calls

private struct ToolCallRow: View {
    let tool: ToolInvocation
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    stateIcon
                        .frame(width: 14)
                    Text(tool.name)
                        .font(.system(.callout, design: .monospaced).weight(.medium))
                    if !tool.args.isEmpty {
                        Text(tool.args.inlineSummary)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .padding(.horizontal, 11)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                Divider()
                VStack(alignment: .leading, spacing: 10) {
                    if !tool.args.isEmpty {
                        PayloadBlock(title: "Arguments", value: tool.args)
                    }
                    if tool.state != .running {
                        PayloadBlock(
                            title: tool.state == .failed ? "Error" : "Result",
                            value: tool.result,
                            isError: tool.state == .failed
                        )
                    }
                }
                .padding(11)
            }
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.5), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(tool.state == .failed ? Color.red.opacity(0.35) : Color(nsColor: .separatorColor))
        )
    }

    @ViewBuilder
    private var stateIcon: some View {
        switch tool.state {
        case .running:
            ProgressView().controlSize(.small).scaleEffect(0.6)
        case .succeeded:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .font(.system(size: 12))
        case .failed:
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(.red)
                .font(.system(size: 12))
        }
    }
}

private struct PayloadBlock: View {
    let title: String
    let value: JSONValue
    var isError = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title.uppercased())
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.tertiary)
                .tracking(0.5)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(value.prettyPrinted)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(isError ? Color.red : Color.primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 220)
        }
    }
}

// MARK: - Status

private struct StatusLine: View {
    let state: AgentState

    var body: some View {
        HStack(spacing: 7) {
            ProgressView().controlSize(.small).scaleEffect(0.7)
            Text(state.label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

private struct TypingIndicator: View {
    @State private var phase = 0.0

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3) { index in
                Circle()
                    .fill(Color.secondary)
                    .frame(width: 5, height: 5)
                    .opacity(0.3 + 0.7 * abs(sin(phase + Double(index) * 0.6)))
            }
        }
        .onAppear {
            withAnimation(.linear(duration: 1.2).repeatForever(autoreverses: false)) {
                phase = .pi * 2
            }
        }
    }
}

// MARK: - Markdown

/// Renders the assistant's text as Markdown, with a plain-text fallback.
///
/// `AttributedString(markdown:)` is the system parser — no dependency, and it tracks
/// the platform's own typography. It handles inline emphasis, code spans and links;
/// it does not do fenced code blocks or tables, so those are split out and rendered
/// as monospaced blocks rather than being flattened into a paragraph.
struct MarkdownText: View {
    private let blocks: [Block]

    private enum Block: Identifiable {
        case prose(String)
        case code(language: String?, body: String)

        var id: String {
            switch self {
            case .prose(let text): return "p:" + text.prefix(24)
            case .code(_, let body): return "c:" + body.prefix(24)
            }
        }
    }

    init(_ text: String) {
        self.blocks = Self.split(text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(blocks) { block in
                switch block {
                case .prose(let text):
                    Text(Self.attributed(text))
                case .code(let language, let body):
                    CodeBlock(language: language, code: body)
                }
            }
        }
    }

    private static func attributed(_ text: String) -> AttributedString {
        // `.full` so that a blank line becomes a paragraph break instead of being
        // collapsed, which is what `.inlineOnly` does and it looks like a bug.
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: true,
            interpretedSyntax: .full,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }

    private static func split(_ text: String) -> [Block] {
        guard text.contains("```") else {
            return text.isEmpty ? [] : [.prose(text)]
        }
        var blocks: [Block] = []
        var isCode = false
        var language: String?
        var buffer: [String] = []

        func flush() {
            let body = buffer.joined(separator: "\n")
            buffer.removeAll()
            let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            blocks.append(isCode ? .code(language: language, body: body) : .prose(trimmed))
        }

        for line in text.components(separatedBy: "\n") {
            if line.hasPrefix("```") {
                flush()
                isCode.toggle()
                language = isCode ? String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces) : nil
                continue
            }
            buffer.append(line)
        }
        flush()
        return blocks
    }
}

private struct CodeBlock: View {
    let language: String?
    /// Named `code`, not `body`: a stored property called `body` would collide with
    /// the `View` requirement.
    let code: String
    @State private var didCopy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language?.isEmpty == false ? language! : "text")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .tracking(0.5)
                Spacer()
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(code, forType: .string)
                    didCopy = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { didCopy = false }
                } label: {
                    Label(didCopy ? "Copied" : "Copy", systemImage: didCopy ? "checkmark" : "doc.on.doc")
                        .font(.caption2)
                        .labelStyle(.titleAndIcon)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)

            Divider()

            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.6), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Color(nsColor: .separatorColor))
        )
    }
}

// MARK: - Formatting

enum Format {
    static func usd(_ value: Double) -> String {
        // Sub-cent runs are the normal case and "$0.00" reads as free, which is the
        // one thing a cost meter must never imply.
        if value > 0 && value < 0.01 { return "<$0.01" }
        return String(format: "$%.2f", value)
    }

    static func compactTokens(_ count: Int) -> String {
        switch count {
        case 1_000_000...: return "\(count / 1_000_000)M"
        case 1_000...: return "\(count / 1_000)K"
        default: return "\(count)"
        }
    }

    static func bytes(_ count: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(count), countStyle: .file)
    }
}
