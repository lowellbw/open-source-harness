import Foundation

/// The Swift side of `@workspace/protocol`.
///
/// A hand-written mirror rather than anything generated. The union is small, it
/// changes rarely, and a generator would be a build-time dependency and a second
/// toolchain for the sake of about a hundred lines. What matters is that this file
/// is the *only* place the wire format is known: nothing downstream parses JSON.
///
/// Decoding is deliberately lenient in one direction and strict in the other. An
/// unknown `type` decodes to `.unknown` rather than throwing, because a sidecar
/// newer than the app must not take the transcript down; a *known* type with a
/// malformed payload does throw, because that is a bug worth seeing.
enum WorkspaceEvent {
    case runStarted(threadId: String)
    case runFinished(reason: RunEndReason)
    case runError(message: String)
    case status(AgentState)

    case messageStarted(messageId: String)
    case messageDelta(messageId: String, delta: String)
    case messageFinished(messageId: String)

    case reasoningDelta(messageId: String, delta: String)

    case toolCallStarted(toolCallId: String, name: String, args: JSONValue)
    case toolCallFinished(toolCallId: String, result: JSONValue, isError: Bool)

    case approvalRequested(ApprovalRequest)
    case approvalResolved(approvalId: String, decision: ApprovalDecision)

    /// One model request inside a turn. A turn that calls three tools is four of
    /// these, and the per-step cost is the thing that explains a surprising bill.
    case stepStarted(stepNumber: Int, activeTools: [String]?)
    case stepFinished(StepReport)

    /// A read-only research scout. Its own stream deliberately never crosses the
    /// boundary — forwarding it would put the scout's transcript in front of the
    /// reader, which is the cost the scout exists to avoid.
    case subagentStarted(subagentId: String, task: String)
    case subagentFinished(SubagentReport)

    /// A page the model cited. Provider-side search produces no tool call at all,
    /// so this event is the only trace — without it a searched answer is
    /// indistinguishable from an asserted one.
    case sourceCited(messageId: String, url: String, title: String)

    case contextCompacted(Compaction)
    case modelSwitched(from: String, to: String, atCompactionBoundary: Bool)
    case costUpdated(run: CostBuckets, session: CostBuckets, delta: CostBuckets, model: String)
    case fileChanged(path: String, op: FileOperation)

    /// A type this build does not know about. Carried so it can be logged.
    case unknown(type: String)

    /// The sentinel the chat route writes when the turn is over. Not part of the
    /// protocol union — it is the SSE stream's own end marker.
    case done
}

enum AgentState: String, Decodable {
    case idle, thinking
    case callingTool = "calling_tool"
    case awaitingApproval = "awaiting_approval"
    case compacting

    /// Sentence case, because it is shown to a person, not logged.
    var label: String {
        switch self {
        case .idle: return "Ready"
        case .thinking: return "Thinking"
        case .callingTool: return "Running a tool"
        case .awaitingApproval: return "Waiting for you"
        case .compacting: return "Compacting context"
        }
    }

    var symbol: String {
        switch self {
        case .idle: return "circle.fill"
        case .thinking: return "ellipsis"
        case .callingTool: return "wrench.and.screwdriver"
        case .awaitingApproval: return "hand.raised"
        case .compacting: return "arrow.down.right.and.arrow.up.left"
        }
    }
}

enum RunEndReason: String, Decodable {
    case complete, aborted, error
    case budgetExceeded = "budget_exceeded"
}

enum ApprovalDecision: String, Codable {
    case allow, deny
}

enum FileOperation: String, Decodable {
    case created, modified, deleted
}

struct ApprovalRequest: Identifiable, Equatable {
    let approvalId: String
    let toolCallId: String
    let reason: String
    let irreversible: Bool
    let payload: JSONValue

    var id: String { approvalId }
}

struct StepReport: Equatable {
    let stepNumber: Int
    let cost: CostBuckets
    let toolCalls: Int
    let durationMs: Double?
    /// Absent from a mocked provider and present from a live one, so optional in the
    /// protocol rather than assumed.
    let finishReason: String?
}

