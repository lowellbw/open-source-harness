import Foundation

/// Where the sidecar ended up listening, as announced on its own stdout.
struct SidecarEndpoint: Equatable {
    let port: UInt16

    /// Optional one-time token the sidecar prints alongside the port.
    ///
    /// A loopback listener is not a security boundary on a multi-user Mac: any local
    /// process running as any user can connect to 127.0.0.1. If the sidecar issues a
    /// token, the shell hands it back on the first request and the sidecar is expected
    /// to exchange it for a session cookie and refuse unauthenticated requests after
    /// that. The shell does not interpret the token beyond passing it through.
    let token: String?

    var url: URL {
        var components = URLComponents()
        components.scheme = "http"
        // 127.0.0.1 rather than "localhost": no resolver round trip, and no chance of
        // the name resolving to ::1 while the sidecar bound only the IPv4 loopback.
        components.host = "127.0.0.1"
        components.port = Int(port)
        components.path = "/"
        if let token {
            components.queryItems = [URLQueryItem(name: "t", value: token)]
        }
        // Every component is set here from validated values; this cannot fail.
        return components.url!
    }
}

enum SidecarState {
    case idle
    case starting(attempt: Int)
    case running(SidecarEndpoint)
    case restarting(attempt: Int, delay: TimeInterval, reason: String)
    case failed(SidecarFailure)

    var endpoint: SidecarEndpoint? {
        if case .running(let endpoint) = self { return endpoint }
        return nil
    }

}

enum SidecarFailure: Error, Equatable {
    /// No usable `node` on disk. Carries the paths that were tried so the message
    /// can say where it looked rather than just "not found".
    case nodeNotFound(searched: [String])
    case serverScriptMissing(expected: String)
    case launchFailed(String)
    case exitedRepeatedly(attempts: Int, detail: String)

    var summary: String {
        switch self {
        case .nodeNotFound:
            return "Node runtime not found"
        case .serverScriptMissing:
            return "Sidecar not bundled"
        case .launchFailed:
            return "Sidecar could not be launched"
        case .exitedRepeatedly:
            return "Sidecar keeps exiting"
        }
    }

    var detail: String {
        switch self {
        case .nodeNotFound(let searched):
            return """
            A development build looks for `node` on disk because a GUI app launched from \
            Finder inherits launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), not your shell's — \
            a Homebrew install is invisible to it. Set AGENTIC_NODE_PATH, or ship a bundled \
            runtime at Contents/Resources/sidecar/node.

            Searched:
            \(searched.map { "  \($0)" }.joined(separator: "\n"))
            """
        case .serverScriptMissing(let expected):
            return """
            Expected the sidecar entry point at:
              \(expected)

            Release builds get it from build.sh --sidecar <dir>. For development, point \
            AGENTIC_SIDECAR_PATH at the built server entry point.
            """
        case .launchFailed(let message):
            return message
        case .exitedRepeatedly(let attempts, let detail):
            return "Gave up after \(attempts) consecutive failed starts. \(detail)"
        }
    }
}

/// Everything needed to spawn the sidecar, resolved once before the first launch so
/// a misconfigured build fails with a specific message instead of a generic ENOENT.
struct SidecarLaunchSpec {
    let executable: URL
    let arguments: [String]
    let workingDirectory: URL
    let environment: [String: String]

    /// Marker the sidecar prints on stdout when its listener is accepting.
    ///
    /// Contract, in full:
    ///
    ///     AGENTIC_SIDECAR_READY {"port":51234,"token":"…"}
    ///
    /// One line, on stdout, after `listen` has called back — not before, or the shell
    /// races the listener. `token` is optional. A bare decimal port is also accepted
    /// so a stub server can be a one-liner. Everything else on stdout is treated as
    /// log output.
    static let readyMarker = "AGENTIC_SIDECAR_READY"

