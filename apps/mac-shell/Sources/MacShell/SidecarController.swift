import Combine
import Foundation
import OSLog

/// Owns the bundled Node server: launch, port discovery, supervision, shutdown.
///
/// The whole class is `@MainActor` because every piece of state it holds is read by
/// SwiftUI. The work that genuinely happens off the main thread — pipe reads and the
/// termination callback — arrives on libdispatch queues and hops back in with a
/// `Task { @MainActor in }`, so there is exactly one place mutations can happen and
/// no lock anywhere.
@MainActor
final class SidecarController: ObservableObject {
    @Published private(set) var state: SidecarState = .idle

    /// Tail of the sidecar's own output, kept so a failure panel can show why it died
    /// instead of just that it did. The sidecar is expected to write real logs to a
    /// file; this is a diagnostic tail, not a log sink.
    @Published private(set) var recentOutput: [String] = []

    private let dataDirectory: URL
    private let keychain: KeychainStore
    private let log = Logger(subsystem: AppInfo.subsystem, category: "sidecar")

    private var process: Process?
    private var stdinPipe: Pipe?
    private var stdoutHandle: FileHandle?
    private var stderrHandle: FileHandle?
    private var exitSignal: DispatchSemaphore?

    /// Incremented on every launch. Callbacks carry the generation they were armed
    /// under and drop themselves if it has moved on. Without this, a slow exit
    /// notification from the process we just replaced arrives after the new one is
    /// already running and tears it down.
    private var generation: UInt64 = 0

    private var consecutiveFailures = 0
    private var readyAt: Date?
    private var pendingFailureNote: String?
    private var stopping = false
    private var relaunchAfterStop = false
    private var restartTask: Task<Void, Never>?
    private var readyWatchdog: Task<Void, Never>?

    private static let maxConsecutiveFailures = 5
    /// How long a sidecar must stay up before its eventual death counts as a new
    /// incident rather than a continuation of the current crash loop.
    private static let healthyRuntime: TimeInterval = 30
    private static let readyTimeout: TimeInterval = 20
    private static let outputHistoryLimit = 200

    init(dataDirectory: URL, keychain: KeychainStore) {
        self.dataDirectory = dataDirectory
        self.keychain = keychain
    }

    // MARK: - Control

    func start() {
        guard process == nil else { return }
        stopping = false
        relaunchAfterStop = false
        consecutiveFailures = 0
        launch()
    }

    /// User-initiated restart. Resets the failure budget, because the user asking is
    /// evidence that something changed since the last attempt.
    func restartNow() {
        cancelPendingWork()
        consecutiveFailures = 0
        pendingFailureNote = nil

        guard process != nil else {
            stopping = false
            launch()
            return
        }
        stopping = true
        relaunchAfterStop = true
        beginTermination()
    }

    /// Stops the sidecar and blocks until it is gone or the deadline passes.
    ///
    /// Called from `applicationWillTerminate`, which is the last moment the app can
    /// still do anything. Blocking the main thread here is the point: returning early
    /// would let the process exit with the child still listening.
    func stopBlocking(timeout: TimeInterval = 2.0) {
        stopping = true
        relaunchAfterStop = false
        cancelPendingWork()

        guard let process, process.isRunning, let exited = exitSignal else {
            teardownProcess()
            state = .idle
            return
        }

        let pid = process.processIdentifier
        closeStdin()
        process.terminate()

        if exited.wait(timeout: .now() + timeout) == .timedOut {
            // The termination handler has not run, so Foundation has not reaped the
            // child: the pid is still this process (a zombie at worst) and cannot have
            // been recycled. Signalling it directly is safe here and only here.
            log.error("Sidecar ignored SIGTERM; sending SIGKILL to pid \(String(pid), privacy: .public)")
            kill(pid, SIGKILL)
            _ = exited.wait(timeout: .now() + 0.5)
        }

        teardownProcess()
        state = .idle
    }

    // MARK: - Launch

