import Combine
import Foundation
import OSLog

/// What the sidebar needs to draw a row, without reading the transcript.
struct SessionSummary: Identifiable, Codable, Equatable {
    let id: String
    var title: String
    var createdAt: Date
    var updatedAt: Date
    var turnCount: Int
    var modelAlias: String
    var sessionUsd: Double

    /// True once the transcript has outlived the sidecar process that produced it.
    ///
    /// Server-side session state lives in a module-scope `Map` — see the comment in
    /// `lib/session.ts`, which is explicit that this is right for a single-user local
    /// deployment. The consequence for this app is that reopening an old conversation
    /// gives you the record but not the agent's memory of it, and pretending
    /// otherwise would be the worst kind of quiet lie.
    var contextLost: Bool = false

    var isUntitled: Bool { title == SessionSummary.untitled }
    static let untitled = "New Conversation"
}

/// The archive on disk, and the list the sidebar renders.
///
/// One JSON file per conversation under `sessions/`, plus an index so the sidebar can
/// be drawn without decoding every transcript at launch. The index is a cache, not the
/// truth: if it is missing or unreadable it is rebuilt by scanning, so a corrupt index
/// costs a slow launch rather than the user's history.
@MainActor
final class SessionLibrary: ObservableObject {
    @Published private(set) var sessions: [SessionSummary] = []
    @Published private(set) var selectedID: String?
    @Published var searchText: String = ""

    private let directory: URL
    private let indexURL: URL
    private let log = Logger(subsystem: AppInfo.subsystem, category: "sessions")

    var visibleSessions: [SessionSummary] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return sessions }
        return sessions.filter { $0.title.localizedCaseInsensitiveContains(query) }
    }

    var selected: SessionSummary? {
        sessions.first { $0.id == selectedID }
    }

    init(dataDirectory: URL) {
        directory = dataDirectory.appendingPathComponent("sessions", isDirectory: true)
        indexURL = directory.appendingPathComponent("index.json")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        load()
    }

    // MARK: - Index

    private func load() {
        if let data = try? Data(contentsOf: indexURL),
           let stored = try? JSONDecoder.iso.decode([SessionSummary].self, from: data) {
            sessions = stored
        } else {
            sessions = rebuildIndex()
        }
        // Everything on disk at launch predates this process, so none of it still has
        // a live agent behind it — but a conversation nobody ever sent anything to has
        // no context to have lost, and flagging it as archived is just noise.
        for index in sessions.indices where sessions[index].turnCount > 0 {
            sessions[index].contextLost = true
        }
        sessions.sort { $0.updatedAt > $1.updatedAt }
        selectedID = sessions.first?.id
        writeIndex()
    }

    /// Reads every transcript to reconstruct the sidebar. Only ever runs when the
    /// index is unusable.
    private func rebuildIndex() -> [SessionSummary] {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return files
            .filter { $0.pathExtension == "json" && $0.lastPathComponent != "index.json" }
            .compactMap { url in
                guard let data = try? Data(contentsOf: url),
                      let archive = try? JSONDecoder.iso.decode(SessionArchive.self, from: data)
                else {
                    log.error("skipping unreadable transcript \(url.lastPathComponent, privacy: .public)")
                    return nil
                }
                return archive.summary
            }
    }

    private func writeIndex() {
        do {
            try JSONEncoder.iso.encode(sessions).write(to: indexURL, options: .atomic)
        } catch {
            log.error("could not write the session index: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Lifecycle

    @discardableResult
    func createSession() -> SessionSummary {
        // A UUID, not "default". Each id gets its own workspace root server-side, so
        // reusing one across conversations would put two of them in the same folder.
        let summary = SessionSummary(
            id: UUID().uuidString,
            title: SessionSummary.untitled,
            createdAt: Date(),
            updatedAt: Date(),
            turnCount: 0,
            modelAlias: "Standard",
            sessionUsd: 0,
            contextLost: false
        )
        sessions.insert(summary, at: 0)
        selectedID = summary.id
        writeIndex()
        return summary
    }

    func select(_ id: String) {
        guard id != selectedID else { return }
        selectedID = id
    }

    func delete(_ id: String) {
        sessions.removeAll { $0.id == id }
        try? FileManager.default.removeItem(at: transcriptURL(for: id))
        if selectedID == id { selectedID = sessions.first?.id }
        writeIndex()
    }

    func rename(_ id: String, to title: String) {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let index = sessions.firstIndex(where: { $0.id == id }) else { return }
        sessions[index].title = trimmed.isEmpty ? SessionSummary.untitled : trimmed
        writeIndex()
        // Keep the transcript's own copy in step, so a rebuilt index does not undo it.
        if var archive = readArchive(id: id) {
            archive.summary = sessions[index]
            write(archive)
        }
    }

    // MARK: - Transcripts

    private func transcriptURL(for id: String) -> URL {
        directory.appendingPathComponent("\(id).json")
    }

    func transcript(for id: String) -> [Turn] {
        readArchive(id: id)?.turns ?? []
    }

    private func readArchive(id: String) -> SessionArchive? {
        guard let data = try? Data(contentsOf: transcriptURL(for: id)) else { return nil }
        return try? JSONDecoder.iso.decode(SessionArchive.self, from: data)
    }

    /// Records a conversation's current state.
    ///
    /// Called at the end of every turn and when switching away, not on every delta:
    /// writing a whole transcript per streamed character would be a filesystem write
    /// per frame, and the only thing lost by not doing it is a turn that was in
    /// flight when the app was killed.
    func save(id: String, turns: [Turn], modelAlias: String, sessionUsd: Double) {
        guard let index = sessions.firstIndex(where: { $0.id == id }) else { return }

        var summary = sessions[index]
        summary.updatedAt = Date()
        summary.turnCount = turns.count
        summary.modelAlias = modelAlias
        summary.sessionUsd = sessionUsd
        // A conversation names itself after the first thing that was asked of it.
        // An explicit rename sticks, because the title is no longer the default.
        if summary.isUntitled, let first = turns.first(where: { $0.role == .user }) {
            summary.title = Self.title(from: first.text)
        }
        sessions[index] = summary
        sessions.sort { $0.updatedAt > $1.updatedAt }
        writeIndex()

        write(SessionArchive(summary: summary, turns: turns))
    }

    private func write(_ archive: SessionArchive) {
        do {
            try JSONEncoder.iso.encode(archive)
                .write(to: transcriptURL(for: archive.summary.id), options: .atomic)
        } catch {
            log.error("could not save the transcript: \(error.localizedDescription, privacy: .public)")
        }
    }

    private static func title(from text: String) -> String {
        let firstLine = text
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: .newlines)
            .first ?? text
        guard firstLine.count > 48 else { return firstLine.isEmpty ? SessionSummary.untitled : firstLine }
        // Cut on a word boundary; a title severed mid-word looks like damage.
        let clipped = firstLine.prefix(48)
        guard let lastSpace = clipped.lastIndex(of: " "), clipped.distance(from: clipped.startIndex, to: lastSpace) > 20
        else { return clipped + "…" }
        return clipped[..<lastSpace] + "…"
    }
}

/// One conversation, as written to disk. Versioned from the start, because the
/// alternative is discovering you needed a version field after shipping.
private struct SessionArchive: Codable {
    var version: Int = 1
    var summary: SessionSummary
    var turns: [Turn]
}

extension JSONDecoder {
    static let iso: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}

extension JSONEncoder {
    static let iso: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
}
