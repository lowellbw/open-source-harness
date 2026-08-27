import AppKit
import SwiftUI

/// Renders the assistant's Markdown as real blocks.
///
/// The previous implementation recognised fenced code and nothing else: everything
/// else went to `AttributedString(markdown:)` inside a single `Text`. That applies
/// *inline* styling — emphasis, code spans, links — but SwiftUI's `Text` ignores
/// `presentationIntent`, so every block-level construct collapsed into run-on prose.
/// A heading ran into the paragraph after it ("What the file contains" + "data.csv
/// has…"), list items concatenated ("LATAM" + "quarter"), a table rendered as
/// "RegionQ1Q4EMEA184,320209,880", and a horizontal rule became three em dashes in
/// the middle of a sentence. Model output is mostly headings and lists, so this was
/// the most visible defect in the app.
///
/// The parser is deliberately small. It handles what a model actually emits and
/// nothing more — this is not a CommonMark implementation, and it should not grow
/// into one. Inline spans are still `AttributedString`'s job, which it does well.

enum MarkdownBlock: Equatable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case list(items: [String], ordered: Bool, start: Int)
    case quote(String)
    case code(language: String?, body: String)
    case table(header: [String], rows: [[String]])
    case rule
}

enum MarkdownParser {
    static func parse(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var quote: [String] = []
        var listItems: [String] = []
        var listOrdered = false
        var listStart = 1

        func flushParagraph() {
            let text = paragraph.joined(separator: " ").trimmingCharacters(in: .whitespaces)
            paragraph.removeAll()
            if !text.isEmpty { blocks.append(.paragraph(text)) }
        }
        func flushQuote() {
            let text = quote.joined(separator: " ").trimmingCharacters(in: .whitespaces)
            quote.removeAll()
            if !text.isEmpty { blocks.append(.quote(text)) }
        }
        func flushList() {
            guard !listItems.isEmpty else { return }
            blocks.append(.list(items: listItems, ordered: listOrdered, start: listStart))
            listItems.removeAll()
        }
        func flushAll() {
            flushParagraph()
            flushQuote()
            flushList()
        }

        var lines = source.components(separatedBy: .newlines)[...]

        while let line = lines.first {
            lines = lines.dropFirst()
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Fenced code. Consumes until the closing fence, or to the end — a stream
            // that has not yet emitted its closing fence still renders as code rather
            // than dumping raw backticks into the prose.
            if trimmed.hasPrefix("```") {
                flushAll()
                let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var body: [String] = []
                while let next = lines.first {
                    lines = lines.dropFirst()
                    if next.trimmingCharacters(in: .whitespaces).hasPrefix("```") { break }
                    body.append(next)
                }
                blocks.append(.code(language: language.isEmpty ? nil : language,
                                    body: body.joined(separator: "\n")))
                continue
            }

            if trimmed.isEmpty {
                flushAll()
                continue
            }

            // A rule, but only if it is not a table's separator row.
            if trimmed.allSatisfy({ $0 == "-" || $0 == "*" || $0 == "_" }), trimmed.count >= 3 {
                flushAll()
                blocks.append(.rule)
                continue
            }

            if trimmed.hasPrefix("#") {
                let hashes = trimmed.prefix { $0 == "#" }.count
                if hashes <= 6, trimmed.dropFirst(hashes).hasPrefix(" ") {
                    flushAll()
                    blocks.append(.heading(
                        level: hashes,
                        text: String(trimmed.dropFirst(hashes)).trimmingCharacters(in: .whitespaces)
                    ))
                    continue
                }
            }

            // A table needs a header row followed by a separator of dashes and pipes.
            if trimmed.hasPrefix("|"),
               let separator = lines.first?.trimmingCharacters(in: .whitespaces),
               separator.hasPrefix("|"),
               separator.allSatisfy({ "|-: ".contains($0) }) {
                flushAll()
                lines = lines.dropFirst()
                let header = cells(trimmed)
                var rows: [[String]] = []
                while let next = lines.first,
                      next.trimmingCharacters(in: .whitespaces).hasPrefix("|") {
                    lines = lines.dropFirst()
                    rows.append(cells(next.trimmingCharacters(in: .whitespaces)))
                }
                blocks.append(.table(header: header, rows: rows))
                continue
            }

            if trimmed.hasPrefix(">") {
                flushParagraph()
                flushList()
                quote.append(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces))
                continue
            }

            if let item = bulletItem(trimmed) {
                flushParagraph()
                flushQuote()
                if !listItems.isEmpty && listOrdered { flushList() }
                listOrdered = false
                listItems.append(item)
                continue
            }

            if let (number, item) = orderedItem(trimmed) {
                flushParagraph()
                flushQuote()
                if !listItems.isEmpty && !listOrdered { flushList() }
                if listItems.isEmpty { listStart = number }
                listOrdered = true
                listItems.append(item)
                continue
            }

            flushQuote()
            flushList()
            paragraph.append(trimmed)
        }