    /// - Parameter providerAPIKey: passed to the child in its environment when the
    ///   user has stored one locally. A managed deployment has none: the org's key
    ///   lives in the gateway, which is also where budgets and model gating are
    ///   enforced, and the sidecar authenticates to the gateway instead.
    static func resolve(dataDirectory: URL, providerAPIKey: String?) throws -> SidecarLaunchSpec {
        let environment = ProcessInfo.processInfo.environment

        let script = try resolveServerScript(environment: environment)
        let node = try resolveNodeExecutable(environment: environment)

        var childEnvironment: [String: String] = [
            // launchd's PATH plus wherever node actually came from, so a child process
            // spawned by the sidecar can find its own runtime.
            "PATH": "\(node.deletingLastPathComponent().path):/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": NSHomeDirectory(),
            "NODE_ENV": environment["NODE_ENV"] ?? "production",
            // 0 means "any free port". The shell never picks a port: a fixed port is a
            // collision waiting to happen, and the ready line is the single source of
            // truth for where the sidecar actually landed.
            "PORT": "0",
            "AGENTIC_DATA_DIR": dataDirectory.path,
            "AGENTIC_SHELL": "mac",
            "AGENTIC_SHELL_VERSION": AppInfo.versionString,
        ]
        if let lang = environment["LANG"] { childEnvironment["LANG"] = lang }
        if let tz = environment["TZ"] { childEnvironment["TZ"] = tz }
        // Environment rather than a file or an argument: argv is world-readable via
        // `ps`, and a file on disk outlives the process that needed it.
        if let providerAPIKey, !providerAPIKey.isEmpty {
            childEnvironment["AGENTIC_PROVIDER_API_KEY"] = providerAPIKey
        }

        return SidecarLaunchSpec(
            executable: node,
            arguments: [script.path],
            workingDirectory: dataDirectory,
            environment: childEnvironment
        )
    }

    private static func resolveServerScript(environment: [String: String]) throws -> URL {
        if let override = environment["AGENTIC_SIDECAR_PATH"], !override.isEmpty {
            let url = URL(fileURLWithPath: override)
            guard FileManager.default.isReadableFile(atPath: url.path) else {
                throw SidecarFailure.serverScriptMissing(expected: url.path)
            }
            return url
        }

        let bundled = (Bundle.main.resourceURL ?? Bundle.main.bundleURL)
            .appendingPathComponent("sidecar/server.js")
        guard FileManager.default.isReadableFile(atPath: bundled.path) else {
            throw SidecarFailure.serverScriptMissing(expected: bundled.path)
        }
        return bundled
    }

    private static func resolveNodeExecutable(environment: [String: String]) throws -> URL {
        var candidates: [String] = []

        if let override = environment["AGENTIC_NODE_PATH"], !override.isEmpty {
            candidates.append(override)
        }

        // A bundled runtime is what a shipping build must use. Anything else makes the
        // app's behaviour depend on what the user happens to have installed.
        if let resources = Bundle.main.resourceURL {
            candidates.append(resources.appendingPathComponent("sidecar/node").path)
        }

        // Development fallbacks, in the order a Mac developer is likely to have them.
        candidates.append(contentsOf: [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ])

        // Only useful when launched from a terminal; harmless otherwise.
        if let path = environment["PATH"] {
            for directory in path.split(separator: ":") where !directory.isEmpty {
                candidates.append("\(directory)/node")
            }
        }

        for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate) {
            return URL(fileURLWithPath: candidate)
        }
        throw SidecarFailure.nodeNotFound(searched: candidates)
    }
}

/// Splits a byte stream into whole lines across `readabilityHandler` callbacks.
///
/// `availableData` returns whatever happens to be in the pipe buffer, which has no
/// relationship to line boundaries: a single read can carry half a line, six lines,
/// or a line split mid-UTF-8-sequence. Decoding each chunk independently corrupts
/// exactly the ready line the shell is waiting for.
///
/// Safe to mutate from a readability handler: libdispatch delivers those serially per
/// file handle, so there is one writer at a time.
final class LineBuffer: @unchecked Sendable {
    private var buffer = Data()
    private let limit: Int

    /// `limit` bounds a sidecar that writes without ever emitting a newline. Dropping
    /// the buffer loses log output; not dropping it grows until the app is killed.
    init(limit: Int = 1 << 20) {
        self.limit = limit
    }

    func append(_ data: Data) -> [String] {
        buffer.append(data)
        var lines: [String] = []
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<newline]
            buffer.removeSubrange(buffer.startIndex...newline)
            lines.append(Self.decode(line))
        }
        if buffer.count > limit {
            buffer.removeAll(keepingCapacity: false)
        }
        return lines
    }

    /// Whatever is left when the stream ends without a trailing newline.
    func drain() -> [String] {
        guard !buffer.isEmpty else { return [] }
        let line = Self.decode(buffer)
        buffer.removeAll(keepingCapacity: false)
        return [line]
    }

    private static func decode(_ data: Data) -> String {
        var line = String(decoding: data, as: UTF8.self)
        // Only the trailing CR. Trimming whitespace generally would mangle indented
        // log output, which is the one thing this buffer exists to preserve.
        if line.hasSuffix("\r") { line.removeLast() }
        return line
    }
}
