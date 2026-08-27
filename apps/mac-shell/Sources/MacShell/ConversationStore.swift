import Combine
import Foundation
import OSLog

/// One turn in the transcript.
///
/// A turn, not a message: the assistant's text, the reasoning that produced it and
/// the tools it called all belong to the same moment and are read together. Keeping
/// them in one value is also what lets a delta arriving after a tool call land on the
/// bubble it belongs to rather than opening a new one.
struct Turn: Identifiable, Equatable, Codable {
    enum Role: String, Equatable, Codable {
        case user
        case assistant
        /// Something the system did that the user needs to know about, and did not
        /// ask for — a compaction, a model switch.
        case notice
    }

    let id: String
    var role: Role
    var text: String = ""
    var reasoning: String = ""
    var tools: [ToolInvocation] = []
    var steps: [StepRow] = []
    var subagents: [SubagentRow] = []
    /// Pages the model cited, deduped by URL — one page cited for three separate
    /// claims should not produce three identical chips.
    var sources: [Citation] = []
    var isStreaming: Bool = false
    var symbol: String? = nil

    var isEmpty: Bool {
        text.isEmpty && reasoning.isEmpty && tools.isEmpty
            && steps.isEmpty && subagents.isEmpty && sources.isEmpty
    }
}

/// One model request inside a turn.
struct StepRow: Identifiable, Equatable, Codable {
    let number: Int
    var toolCalls: Int = 0
    var offered: Int?
    var durationMs: Double?
    var usd: Double = 0
    var finished: Bool = false

    var id: Int { number }
}

struct SubagentRow: Identifiable, Equatable, Codable {
    let id: String
    let task: String
    var usd: Double = 0
    var reportChars: Int = 0
    var stoppedBy: String?

    var finished: Bool { stoppedBy != nil }
    var failed: Bool { stoppedBy != nil && stoppedBy != "complete" }
}

struct Citation: Identifiable, Equatable, Codable {
    let url: String
    let title: String

    var id: String { url }

    /// What the chip shows when the page had no title.
    var displayName: String {
        if !title.isEmpty { return title }
        guard let host = URL(string: url)?.host else { return url }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }
}

struct ToolInvocation: Identifiable, Equatable, Codable {
    enum State: String, Equatable, Codable {
        case running, succeeded, failed
    }

    let id: String
    let name: String
    var args: JSONValue
    var result: JSONValue = .null
    var state: State = .running
}

/// Everything one workspace session shows, derived from the sidecar's event stream.
///
/// `@MainActor` for the same reason `SidecarController` is: every field here is read
/// by SwiftUI. The network work happens inside `WorkspaceAPI`, which is nonisolated,
/// so the actor hop is at the boundary and there is no lock anywhere.
@MainActor
final class ConversationStore: ObservableObject {
    @Published private(set) var turns: [Turn] = []
    @Published private(set) var status: AgentState = .idle
    @Published private(set) var isStreaming = false
    @Published private(set) var runCost: CostBuckets = .zero
    @Published private(set) var sessionCost: CostBuckets = .zero
    @Published private(set) var budgetRemaining: Double?

    @Published private(set) var models: [ModelInfo] = []
    @Published var selectedModel: String = "Standard"

    @Published private(set) var pendingApproval: ApprovalRequest?
    @Published private(set) var errorMessage: String?

    /// Which tool calls and reasoning blocks are expanded.
    ///
    /// Held here rather than as `@State` on the row. `LazyVStack` discards off-screen
    /// subviews and their state, so an expanded tool call silently re-collapsed the
    /// moment you scrolled past it and back — constant in any transcript longer than
    /// a screen.
    @Published var expandedTools: Set<String> = []
    @Published var expandedReasoning: Set<String> = []

    @Published private(set) var entries: [String: [DirEntry]] = [:]
    @Published private(set) var expandedDirectories: Set<String> = ["/"]
    @Published private(set) var connectors = ConnectorStatus()