    private func launch() {
        // A failure to read the Keychain must not stop the workspace from starting:
        // most deployments have no local key at all, and the ones that do would rather
        // see the sidecar report a missing credential than see no window.
        let providerAPIKey = (try? keychain.read(account: KeychainAccount.providerAPIKey)) ?? nil

        // Resolved on every launch rather than cached, so a key saved in Settings and
        // a Restart Sidecar are enough to apply it.
        let resolved: SidecarLaunchSpec
        do {
            resolved = try SidecarLaunchSpec.resolve(
                dataDirectory: dataDirectory,
                providerAPIKey: providerAPIKey
            )
        } catch let failure as SidecarFailure {
            state = .failed(failure)
            return
        } catch {
            state = .failed(.launchFailed(error.localizedDescription))
            return
        }

        generation &+= 1
        let gen = generation
        readyAt = nil

        let process = Process()
        process.executableURL = resolved.executable
        process.arguments = resolved.arguments
        process.currentDirectoryURL = resolved.workingDirectory
        process.environment = resolved.environment

        let stdin = Pipe()
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr

        // Both streams are drained continuously for as long as the child lives. A pipe
        // whose reader stops reading fills at 64KB and then blocks the writer forever,
        // which looks exactly like a hung server.
        attachReader(stdout.fileHandleForReading, generation: gen, isStderr: false)
        attachReader(stderr.fileHandleForReading, generation: gen, isStderr: true)

        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { [weak self] finished in
            let status = finished.terminationStatus
            let signalled = finished.terminationReason == .uncaughtSignal
            // Signalled synchronously, before the main-actor hop. `stopBlocking` waits
            // on this semaphore from the main thread; if the signal depended on a
            // main-actor task running first, the two would deadlock.
            exited.signal()
            Task { @MainActor in
                self?.handleExit(generation: gen, status: status, signalled: signalled)
            }
        }

        do {
            try process.run()
        } catch {
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            try? stdin.fileHandleForWriting.close()
            // A throw from `run()` is a configuration fault — the executable is missing,
            // not executable, or the working directory is gone. Retrying five times with
            // backoff would only delay the same message, so this path fails outright.
            let message = "Could not start \(resolved.executable.path): \(error.localizedDescription)"
            log.error("\(message, privacy: .public)")
            state = .failed(.launchFailed(message))
            return
        }

        self.process = process
        self.stdinPipe = stdin
        self.stdoutHandle = stdout.fileHandleForReading
        self.stderrHandle = stderr.fileHandleForReading
        self.exitSignal = exited

        state = .starting(attempt: consecutiveFailures + 1)
        log.notice("Sidecar started, pid \(String(process.processIdentifier), privacy: .public)")

        readyWatchdog = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(SidecarController.readyTimeout * 1_000_000_000))
            guard let self, !Task.isCancelled, self.generation == gen, self.state.endpoint == nil else { return }
            let note = "did not print \(SidecarLaunchSpec.readyMarker) within \(Int(SidecarController.readyTimeout))s"
            self.log.error("Sidecar \(note, privacy: .public)")
            self.pendingFailureNote = note
            // Kill it and let the ordinary exit path apply backoff and the attempt cap.
            self.beginTermination()
        }
    }

    private func attachReader(_ handle: FileHandle, generation gen: UInt64, isStderr: Bool) {
        let buffer = LineBuffer()
        handle.readabilityHandler = { [weak self] fileHandle in
            let data = fileHandle.availableData
            if data.isEmpty {
                // EOF. Clearing the handler here is mandatory: a closed descriptor is
                // permanently readable, so leaving it armed spins the queue at 100%.
                fileHandle.readabilityHandler = nil
                let tail = buffer.drain()
                guard !tail.isEmpty else { return }
                Task { @MainActor in self?.handleLines(tail, generation: gen, isStderr: isStderr) }
                return
            }
            let lines = buffer.append(data)
            guard !lines.isEmpty else { return }
            Task { @MainActor in self?.handleLines(lines, generation: gen, isStderr: isStderr) }
        }
    }

    // MARK: - Callbacks, all on the main actor

    private func handleLines(_ lines: [String], generation gen: UInt64, isStderr: Bool) {
        guard gen == generation else { return }
        for line in lines {
            if !isStderr, let endpoint = Self.parseReadyLine(line) {
                handleReady(endpoint)
                continue
            }
            record(line, isStderr: isStderr)
        }
    }

    private func handleReady(_ endpoint: SidecarEndpoint) {
        readyWatchdog?.cancel()
        readyWatchdog = nil
        readyAt = Date()
        pendingFailureNote = nil
        state = .running(endpoint)
        log.notice("Sidecar listening on port \(String(endpoint.port), privacy: .public)")
    }

    private func handleExit(generation gen: UInt64, status: Int32, signalled: Bool) {
        guard gen == generation else { return }
        cancelPendingWork()

        let ranHealthily = readyAt.map { Date().timeIntervalSince($0) >= Self.healthyRuntime } ?? false
        teardownProcess()

        if stopping {
            if relaunchAfterStop {
                relaunchAfterStop = false
                stopping = false
                launch()
            } else {
                state = .idle
            }
            return
        }

        if ranHealthily {
            // A sidecar that stayed up for half a minute and then died is a new
            // incident, not the continuation of an old crash loop. Without this reset
            // a long-lived app eventually spends its restart budget on failures that
            // happened days apart.
            consecutiveFailures = 0
        }
        consecutiveFailures += 1

        let detail = pendingFailureNote
            ?? (signalled ? "killed by signal \(status)" : "exited with status \(status)")
        pendingFailureNote = nil
        log.error("Sidecar \(detail, privacy: .public) (failure \(String(self.consecutiveFailures), privacy: .public))")

        guard consecutiveFailures < Self.maxConsecutiveFailures else {
            state = .failed(.exitedRepeatedly(attempts: consecutiveFailures, detail: detail))
            return
        }

        let delay = Self.backoffDelay(forAttempt: consecutiveFailures)
        state = .restarting(attempt: consecutiveFailures + 1, delay: delay, reason: detail)
        restartTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self, !Task.isCancelled else { return }
            self.restartTask = nil
            self.launch()
        }
    }

    // MARK: - Teardown

    private func beginTermination() {
        guard let process, process.isRunning else { return }
        let pid = process.processIdentifier
        let gen = generation
        closeStdin()
        process.terminate()

        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard let self, self.generation == gen, let current = self.process, current.isRunning else { return }
            self.log.error("Sidecar ignored SIGTERM; sending SIGKILL to pid \(String(pid), privacy: .public)")
            kill(pid, SIGKILL)
        }
    }

    private func closeStdin() {
        guard let pipe = stdinPipe else { return }
        stdinPipe = nil
        // Closing the write end is the primary stop signal, and the only one that
        // survives the app being SIGKILLed: the kernel closes the descriptor, the
        // sidecar reads EOF on stdin and exits itself. A sidecar that ignores stdin
        // EOF will be orphaned by a hard crash of this app — that contract belongs in
        // the sidecar, and SIGTERM only covers the orderly case.
        try? pipe.fileHandleForWriting.close()
    }

    private func teardownProcess() {
        // Handlers are cleared but the read ends are never closed by hand: closing a
        // FileHandle with a readability handler still armed raises an Objective-C
        // exception that Swift cannot catch. Letting the Pipe deallocate closes them.
        stdoutHandle?.readabilityHandler = nil
        stderrHandle?.readabilityHandler = nil
        stdoutHandle = nil
        stderrHandle = nil
        closeStdin()
        process = nil
        exitSignal = nil
        readyAt = nil
    }

    private func cancelPendingWork() {
        restartTask?.cancel()
        restartTask = nil
        readyWatchdog?.cancel()
        readyWatchdog = nil
    }

    // MARK: - Helpers

    private func record(_ line: String, isStderr: Bool) {
        guard !line.isEmpty else { return }
        if isStderr {
            log.error("sidecar: \(line, privacy: .public)")
        } else {
            log.debug("sidecar: \(line, privacy: .public)")
        }

        recentOutput.append(isStderr ? "! \(line)" : "  \(line)")
        if recentOutput.count > Self.outputHistoryLimit {
            recentOutput.removeFirst(recentOutput.count - Self.outputHistoryLimit)
        }
    }

    private struct ReadyPayload: Decodable {
        let port: Int
        let token: String?
    }

    /// Parses the ready line. See `SidecarLaunchSpec.readyMarker` for the contract.
    static func parseReadyLine(_ line: String) -> SidecarEndpoint? {
        guard let marker = line.range(of: SidecarLaunchSpec.readyMarker) else { return nil }
        let payload = line[marker.upperBound...].trimmingCharacters(in: .whitespaces)

        if let data = payload.data(using: .utf8),
           let decoded = try? JSONDecoder().decode(ReadyPayload.self, from: data),
           let port = UInt16(exactly: decoded.port), port > 0 {
            let rawToken = decoded.token ?? ""
            return SidecarEndpoint(port: port, token: rawToken.isEmpty ? nil : rawToken)
        }

        // Tolerated so a throwaway stub server can print `AGENTIC_SIDECAR_READY 51234`.
        if let bare = UInt16(payload), bare > 0 {
            return SidecarEndpoint(port: bare, token: nil)
        }
        return nil
    }

    /// 0.4s, 0.8s, 1.6s, 3.2s, capped at 8s. Fast enough that a transient port clash
    /// is invisible, slow enough that a genuinely broken sidecar is not respawned in a
    /// tight loop while the user reads the error.
    static func backoffDelay(forAttempt attempt: Int) -> TimeInterval {
        min(0.4 * pow(2, Double(max(attempt, 1) - 1)), 8.0)
    }
}
