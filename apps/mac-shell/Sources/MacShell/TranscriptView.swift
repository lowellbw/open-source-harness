import AppKit
import SwiftUI

/// The conversation itself.
///
/// A plain `ScrollView` + `LazyVStack` rather than `List`. `List` on macOS brings row
/// selection, alternating backgrounds and inset grouping that all have to be turned
/// off again, and its row height caching fights text that grows a character at a time
/// while a turn streams.
struct TranscriptView: View {
    @EnvironmentObject private var conversation: ConversationStore

    private let bottomAnchor = "transcript.bottom"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Space.xl) {
                    if conversation.turns.isEmpty {
                        EmptyTranscript()
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
                .frame(maxWidth: Layout.contentMaxWidth, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.horizontal, Space.xl)
                .padding(.vertical, Space.xl)
            }
            .background(.dsCanvas)
            .dsScrollEdge()
            .layoutProbe("transcript")
            // Follow the reply as it grows.
            //
            // This used to scroll the *user's* message to the top of the viewport once
            // and never move again, so any answer longer than a screen scrolled itself
            // out of sight while the user watched the top of it. The bottom anchor was
            // declared and given an id, and then never referenced by any `scrollTo`.
            .onChange(of: conversation.scrollAnchor) { _, _ in scroll(proxy) }
            .onChange(of: conversation.turns.last?.text) { _, _ in scroll(proxy) }
            .onChange(of: conversation.turns.count) { _, _ in scroll(proxy) }
        }
    }

    private func scroll(_ proxy: ScrollViewProxy) {
        withAnimation(Motion.scroll) {
            proxy.scrollTo(bottomAnchor, anchor: .bottom)
        }
    }
}

private struct EmptyTranscript: View {
    @EnvironmentObject private var conversation: ConversationStore

    /// The one sanctioned large glyph in the app, and the only place a point size is
    /// allowed — scaled, so it still tracks the user's text size.
    @ScaledMetric(relativeTo: .largeTitle) private var glyph: CGFloat = 34