    /// Bumped whenever the transcript grows in a way the view should scroll to.
    /// Scrolling on every delta fights the user when they have scrolled up to read;
    /// this only moves for a new turn.
    @Published private(set) var scrollAnchor: String?

    /// The conversation currently on screen. Every request carries it, and the
    /// sidecar gives each id its own workspace root — so this is not cosmetic, it is
    /// which folder the agent is working in.
    @Published private(set) var sessionID: String = "default"

    private var api: WorkspaceAPI?
    private var endpoint: SidecarEndpoint?
    private var turnTask: Task<Void, Never>?
    private let log = Logger(subsystem: AppInfo.subsystem, category: "conversation")

    /// The archive. `unowned` because `AppServices` owns both objects for the whole
    /// life of the process, so there is no window in which this can dangle, and a
    /// strong reference here would be a cycle.
    private unowned let library: SessionLibrary

    /// The id of the assistant turn the current run's deltas belong to. The server
    /// assigns the real message id at `message.started`, which is after the bubble is
    /// already on screen, so the placeholder is re-keyed once when it arrives.
    private var boundAssistantTurn: String?

    var canSend: Bool { api != nil && !isStreaming }

    /// True when this conversation's transcript outlived the sidecar that produced
    /// it, so the agent no longer holds its context.
    var isArchived: Bool {
        library.sessions.first { $0.id == sessionID }?.contextLost ?? false
    }
    var currentModel: ModelInfo? { models.first { $0.alias == selectedModel } }

    init(library: SessionLibrary) {
        self.library = library
        // Adopt whatever the library selected rather than defaulting to "default".
        //
        // These two were initialised independently and never reconciled: the library
        // selects the most recent session, the store started on a literal "default",
        // and the window title came from the library while the transcript came from
        // the store. Every launch with existing history therefore showed a
        // highlighted, titled conversation with an empty transcript underneath it.
        if let selected = library.selectedID {
            sessionID = selected
            turns = library.transcript(for: selected)
            scrollAnchor = turns.last?.id
        }
    }

    #if DEBUG
    /// Injects canned state for the Design Gallery.
    ///
    /// The states that matter most to a redesign are the awkward ones to reach by
    /// hand — a failed tool, a blocking approval, a compaction notice, prose with
    /// real Markdown — and reaching them against the live sidecar costs money and
    /// twenty seconds of waiting per screenshot. The data lives in
    /// `DesignFixture.swift`; this is only the seam that lets it in, because `turns`
    /// and friends are `private(set)` and an extension in another file cannot write
    /// them.
    func applyDesignFixture(_ fixture: DesignFixture) {
        turns = fixture.turns
        status = fixture.status
        isStreaming = fixture.isStreaming
        models = fixture.models
        selectedModel = fixture.selectedModel
        entries = fixture.entries
        connectors = fixture.connectors
        errorMessage = fixture.errorMessage
        pendingApproval = fixture.pendingApproval
        runCost = fixture.runCost
        sessionCost = fixture.sessionCost
        budgetRemaining = fixture.budgetRemaining
    }
    #endif

    // MARK: - Endpoint and session lifecycle

    /// Called whenever the sidecar's endpoint changes — first launch, and every
    /// restart, because the port moves each time.
    func connect(to endpoint: SidecarEndpoint?) {
        guard self.endpoint != endpoint else { return }
        self.endpoint = endpoint
        rebuildClient()
    }

    /// Switches the conversation on screen.
    ///
    /// The outgoing transcript is written first. Losing the last few turns of a
    /// conversation because you clicked another one is the kind of data loss people
    /// never forgive an app for, and the write is cheap.
    func open(_ summary: SessionSummary) {
        guard summary.id != sessionID else { return }
        persist()
        cancelTurn()

        sessionID = summary.id
        turns = library.transcript(for: summary.id)
        selectedModel = summary.modelAlias
        runCost = .zero
        errorMessage = nil
        pendingApproval = nil
        status = .idle
        expandedTools = []
        expandedReasoning = []
        entries = [:]
        expandedDirectories = ["/"]
        scrollAnchor = turns.last?.id

        rebuildClient()
    }