struct SubagentReport: Equatable {
    enum StoppedBy: String, Decodable {
        case complete
        case budgetExceeded = "budget_exceeded"
        case error
    }

    let subagentId: String
    let cost: CostBuckets
    let stoppedBy: StoppedBy
    let reportChars: Int
}

struct Compaction: Equatable {
    let strategy: String
    let beforeMessages: Int
    let afterMessages: Int
    let beforeTokens: Int
    let afterTokens: Int
}

/// The four-bucket cost model, mirroring `costBucketsSchema`.
///
/// `reasoningTokens` is a subset of `outputTokens`, never an addition to it — every
/// provider priced here reports reasoning inside its completion count. Adding them
/// would bill reasoning models twice.
struct CostBuckets: Codable, Equatable {
    var uncachedInputTokens: Int = 0
    var cacheWriteTokens: Int = 0
    var cacheReadTokens: Int = 0
    var outputTokens: Int = 0
    var reasoningTokens: Int = 0
    /// Server-side web searches, counted rather than measured in tokens.
    ///
    /// Deliberately **not** part of `totalTokens` — it is a count, priced per call
    /// at roughly a cent, which is more than a whole cheap-tier turn. Leaving it out
    /// made `usd` impossible to reconcile against the token breakdown: five searches
    /// is five cents with nothing to attribute it to.
    var webSearches: Int = 0
    var usd: Double = 0

    static let zero = CostBuckets()

    var totalTokens: Int {
        uncachedInputTokens + cacheWriteTokens + cacheReadTokens + outputTokens
    }

    /// Declared explicitly: writing `init(from:)` by hand suppresses the synthesis
    /// that would otherwise generate this too.
    private enum CodingKeys: String, CodingKey {
        case uncachedInputTokens, cacheWriteTokens, cacheReadTokens
        case outputTokens, reasoningTokens, webSearches, usd
    }

    init() {}

    /// Written out rather than synthesised. Swift's synthesised `Decodable` does not
    /// consult a property's default value — it emits `decode`, not `decodeIfPresent`
    /// — so a payload carrying only `usd` fails the whole decode, and the model list
    /// disappears because the cost meter was one field short. Every bucket is
    /// independently optional here, and a missing one means zero.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        uncachedInputTokens = try container.decodeIfPresent(Int.self, forKey: .uncachedInputTokens) ?? 0
        cacheWriteTokens = try container.decodeIfPresent(Int.self, forKey: .cacheWriteTokens) ?? 0
        cacheReadTokens = try container.decodeIfPresent(Int.self, forKey: .cacheReadTokens) ?? 0
        outputTokens = try container.decodeIfPresent(Int.self, forKey: .outputTokens) ?? 0
        reasoningTokens = try container.decodeIfPresent(Int.self, forKey: .reasoningTokens) ?? 0
        webSearches = try container.decodeIfPresent(Int.self, forKey: .webSearches) ?? 0
        usd = try container.decodeIfPresent(Double.self, forKey: .usd) ?? 0
    }
}

// MARK: - Decoding

extension WorkspaceEvent: Decodable {
    private enum CodingKeys: String, CodingKey {
        case type, threadId, reason, message, state, messageId, delta
        case toolCallId, name, args, result, isError
        case approvalId, decision, irreversible, payload
        case strategy, beforeMessages, afterMessages, beforeTokens, afterTokens
        case cost
        case from, to, atCompactionBoundary
        case run, session, path, op
        case model
        case stepNumber, activeTools, toolCalls, durationMs, finishReason
        case subagentId, task, stoppedBy, reportChars
        case url, title
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "run.started":
            self = .runStarted(threadId: try container.decode(String.self, forKey: .threadId))
        case "run.finished":
            self = .runFinished(reason: try container.decode(RunEndReason.self, forKey: .reason))
        case "run.error":
            self = .runError(message: try container.decode(String.self, forKey: .message))
        case "status":
            self = .status(try container.decode(AgentState.self, forKey: .state))

