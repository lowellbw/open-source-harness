import Foundation
import OSLog

/// The typed HTTP client for the sidecar's `/api` surface.
///
/// One `URLSession` per endpoint, created when the sidecar announces its port and
/// discarded when it goes away. That matters more than it looks: the port changes on
/// every restart, and a session that has pooled a connection to the old port will
/// happily reuse it and fail in a way that reads as a server bug.
///
/// Nothing here touches the main actor, so a slow turn cannot make the window drop
/// frames. The store that owns this is `@MainActor` and hops back on its own.
struct WorkspaceAPI: Sendable {
    let endpoint: SidecarEndpoint
    let sessionID: String

    private let session: URLSession
    private let log = Logger(subsystem: AppInfo.subsystem, category: "api")

    init(endpoint: SidecarEndpoint, sessionID: String = "default") {
        self.endpoint = endpoint
        self.sessionID = sessionID

        let configuration = URLSessionConfiguration.ephemeral
        // A turn is bounded by the agent, not by the transport. The default 60s
        // resource timeout would sever a long tool call mid-stream, and the client
        // would report a network error for something that was working.
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = .greatestFiniteMagnitude
        configuration.httpShouldUsePipelining = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        // The workspace is loopback-only; a proxy configured for the user's network
        // would either fail or, worse, send the request somewhere else entirely.
        configuration.connectionProxyDictionary = [:]
        self.session = URLSession(configuration: configuration)
    }

    // MARK: - Requests