    private func rebuildClient() {
        cancelTurn()
        guard let endpoint else {
            api = nil
            return
        }
        // A fresh client per (endpoint, session). The port moves on every sidecar
        // restart, and a pooled connection to the old one fails in a way that reads
        // as a server bug.
        api = WorkspaceAPI(endpoint: endpoint, sessionID: sessionID)
        errorMessage = nil
        Task { await refreshAll() }
    }

    /// Writes the current transcript to the archive.
    func persist() {
        guard !turns.isEmpty else { return }
        library.save(
            id: sessionID,
            turns: turns,
            modelAlias: selectedModel,
            sessionUsd: sessionCost.usd
        )
    }

    func refreshAll() async {
        async let models: Void = refreshModels()
        async let files: Void = refreshFiles(path: "/")
        async let connectors: Void = refreshConnectors()
        _ = await (models, files, connectors)
    }

    func refreshModels() async {
        guard let api else { return }
        do {
            let response = try await api.models()
            models = response.models
            // The server's idea of the current model wins on first load; after that
            // the picker is the user's and a refresh must not yank it back.
            if models.first(where: { $0.alias == selectedModel }) == nil {
                selectedModel = response.current
            }
            runCost = response.totals.run
            sessionCost = response.totals.session
            budgetRemaining = response.budget?.sessionUsd
        } catch {
            log.error("models: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Sending

    func send(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let api, !isStreaming else { return }

        errorMessage = nil
        isStreaming = true
        status = .thinking

        let userTurn = Turn(id: "user-\(UUID().uuidString)", role: .user, text: trimmed)
        let placeholder = "assistant-\(UUID().uuidString)"
        turns.append(userTurn)
        turns.append(Turn(id: placeholder, role: .assistant, isStreaming: true))
        boundAssistantTurn = placeholder
        scrollAnchor = placeholder

        let model = selectedModel
        turnTask = Task { [weak self] in
            do {
                for try await event in api.chat(message: trimmed, modelAlias: model) {
                    guard let self, !Task.isCancelled else { return }
                    self.apply(event)
                }
            } catch {
                self?.errorMessage = error.localizedDescription
            }
            guard let self else { return }
            self.finishTurn()
        }
    }

    /// Abandons the stream. The turn keeps running on the server — the agent may be
    /// mid-tool-call with real side effects, and there is no route to interrupt it —
    /// so this says "stop showing me", not "stop working", and the UI says so too.
    func cancelTurn() {
        turnTask?.cancel()
        turnTask = nil
        finishTurn()
    }

    private func finishTurn() {
        guard isStreaming else { return }
        isStreaming = false
        status = .idle
        boundAssistantTurn = nil
        mutateTurns { turns in
            for index in turns.indices where turns[index].isStreaming {
                turns[index].isStreaming = false
            }
            // A run that died before the assistant said anything leaves an empty
            // bubble behind; an empty bubble reads as a bug.
            turns.removeAll { $0.role == .assistant && $0.isEmpty && !$0.isStreaming }
        }
        persist()
        Task { await refreshModels(); await refreshFiles(path: "/") }
    }

    // MARK: - Event application

    private func apply(_ event: WorkspaceEvent) {
        switch event {
        case .status(let state):
            status = state

        case .messageStarted(let messageId):
            // Re-key the placeholder to the server's id so later deltas addressed by
            // messageId find it.
            if let placeholder = boundAssistantTurn, let index = index(of: placeholder) {
                var turn = turns[index]
                turn = Turn(id: messageId, role: .assistant, text: turn.text,
                            reasoning: turn.reasoning, tools: turn.tools,
                            steps: turn.steps, subagents: turn.subagents,
                            sources: turn.sources, isStreaming: true)
                turns[index] = turn
                boundAssistantTurn = messageId
            }

        case .messageDelta(let messageId, let delta):
            appendToAssistant(messageId) { $0.text += delta }

        case .reasoningDelta(let messageId, let delta):
            appendToAssistant(messageId) { $0.reasoning += delta }

        case .messageFinished(let messageId):
            if let index = index(of: messageId) { turns[index].isStreaming = false }

        case .toolCallStarted(let toolCallId, let name, let args):
            appendToAssistant(nil) { turn in
                turn.tools.append(ToolInvocation(id: toolCallId, name: name, args: args))
            }

        case .toolCallFinished(let toolCallId, let result, let isError):
            mutateTurns { turns in
                for turnIndex in turns.indices {
                    guard let toolIndex = turns[turnIndex].tools.firstIndex(where: { $0.id == toolCallId })
                    else { continue }
                    turns[turnIndex].tools[toolIndex].result = result
                    turns[turnIndex].tools[toolIndex].state = isError ? .failed : .succeeded
                    return
                }
            }
            Task { await refreshFiles(path: "/") }

        case .approvalRequested(let request):
            pendingApproval = request
            status = .awaitingApproval

        case .approvalResolved:
            pendingApproval = nil

        case .stepStarted(let number, let activeTools):
            appendToAssistant(nil) { turn in
                guard !turn.steps.contains(where: { $0.number == number }) else { return }
                turn.steps.append(StepRow(number: number, offered: activeTools?.count))
            }

        case .stepFinished(let report):
            appendToAssistant(nil) { turn in
                guard let index = turn.steps.firstIndex(where: { $0.number == report.stepNumber })
                else { return }
                turn.steps[index].toolCalls = report.toolCalls
                turn.steps[index].durationMs = report.durationMs
                turn.steps[index].usd = report.cost.usd
                turn.steps[index].finished = true
            }

        case .subagentStarted(let id, let task):
            appendToAssistant(nil) { turn in
                guard !turn.subagents.contains(where: { $0.id == id }) else { return }
                turn.subagents.append(SubagentRow(id: id, task: task))
            }

        case .subagentFinished(let report):
            appendToAssistant(nil) { turn in
                guard let index = turn.subagents.firstIndex(where: { $0.id == report.subagentId })
                else { return }
                turn.subagents[index].usd = report.cost.usd
                turn.subagents[index].reportChars = report.reportChars
                turn.subagents[index].stoppedBy = report.stoppedBy.rawValue
            }

        case .sourceCited(let messageId, let url, let title):
            appendToAssistant(messageId) { turn in
                guard !turn.sources.contains(where: { $0.url == url }) else { return }
                turn.sources.append(Citation(url: url, title: title))
            }

        case .contextCompacted(let compaction):
            let before = Self.tokens.string(from: NSNumber(value: compaction.beforeTokens)) ?? "\(compaction.beforeTokens)"
            let after = Self.tokens.string(from: NSNumber(value: compaction.afterTokens)) ?? "\(compaction.afterTokens)"
            appendNotice(
                "Context compacted (\(compaction.strategy)) — "
                + "\(compaction.beforeMessages) messages / \(before) tokens "
                + "→ \(compaction.afterMessages) / \(after)",
                symbol: "arrow.down.right.and.arrow.up.left"
            )

        case .modelSwitched(let from, let to, let atBoundary):
            selectedModel = to
            appendNotice(
                "Switched from \(from) to \(to)"
                + (atBoundary ? ", at a compaction boundary." : "."),
                symbol: "arrow.triangle.swap"
            )

        case .costUpdated(let run, let session, _, _):
            runCost = run
            sessionCost = session

        case .fileChanged:
            Task { await refreshFiles(path: "/") }

        case .runError(let message):
            errorMessage = message

        case .runFinished(let reason):
            if reason == .budgetExceeded {
                errorMessage = "The run stopped because the session budget was exhausted."
            } else if reason == .aborted {
                appendNotice("The run was stopped.", symbol: "stop.circle")
            }

        case .runStarted, .done:
            break

        case .unknown(let type):
            log.debug("ignoring unknown event \(type, privacy: .public)")
        }
    }

    private func index(of id: String) -> Int? {
        turns.firstIndex { $0.id == id }
    }

    /// Applies a mutation to the assistant turn a delta belongs to.
    ///
    /// Addressed by message id when there is one, and otherwise by "the last
    /// assistant turn" — tool events carry no message id, and a turn can call several
    /// tools between two pieces of text.
    private func appendToAssistant(_ messageId: String?, _ mutate: (inout Turn) -> Void) {
        if let messageId, let index = index(of: messageId) {
            mutate(&turns[index])
            return
        }
        if let bound = boundAssistantTurn, let index = index(of: bound) {
            mutate(&turns[index])
            return
        }
        if let index = turns.lastIndex(where: { $0.role == .assistant }) {
            mutate(&turns[index])
        }
    }

    private func appendNotice(_ text: String, symbol: String) {
        turns.append(Turn(id: "notice-\(UUID().uuidString)", role: .notice, text: text, symbol: symbol))
    }

    /// `turns` is `@Published`, and mutating it element-by-element publishes once per
    /// element. Batching through a local copy means one publish per event, which is
    /// the difference between a smooth stream and a stuttering one on a long
    /// transcript.
    private func mutateTurns(_ body: (inout [Turn]) -> Void) {
        var copy = turns
        body(&copy)
        turns = copy
    }

    // MARK: - Approvals

    func resolve(_ approval: ApprovalRequest, decision: ApprovalDecision) {
        pendingApproval = nil
        status = decision == .allow ? .callingTool : .thinking
        guard let api else { return }
        Task {
            do {
                try await api.resolve(approvalId: approval.approvalId, decision: decision)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    // MARK: - Files

    func refreshFiles(path: String) async {
        guard let api else { return }
        do {
            let listing = try await api.list(path: path)
            entries[path] = listing.entries.sorted { lhs, rhs in
                // Directories first, then case-insensitive by name — the ordering
                // Finder uses, so the panel does not feel like someone else's app.
                if lhs.isDirectory != rhs.isDirectory { return lhs.isDirectory }
                return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
            }
            // Refresh any expanded child directory too, so a tool that wrote deep in
            // the tree does not leave a stale branch on screen.
            for child in listing.entries where child.isDirectory && expandedDirectories.contains(child.path) {
                await refreshFiles(path: child.path)
            }
        } catch {
            log.error("files \(path, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    func toggleDirectory(_ entry: DirEntry) {
        if expandedDirectories.contains(entry.path) {
            expandedDirectories.remove(entry.path)
        } else {
            expandedDirectories.insert(entry.path)
            Task { await refreshFiles(path: entry.path) }
        }
    }

    func upload(_ urls: [URL]) {
        guard let api else { return }
        Task {
            for url in urls {
                do {
                    try await api.upload(fileAt: url)
                } catch {
                    errorMessage = "Could not add \(url.lastPathComponent): \(error.localizedDescription)"
                }
            }
            await refreshFiles(path: "/")
        }
    }

    func download(_ entry: DirEntry, to destination: URL) {
        guard let api else { return }
        Task {
            do {
                let data = try await api.download(path: entry.path)
                try data.write(to: destination, options: .atomic)
            } catch {
                errorMessage = "Could not save \(entry.name): \(error.localizedDescription)"
            }
        }
    }

    // MARK: - Connectors

    func refreshConnectors() async {
        guard let api else { return }
        do {
            connectors = try await api.connectors()
        } catch {
            log.error("connectors: \(error.localizedDescription, privacy: .public)")
        }
    }

    func approveTool(_ qualifiedName: String?) {
        guard let api else { return }
        Task {
            do {
                try await api.approveTool(qualifiedName: qualifiedName)
                await refreshConnectors()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    // MARK: - Session

    /// Starts a fresh conversation, archiving the current one first.
    func startNewSession() {
        persist()
        cancelTurn()
        let summary = library.createSession()

        sessionID = summary.id
        turns.removeAll()
        runCost = .zero
        errorMessage = nil
        pendingApproval = nil
        status = .idle
        expandedTools = []
        expandedReasoning = []
        entries = [:]
        expandedDirectories = ["/"]

        rebuildClient()
    }

    func dismissError() {
        errorMessage = nil
    }

    private static let tokens: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        return formatter
    }()
}