        case "message.started":
            self = .messageStarted(messageId: try container.decode(String.self, forKey: .messageId))
        case "message.delta":
            self = .messageDelta(
                messageId: try container.decode(String.self, forKey: .messageId),
                delta: try container.decode(String.self, forKey: .delta)
            )
        case "message.finished":
            self = .messageFinished(messageId: try container.decode(String.self, forKey: .messageId))

        case "reasoning.delta":
            self = .reasoningDelta(
                messageId: try container.decode(String.self, forKey: .messageId),
                delta: try container.decode(String.self, forKey: .delta)
            )
        case "reasoning.artifact":
            // Opaque provider state — a signed thinking block or a thought signature.
            // It is round-tripped by the core and must never be rendered, so the UI
            // deliberately has no case for it.
            self = .unknown(type: type)

        case "tool.call.started":
            self = .toolCallStarted(
                toolCallId: try container.decode(String.self, forKey: .toolCallId),
                name: try container.decode(String.self, forKey: .name),
                args: try container.decodeIfPresent(JSONValue.self, forKey: .args) ?? .null
            )
        case "tool.call.finished":
            self = .toolCallFinished(
                toolCallId: try container.decode(String.self, forKey: .toolCallId),
                result: try container.decodeIfPresent(JSONValue.self, forKey: .result) ?? .null,
                isError: try container.decodeIfPresent(Bool.self, forKey: .isError) ?? false
            )

        case "approval.requested":
            self = .approvalRequested(ApprovalRequest(
                approvalId: try container.decode(String.self, forKey: .approvalId),
                toolCallId: try container.decodeIfPresent(String.self, forKey: .toolCallId) ?? "",
                reason: try container.decode(String.self, forKey: .reason),
                irreversible: try container.decodeIfPresent(Bool.self, forKey: .irreversible) ?? true,
                payload: try container.decodeIfPresent(JSONValue.self, forKey: .payload) ?? .null
            ))
        case "approval.resolved":
            self = .approvalResolved(
                approvalId: try container.decode(String.self, forKey: .approvalId),
                decision: try container.decode(ApprovalDecision.self, forKey: .decision)
            )

        case "context.compacted":
            self = .contextCompacted(Compaction(
                strategy: try container.decode(String.self, forKey: .strategy),
                beforeMessages: try container.decode(Int.self, forKey: .beforeMessages),
                afterMessages: try container.decode(Int.self, forKey: .afterMessages),
                beforeTokens: try container.decode(Int.self, forKey: .beforeTokens),
                afterTokens: try container.decode(Int.self, forKey: .afterTokens)
            ))
        case "model.switched":
            self = .modelSwitched(
                from: try container.decode(String.self, forKey: .from),
                to: try container.decode(String.self, forKey: .to),
                atCompactionBoundary: try container.decodeIfPresent(Bool.self, forKey: .atCompactionBoundary) ?? false
            )
        case "cost.updated":
            self = .costUpdated(
                run: try container.decode(CostBuckets.self, forKey: .run),
                session: try container.decode(CostBuckets.self, forKey: .session),
                delta: try container.decodeIfPresent(CostBuckets.self, forKey: .delta) ?? CostBuckets(),
                model: try container.decodeIfPresent(String.self, forKey: .model) ?? ""
            )

        case "step.started":
            self = .stepStarted(
                stepNumber: try container.decode(Int.self, forKey: .stepNumber),
                activeTools: try container.decodeIfPresent([String].self, forKey: .activeTools)
            )
        case "step.finished":
            self = .stepFinished(StepReport(
                stepNumber: try container.decode(Int.self, forKey: .stepNumber),
                cost: try container.decodeIfPresent(CostBuckets.self, forKey: .cost) ?? CostBuckets(),
                toolCalls: try container.decodeIfPresent(Int.self, forKey: .toolCalls) ?? 0,
                durationMs: try container.decodeIfPresent(Double.self, forKey: .durationMs),
                finishReason: try container.decodeIfPresent(String.self, forKey: .finishReason)
            ))