    private func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        var components = URLComponents()
        components.scheme = "http"
        components.host = "127.0.0.1"
        components.port = Int(endpoint.port)
        components.path = path
        let items = [URLQueryItem(name: "sessionId", value: sessionID)] + query
        components.queryItems = items
        return components.url!
    }

    private func request(_ path: String, method: String = "GET", query: [URLQueryItem] = []) -> URLRequest {
        var request = URLRequest(url: url(path, query: query))
        request.httpMethod = method
        // Bearer rather than the browser's cookie exchange. A native client has no
        // cookie jar worth the name, and a header is stateless across sidecar
        // restarts — the token changes with the port, and both arrive together.
        if let token = endpoint.token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func decode<T: Decodable>(_ type: T.Type, from request: URLRequest) async throws -> T {
        let (data, response) = try await session.data(for: request)
        try Self.check(response, data: data)
        return try JSONDecoder().decode(type, from: data)
    }

    private static func check(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(decoding: data.prefix(400), as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            throw WorkspaceAPIError.http(status: http.statusCode, body: body)
        }
    }

    // MARK: - Models

    func models() async throws -> ModelsResponse {
        try await decode(ModelsResponse.self, from: request("/api/models"))
    }

    // MARK: - Files

    func list(path: String) async throws -> FileListing {
        try await decode(
            FileListing.self,
            from: request("/api/files", query: [URLQueryItem(name: "path", value: path)])
        )
    }

    /// Downloads one file's bytes. Used by "Save a Copy…", which is the only reason
    /// the shell ever needs a workspace file's contents in its own address space.
    func download(path: String) async throws -> Data {
        let request = request("/api/files", query: [
            URLQueryItem(name: "path", value: path),
            URLQueryItem(name: "download", value: "1"),
        ])
        let (data, response) = try await session.data(for: request)
        try Self.check(response, data: data)
        return data
    }

    /// Uploads one file. Multipart is built by hand rather than pulled in: it is
    /// twenty lines, and the alternative is a dependency in an app that has none.
    func upload(fileAt source: URL) async throws {
        let boundary = "agentic.\(UUID().uuidString)"
        var request = request("/api/files", method: "POST")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        let name = source.lastPathComponent
        var body = Data()
        func append(_ text: String) { body.append(Data(text.utf8)) }

        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"sessionId\"\r\n\r\n\(sessionID)\r\n")
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\n")
        append("Content-Type: application/octet-stream\r\n\r\n")
        body.append(try Data(contentsOf: source))
        append("\r\n--\(boundary)--\r\n")

        request.httpBody = body
        let (data, response) = try await session.data(for: request)
        try Self.check(response, data: data)
    }

    // MARK: - Connectors

    func connectors() async throws -> ConnectorStatus {
        try await decode(ConnectorStatus.self, from: request("/api/mcp"))
    }

    func approveTool(qualifiedName: String?) async throws {
        var request = request("/api/mcp", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "sessionId": sessionID,
            "qualifiedName": qualifiedName as Any,
            "all": qualifiedName == nil,
        ].compactMapValues { $0 })
        let (data, response) = try await session.data(for: request)
        try Self.check(response, data: data)
    }

    // MARK: - Approvals

    func resolve(approvalId: String, decision: ApprovalDecision) async throws {
        var request = request("/api/approve", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "sessionId": sessionID,
            "approvalId": approvalId,
            "decision": decision.rawValue,
        ])
        let (data, response) = try await session.data(for: request)
        try Self.check(response, data: data)
    }

    // MARK: - Chat

    /// Streams one turn as `WorkspaceEvent`s.
    ///
    /// `URLSession.bytes(for:)` rather than a `URLSessionDataDelegate`: the delegate
    /// form needs a class, a queue and a buffer that has to be reassembled across
    /// callbacks, and gets cancellation wrong by default. `AsyncBytes.lines` already
    /// does the line splitting, including a chunk boundary that lands mid-character,
    /// and cancelling the task cancels the request.
    ///
    /// The frames are single-line JSON by construction — `JSON.stringify` never emits
    /// a newline — so no multi-line SSE payload reassembly is needed. A frame that
    /// does not parse is dropped rather than thrown: one bad event must not end a
    /// turn the agent is still working through.
    func chat(message: String, modelAlias: String?) -> AsyncThrowingStream<WorkspaceEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = request("/api/chat", method: "POST")
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    var payload: [String: Any] = ["sessionId": sessionID, "message": message]
                    if let modelAlias { payload["modelAlias"] = modelAlias }
                    request.httpBody = try JSONSerialization.data(withJSONObject: payload)

                    let (bytes, response) = try await session.bytes(for: request)
                    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                        throw WorkspaceAPIError.http(status: http.statusCode, body: "")
                    }

                    let decoder = JSONDecoder()
                    for try await line in bytes.lines {
                        guard line.hasPrefix("data:") else { continue }
                        let frame = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                        guard !frame.isEmpty else { continue }
                        guard let event = try? decoder.decode(WorkspaceEvent.self, from: Data(frame.utf8)) else {
                            log.error("dropped an unparseable event frame")
                            continue
                        }
                        if case .done = event { break }
                        continuation.yield(event)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch let error as URLError where error.code == .cancelled {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

enum WorkspaceAPIError: LocalizedError {
    case http(status: Int, body: String)

    var errorDescription: String? {
        switch self {
        case .http(let status, let body):
            if status == 401 {
                return "The workspace rejected the shell's credentials. Restart the sidecar."
            }
            return body.isEmpty ? "The workspace returned HTTP \(status)." : body
        }
    }
}

// MARK: - Response shapes

struct ModelsResponse: Decodable {
    let current: String
    let models: [ModelInfo]
    let totals: Totals
    /// Remaining spend. Absent on deployments with no budget configured.
    let budget: Budget?

    struct Totals: Decodable {
        let run: CostBuckets
        let session: CostBuckets
    }

    /// Two ceilings, not one: the gateway limits spend per run *and* per session, and
    /// `BudgetGuard.remaining()` reports both.
    ///
    /// Decoded leniently because this field has had two shapes. A bare number is
    /// accepted as the session figure so that a stub server, or an older gateway, does
    /// not take the whole model list down with it — which is exactly what happened
    /// when this was typed as `Double?`: one unexpected field, and the picker emptied
    /// and the cost meter blanked, with nothing on screen to say why.
    struct Budget: Decodable {
        let runUsd: Double?
        let sessionUsd: Double?

        private enum CodingKeys: String, CodingKey {
            case runUsd, sessionUsd
        }

        init(from decoder: Decoder) throws {
            if let single = try? decoder.singleValueContainer(), let value = try? single.decode(Double.self) {
                runUsd = nil
                sessionUsd = value
                return
            }
            let container = try decoder.container(keyedBy: CodingKeys.self)
            runUsd = try container.decodeIfPresent(Double.self, forKey: .runUsd)
            sessionUsd = try container.decodeIfPresent(Double.self, forKey: .sessionUsd)
        }
    }
}

struct ModelInfo: Decodable, Identifiable, Equatable {
    let alias: String
    let tier: String
    let contextWindow: Int
    let inputPerMtok: Double
    let outputPerMtok: Double
    /// The one model the role can never lose access to. Shown, because a picker
    /// that can silently empty itself is worse than one that says what the floor is.
    let isFloor: Bool

    var id: String { alias }
}

struct FileListing: Decodable {
    let path: String
    let entries: [DirEntry]
}

struct DirEntry: Decodable, Identifiable, Equatable, Hashable {
    let name: String
    let path: String
    let type: EntryType
    let size: Int

    var id: String { path }
    var isDirectory: Bool { type == .directory }

    enum EntryType: String, Decodable {
        case file, directory, other
    }
}

struct ConnectorStatus: Decodable {
    var servers: [Server] = []
    var errors: [ServerError] = []
    var approved: [ApprovedTool] = []
    var pending: [PendingTool] = []

    struct Server: Decodable, Identifiable, Equatable {
        let id: String
        let name: String?
        let status: String?
        let toolCount: Int?
    }

    struct ServerError: Decodable, Identifiable, Equatable {
        let serverId: String
        let message: String
        var id: String { serverId + message }
    }

    struct ApprovedTool: Decodable, Identifiable, Equatable {
        let name: String
        let serverId: String
        var id: String { name }
    }

    struct PendingTool: Decodable, Identifiable, Equatable {
        let name: String
        let qualifiedName: String
        let serverId: String
        let description: String
        /// `new` means never seen; `changed` means the description moved after you
        /// approved it, which is the stronger signal and is labelled differently.
        let status: String?

        var id: String { qualifiedName }
        var hasChanged: Bool { status == "changed" }
    }
}
