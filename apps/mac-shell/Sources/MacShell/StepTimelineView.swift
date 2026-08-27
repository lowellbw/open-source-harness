import AppKit
import SwiftUI

/// What a turn actually did, decomposed.
///
/// A turn that calls three tools is four model requests, and the UI showed that as
/// one undifferentiated wait — with the per-step cost, the thing that explains a
/// surprising bill, not recoverable afterwards at all.
///
/// It hides itself for a single-step turn with no subagents: there is nothing to
/// decompose, and the tool cards below already say what happened.
struct StepTimelineView: View {
    @EnvironmentObject private var conversation: ConversationStore
    let turnID: String
    let steps: [StepRow]
    let subagents: [SubagentRow]

    private var isExpanded: Bool { conversation.expandedTimelines.contains(turnID) }

    static func shouldShow(steps: [StepRow], subagents: [SubagentRow]) -> Bool {
        steps.count > 1 || !subagents.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if isExpanded {
                Divider().overlay(.dsBorder)
                VStack(alignment: .leading, spacing: Space.s) {
                    ForEach(steps) { StepRowView(step: $0) }
                    if !subagents.isEmpty {
                        Divider().overlay(.dsBorder)
                        ForEach(subagents) { SubagentRowView(subagent: $0) }
                    }
                }
                .padding(Space.m)
            }
        }
        .card(radius: Radius.card)
    }

    private var header: some View {
        Button {
            withAnimation(Motion.disclose) {
                if isExpanded {
                    conversation.expandedTimelines.remove(turnID)
                } else {
                    conversation.expandedTimelines.insert(turnID)
                }
            }
        } label: {
            HStack(spacing: Space.s) {
                Text("\(steps.count) step\(steps.count == 1 ? "" : "s")")
                    .foregroundStyle(.dsText)
                if !subagents.isEmpty {
                    Text("\(subagents.count) subagent\(subagents.count == 1 ? "" : "s")")
                        .foregroundStyle(.dsAccent)
                }
                if let duration = totalDuration {
                    Text(Format.duration(duration)).foregroundStyle(.dsMuted)
                }
                Text(Format.usd(totalCost)).foregroundStyle(.dsMuted).monospacedDigit()
                Spacer(minLength: Space.s)
                Text(isExpanded ? "hide" : "trace").foregroundStyle(.dsMuted)
            }
            .font(Typo.caption)
            .padding(.horizontal, Space.m)
            .padding(.vertical, Space.s)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Trace: \(steps.count) steps, \(subagents.count) subagents")
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
    }

    private var totalCost: Double {
        steps.reduce(0) { $0 + $1.usd } + subagents.reduce(0) { $0 + $1.usd }
    }

    /// Only steps that reported one. A turn still running has no total yet.
    private var totalDuration: Double? {
        let measured = steps.compactMap(\.durationMs)
        return measured.isEmpty ? nil : measured.reduce(0, +)
    }
}

private struct StepRowView: View {
    let step: StepRow

    var body: some View {
        HStack(spacing: Space.s) {
            // Displayed 1-based; the protocol counts from zero.
            Text("#\(step.number + 1)")
                .font(Typo.monoSmall)
                .foregroundStyle(.dsMuted)
                .monospacedDigit()
            StatusDot(color: step.finished ? .dsOK : .dsMuted,
                      label: step.finished ? "Finished" : "Running")
            Text(step.toolCalls == 0
                 ? "no tool calls"
                 : "\(step.toolCalls) tool call\(step.toolCalls == 1 ? "" : "s")")
                .foregroundStyle(.dsText)
            if let offered = step.offered {
                Text("\(offered) offered")
                    .foregroundStyle(.dsMuted)
                    .help("Tools sent to the model on this step")
            }
            Spacer(minLength: Space.s)
            if let duration = step.durationMs {
                Text(Format.duration(duration)).foregroundStyle(.dsMuted).monospacedDigit()
            }
            // Nothing rather than "$0.00" for a step still running: it has not cost
            // zero, it has not finished costing.
            Text(step.finished ? Format.microUsd(step.usd) : "")
                .foregroundStyle(.dsMuted)
                .monospacedDigit()
        }
        .font(Typo.caption)
        .accessibilityElement(children: .combine)
    }
}

/// A research scout.
///
/// Only the endpoints cross the boundary — a scout exists to keep its reading out of
/// the parent's context, and forwarding its whole stream would move that cost from
/// the model's context to the reader's attention rather than removing it.
private struct SubagentRowView: View {
    let subagent: SubagentRow

    var body: some View {
        VStack(alignment: .leading, spacing: Space.hair) {
            HStack(spacing: Space.s) {
                StatusDot(color: dotColour, label: stateLabel)
                Text("subagent").foregroundStyle(.dsAccent)
                Spacer(minLength: Space.s)
                if subagent.reportChars > 0 {
                    Text("\(Format.tokens(subagent.reportChars)) chars")
                        .foregroundStyle(.dsMuted)
                        .monospacedDigit()
                }
                Text(subagent.finished ? Format.microUsd(subagent.usd) : "")
                    .foregroundStyle(.dsMuted)
                    .monospacedDigit()
            }
            Text(subagent.task)
                .foregroundStyle(.dsMuted)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .help(subagent.task)
        }
        .font(Typo.caption)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Subagent, \(stateLabel): \(subagent.task)")
    }

    private var dotColour: Color {
        if subagent.failed { return .dsDanger }
        return subagent.finished ? .dsOK : .dsMuted
    }

    private var stateLabel: String {
        guard let stoppedBy = subagent.stoppedBy else { return "running" }
        return stoppedBy == "complete" ? "complete" : stoppedBy
    }
}

/// Pages the model cited.
///
/// Links rather than a tool card, because provider-side search leaves no tool call to
/// expand — and because the useful thing about a citation is being able to click it,
/// not being able to inspect the call that produced it.
struct CitationsView: View {
    let sources: [Citation]

    private let columns = [GridItem(.adaptive(minimum: 140, maximum: 260), spacing: Space.s)]

    var body: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: Space.s) {
            ForEach(sources) { source in
                Button {
                    guard let url = URL(string: source.url) else { return }
                    NSWorkspace.shared.open(url)
                } label: {
                    HStack(spacing: Space.xs) {
                        Image(systemName: "arrow.up.forward")
                            .imageScale(.small)
                            .foregroundStyle(.dsAccent)
                        Text(source.displayName)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .foregroundStyle(.dsText)
                    }
                    .font(Typo.micro)
                    .padding(.horizontal, Space.s)
                    .padding(.vertical, Space.xs)
                    .background(.dsSurface, in: Capsule())
                    .overlay(Capsule().strokeBorder(.dsBorder, lineWidth: Metric.hairline))
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .help(source.url)
                .accessibilityLabel("Source: \(source.displayName)")
                .accessibilityHint("Opens in your browser")
            }
        }
    }
}