        case "subagent.started":
            self = .subagentStarted(
                subagentId: try container.decode(String.self, forKey: .subagentId),
                task: try container.decode(String.self, forKey: .task)
            )
        case "subagent.finished":
            self = .subagentFinished(SubagentReport(
                subagentId: try container.decode(String.self, forKey: .subagentId),
                cost: try container.decodeIfPresent(CostBuckets.self, forKey: .cost) ?? CostBuckets(),
                stoppedBy: try container.decodeIfPresent(SubagentReport.StoppedBy.self, forKey: .stoppedBy) ?? .complete,
                reportChars: try container.decodeIfPresent(Int.self, forKey: .reportChars) ?? 0
            ))

        case "source.cited":
            self = .sourceCited(
                messageId: try container.decode(String.self, forKey: .messageId),
                url: try container.decode(String.self, forKey: .url),
                title: try container.decode(String.self, forKey: .title)
            )
        case "workspace.file.changed":
            self = .fileChanged(
                path: try container.decode(String.self, forKey: .path),
                op: try container.decode(FileOperation.self, forKey: .op)
            )

        case "__done":
            self = .done
        default:
            self = .unknown(type: type)
        }
    }
}

// MARK: - JSONValue

/// Just enough of a JSON tree to hold a tool's arguments and its result.
///
/// Tool payloads are genuinely unknown at compile time: they are whatever the tool
/// declared in its own schema, and MCP tools are discovered at runtime. Decoding
/// them into `[String: Any]` would mean an untyped dictionary crossing an actor
/// boundary; this is `Sendable` and `Equatable`, so it can sit inside view state
/// without either problem.
enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unrecognised JSON value")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    var isEmpty: Bool {
        switch self {
        case .null: return true
        case .object(let members): return members.isEmpty
        case .array(let elements): return elements.isEmpty
        case .string(let text): return text.isEmpty
        default: return false
        }
    }

    /// A single-line summary for a collapsed row: `path: "/data.csv", maxBytes: 4096`.
    /// Long enough to identify the call, short enough not to wrap.
    var inlineSummary: String {
        switch self {
        case .object(let members):
            return members.keys.sorted()
                .map { "\($0): \(members[$0]!.compact)" }
                .joined(separator: ", ")
        default:
            return compact
        }
    }

    private var compact: String {
        switch self {
        case .null: return "null"
        case .bool(let value): return value ? "true" : "false"
        case .number(let value):
            return value == value.rounded() && abs(value) < 1e15
                ? String(Int(value))
                : String(value)
        case .string(let text):
            let flattened = text.replacingOccurrences(of: "\n", with: "⏎")
            return flattened.count > 48 ? "\"\(flattened.prefix(48))…\"" : "\"\(flattened)\""
        case .array(let elements): return "[\(elements.count)]"
        case .object(let members): return "{\(members.count)}"
        }
    }

    /// Pretty-printed, for the expanded view. Keys are sorted so that re-rendering
    /// the same payload does not reshuffle the lines under the reader.
    var prettyPrinted: String {
        render(indent: 0)
    }

    private func render(indent: Int) -> String {
        let pad = String(repeating: "  ", count: indent)
        let inner = String(repeating: "  ", count: indent + 1)
        switch self {
        case .object(let members) where !members.isEmpty:
            let body = members.keys.sorted()
                .map { "\(inner)\"\($0)\": \(members[$0]!.render(indent: indent + 1))" }
                .joined(separator: ",\n")
            return "{\n\(body)\n\(pad)}"
        case .array(let elements) where !elements.isEmpty:
            let body = elements
                .map { "\(inner)\($0.render(indent: indent + 1))" }
                .joined(separator: ",\n")
            return "[\n\(body)\n\(pad)]"
        case .string(let text):
            // Multi-line strings are the common case for a tool result — a file
            // preview, a stack trace — and escaping them into one line is exactly
            // the thing that makes a result unreadable.
            return text.contains("\n") ? text : "\"\(text)\""
        default:
            return compact
        }
    }
}