        flushAll()
        return blocks
    }

    private static func cells(_ row: String) -> [String] {
        row.split(separator: "|", omittingEmptySubsequences: false)
            .dropFirst()
            .dropLast()
            .map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func bulletItem(_ line: String) -> String? {
        for marker in ["- ", "* ", "+ "] where line.hasPrefix(marker) {
            return String(line.dropFirst(marker.count))
        }
        return nil
    }

    private static func orderedItem(_ line: String) -> (Int, String)? {
        let digits = line.prefix { $0.isNumber }
        guard !digits.isEmpty, let number = Int(digits) else { return nil }
        let rest = line.dropFirst(digits.count)
        guard rest.hasPrefix(". ") || rest.hasPrefix(") ") else { return nil }
        return (number, String(rest.dropFirst(2)))
    }
}

// MARK: - Inline

enum MarkdownInline {
    /// Inline spans only. Block structure is handled above, so `.inlineOnly` is the
    /// correct parse here — and it is also the one `Text` actually honours.
    static func attributed(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: true,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        var string = (try? AttributedString(markdown: text, options: options))
            ?? AttributedString(text)

        // Give code spans a fill and a monospaced face. `AttributedString` marks them
        // but applies no styling, so `foo` was previously indistinguishable from
        // surrounding prose — the one place the web shell was visibly ahead.
        for run in string.runs where run.inlinePresentationIntent?.contains(.code) == true {
            string[run.range].font = Typo.monoSmall
            string[run.range].backgroundColor = Palette.codeFill.color
        }
        for run in string.runs where run.link != nil {
            string[run.range].foregroundColor = Palette.accent.color
            string[run.range].underlineStyle = .single
        }
        return string
    }
}

// MARK: - Rendering

struct MarkdownText: View {
    private let blocks: [MarkdownBlock]

    init(_ text: String) {
        blocks = MarkdownParser.parse(text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            // Indices, not content hashes. The old code keyed blocks on the first 24
            // characters of their text, which collided across common openings and —
            // worse — changed on every streaming delta, tearing down and rebuilding
            // the view, destroying any active text selection and re-parsing the whole
            // message each frame.
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
    }

    @ViewBuilder
    private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            Text(MarkdownInline.attributed(text))
                .dsHeading(level <= 1 ? Typo.heading : level == 2 ? Typo.subhead : Typo.bodyBold)
                .padding(.top, Space.xs)

        case .paragraph(let text):
            Text(MarkdownInline.attributed(text))
                .dsProse()
                .fixedSize(horizontal: false, vertical: true)

        case .list(let items, let ordered, let start):
            VStack(alignment: .leading, spacing: Space.xs) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                        Text(ordered ? "\(start + index)." : "•")
                            .font(Typo.body)
                            .foregroundStyle(.dsMuted)
                            .monospacedDigit()
                            // A fixed gutter keeps every item's text on the same left
                            // edge, which is what makes a list read as a list.
                            .frame(minWidth: ordered ? 20 : 12, alignment: .trailing)
                        Text(MarkdownInline.attributed(item))
                            .dsProse()
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

        case .quote(let text):
            Text(MarkdownInline.attributed(text))
                .font(Typo.body)
                .lineSpacing(Space.xs)
                .foregroundStyle(.dsMuted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, Space.m)
                .overlay(alignment: .leading) {
                    Rectangle()
                        .fill(.dsBorder)
                        .frame(width: Metric.hairline * 2)
                }

        case .code(let language, let body):
            CodeBlock(language: language, code: body)

        case .table(let header, let rows):
            MarkdownTable(header: header, rows: rows)

        case .rule:
            Rectangle()
                .fill(.dsBorder)
                .frame(height: Metric.hairline)
                .padding(.vertical, Space.xs)
        }
    }
}

/// A table as a real grid, scrollable sideways rather than wrapped.
private struct MarkdownTable: View {
    let header: [String]
    let rows: [[String]]

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: Space.m, verticalSpacing: Space.s) {
                GridRow {
                    ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
                        Text(cell).font(Typo.bodyBold).foregroundStyle(.dsText)
                    }
                }
                Divider().overlay(.dsBorder).gridCellColumns(max(header.count, 1))
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                            Text(MarkdownInline.attributed(cell))
                                .font(Typo.body)
                                .foregroundStyle(.dsText)
                        }
                    }
                }
            }
            .padding(Space.m)
        }
        .well()
    }
}

/// A fenced code block.
///
/// The horizontal `ScrollView` no longer carries `.frame(maxWidth: .infinity)` on its
/// content: under an unbounded width proposal that resolved to the *proposed* width,
/// so long lines wrapped mid-token and the scroller never appeared — defeating the
/// entire point of the container.
struct CodeBlock: View {
    let language: String?
    let code: String

    @State private var didCopy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                SectionLabel(language?.isEmpty == false ? language! : "text")
                Spacer()
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(code, forType: .string)
                    didCopy = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { didCopy = false }
                } label: {
                    Label(didCopy ? "Copied" : "Copy",
                          systemImage: didCopy ? "checkmark" : "doc.on.doc")
                        .font(Typo.micro)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.dsMuted)
                .accessibilityLabel("Copy code")
            }
            .padding(.horizontal, Space.m)
            .padding(.vertical, Space.s)

            Divider().overlay(.dsBorder)

            ScrollView(.horizontal) {
                Text(code)
                    .font(Typo.monoSmall)
                    .foregroundStyle(.dsText)
                    .textSelection(.enabled)
                    .padding(Space.m)
            }
        }
        .well()
    }
}

/// The all-caps label over a code block or payload dump.
struct SectionLabel: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text).dsEyebrow()
    }
}