    var body: some View {
        VStack(spacing: Space.m) {
            Image(systemName: "square.stack.3d.up")
                .font(.system(size: glyph, weight: .light))
                .foregroundStyle(.dsMuted)
                .opacity(0.5)
            Text("Agentic Workspace").dsHeading(Typo.display)
            Text("Ask for something. The agent works in a sandboxed folder and shows you every tool it runs.")
                .font(Typo.secondary)
                .foregroundStyle(.dsMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            if let model = conversation.currentModel {
                Text("\(model.alias) · \(Format.compactTokens(model.contextWindow)) context")
                    .font(Typo.micro)
                    .foregroundStyle(.dsMuted)
            }
        }
        .frame(maxWidth: .infinity)
        // Centred rather than pinned 84pt from the top, where it floated in the upper
        // quarter of an 860pt window with 600pt of void beneath it.
        .padding(.vertical, Space.xxl * 3)
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

/// The user's message: a right-aligned bubble with a solid accent fill.
///
/// The asymmetry between this and the bare assistant block is the defining visual
/// choice of the thread, and it only works if the bubble is *filled*. It used to be
/// `accentColor.opacity(0.14)` with a 0.22 border and primary text — a washed-out box
/// that, under a Graphite system accent, was indistinguishable from the notice rows
/// around it.
private struct UserBubble: View {
    let text: String

    var body: some View {
        HStack(spacing: 0) {
            // 85% of the column, without a GeometryReader: the column is already
            // capped, so a fixed minimum gutter is the same constraint and costs
            // nothing in a view that re-lays-out on every streaming delta.
            Spacer(minLength: Layout.bubbleGutter)
            Text(text)
                .font(Typo.body)
                .lineSpacing(Space.xs)
                .foregroundStyle(.dsOnAccent)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, Metric.bubbleH)
                .padding(.vertical, Space.s)
                .background(.dsAccent, in: Radius.shape(Radius.surface))
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You said: \(text)")
    }
}

/// A compaction or model-switch notice. Centred and quiet, with no card — it is not a
/// peer of the tool cards around it, and giving it the same chrome made it read as one.
private struct NoticeRow: View {
    let text: String
    let symbol: String

    var body: some View {
        HStack(spacing: Space.xs) {
            Image(systemName: symbol)
            Text(text)
                // Without this the `Text` truncates to one line inside an `HStack`
                // rather than wrapping, and a compaction notice is always long.
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(Typo.micro)
        .foregroundStyle(.dsMuted)
        .frame(maxWidth: .infinity)
        .padding(.vertical, Space.xs)
        .accessibilityElement(children: .combine)
    }
}

private struct AssistantTurn: View {
    let turn: Turn

    var body: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            if !turn.reasoning.isEmpty {
                ReasoningDisclosure(id: turn.id, text: turn.reasoning)
            }

            ForEach(turn.tools) { tool in
                ToolCallRow(tool: tool)
            }

            if !turn.text.isEmpty {
                MarkdownText(turn.text)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Reasoning

/// Collapsed by default and labelled as the model's own working.
///
/// It is shown at all because a turn that spends thirty seconds thinking and then says
/// one sentence looks broken otherwise. It is collapsed because it is a trace, not an
/// explanation, and presenting it as an explanation claims more than the model can
/// support.
private struct ReasoningDisclosure: View {
    @EnvironmentObject private var conversation: ConversationStore
    let id: String
    let text: String

    private var isExpanded: Bool { conversation.expandedReasoning.contains(id) }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Button {
                withAnimation(Motion.disclose) {
                    if isExpanded {
                        conversation.expandedReasoning.remove(id)
                    } else {
                        conversation.expandedReasoning.insert(id)
                    }
                }
            } label: {
                HStack(spacing: Space.xs) {
                    Image(systemName: "chevron.right")
                        .imageScale(.small)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    Text("Reasoning")
                }
                .font(Typo.caption)
                .foregroundStyle(.dsMuted)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Reasoning")
            .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")

            if isExpanded {
                Text(text)
                    .font(Typo.secondary)
                    .lineSpacing(Space.xs)
                    .foregroundStyle(.dsMuted)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, Space.m)
                    .overlay(alignment: .leading) {
                        Rectangle()
                            .fill(.dsBorder)
                            .frame(width: Metric.hairline * 2)
                    }
            }
        }
    }
}

// MARK: - Tool calls

private struct ToolCallRow: View {
    @EnvironmentObject private var conversation: ConversationStore
    let tool: ToolInvocation

    private var isExpanded: Bool { conversation.expandedTools.contains(tool.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(Motion.disclose) {
                    if isExpanded {
                        conversation.expandedTools.remove(tool.id)
                    } else {
                        conversation.expandedTools.insert(tool.id)
                    }
                }
            } label: {
                HStack(spacing: Space.s) {
                    StatusDot(color: dotColour, label: stateLabel)

                    Text(tool.name)
                        .font(Typo.mono)
                        .foregroundStyle(.dsText)
                        // MCP tool names are qualified and long; without this the row
                        // wrapped to three lines around a single-line status dot.
                        .lineLimit(1)
                        .truncationMode(.middle)

                    Text(stateLabel)
                        .font(Typo.caption)
                        .foregroundStyle(.dsMuted)
                        .breathing(tool.state == .running)
                        .layoutPriority(1)

                    if !tool.args.isEmpty {
                        Text(tool.args.inlineSummary)
                            .font(Typo.monoSmall)
                            .foregroundStyle(.dsMuted)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }

                    Spacer(minLength: Space.s)

                    // A word, not a chevron: it says what will happen rather than
                    // making you guess.
                    Text(isExpanded ? "hide" : "details")
                        .font(Typo.caption)
                        .foregroundStyle(.dsMuted)
                        .layoutPriority(1)
                }
                .padding(.horizontal, Space.m)
                .padding(.vertical, Space.s)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(tool.name), \(stateLabel)")
            .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
            .accessibilityHint("Shows the arguments and result of this tool call")

            if isExpanded {
                Divider().overlay(.dsBorder)
                VStack(alignment: .leading, spacing: Space.m) {
                    if !tool.args.isEmpty {
                        PayloadBlock(title: "Input", value: tool.args)
                    }
                    switch tool.state {
                    case .running:
                        Text("Waiting for the result…")
                            .font(Typo.caption)
                            .foregroundStyle(.dsMuted)
                            .breathing()
                    case .succeeded:
                        PayloadBlock(title: "Output", value: tool.result)
                    case .failed:
                        PayloadBlock(title: "Error", value: tool.result, isError: true)
                    }
                }
                .padding(Space.m)
            }
        }
        .card(radius: Radius.card,
              stroke: tool.state == .failed ? Palette.danger.opacity(0.4) : .dsBorder)
    }

    private var dotColour: Color {
        switch tool.state {
        case .running: return .dsMuted
        case .succeeded: return .dsOK
        case .failed: return .dsDanger
        }
    }

    private var stateLabel: String {
        switch tool.state {
        case .running: return "running…"
        case .succeeded: return "done"
        case .failed: return "error"
        }
    }
}

/// A tool's arguments or result.
///
/// Scrolls in **both** axes. The previous version put a `maxHeight: 220` clamp on a
/// `ScrollView(.horizontal)` — the wrong axis — so any result longer than about
/// fifteen lines was clipped, with no scroller and no way to reach it. Tool results
/// are file previews and stack traces; that is exactly the content that runs long.
private struct PayloadBlock: View {
    let title: String
    let value: JSONValue
    var isError = false

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            SectionLabel(title)
            ScrollView([.horizontal, .vertical]) {
                Text(value.prettyPrinted)
                    .font(Typo.monoSmall)
                    .foregroundStyle(isError ? .dsDanger : .dsText)
                    .textSelection(.enabled)
                    .padding(Space.m)
            }
            .frame(maxHeight: Metric.payloadMaxHeight)
            .well()
        }
    }
}

// MARK: - Status

/// The one streaming indicator.
///
/// There used to be three at once for a single state: a spinner in the toolbar pill, a
/// spinner-plus-label here, and three "typing" dots below — the last of which never
/// animated at all, because `.opacity()` interpolates between resolved endpoints
/// rather than re-evaluating `sin()` per frame, and with equal endpoints and
/// `autoreverses: false` the animation was a no-op.
private struct StatusLine: View {
    let state: AgentState

    var body: some View {
        HStack(spacing: Space.s) {
            StatusDot(color: .dsMuted, label: state.label)
            Text(state.label)
                .font(Typo.caption)
                .foregroundStyle(.dsMuted)
        }
        .breathing()
        .accessibilityElement(children: .combine)
        .accessibilityLabel(state.label)
    }
}
