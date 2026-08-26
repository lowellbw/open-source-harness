import Foundation
import OSLog

struct SandboxedCommandResult: Sendable {
    let stdout: String
    let stderr: String
    let exitCode: Int32
    let timedOut: Bool
    let duration: TimeInterval
}

enum SandboxExecError: Error, LocalizedError {
    case sandboxExecMissing
    case workspaceUnavailable(String)
    case launchFailed(String)

    var errorDescription: String? {
        switch self {
        case .sandboxExecMissing:
            return "/usr/bin/sandbox-exec is not present on this system."
        case .workspaceUnavailable(let path):
            return "Workspace root is not usable: \(path)"
        case .launchFailed(let message):
            return message
        }
    }
}

/// Runs one command under a Seatbelt profile that denies everything except reading
/// the system it needs to start, and reading and writing one workspace directory.
///
/// Seatbelt (`sandbox-exec`, SBPL) has been formally deprecated since macOS 10.14 and
/// still has no announced successor — Apple's own containerization work has an open,
/// unanswered issue asking what replaces it. It is also what every macOS agent tool
/// ships today, because the alternative on Apple silicon is a Linux VM. Treat this as
/// the degraded tier: real isolation for untrusted work is the container tier, and
/// the workspace layer says so honestly via `capabilities.isolated`.
enum SandboxExec {
    private static let sandboxExecPath = "/usr/bin/sandbox-exec"
    private static let log = Logger(subsystem: AppInfo.subsystem, category: "sandbox")

    /// The profile. Rules are last-match-wins, so `(deny default)` comes first and
    /// every allowance after it is a considered exception.
    ///
    /// Written as a raw string literal: SBPL is full of `\` and `"` and no part of it
    /// should ever be Swift-interpolated. The one variable — the workspace root — is
    /// passed in with `-D` and read back with `(param …)`, which keeps a path
    /// containing a quote from terminating the literal and rewriting the policy.
    static let profile = #"""
    (version 1)

    ;; Deny by default. Denials are logged; watch them live while tuning with:
    ;;   log stream --style compact --predicate 'senderImagePath CONTAINS "Sandbox"'
    ;; and generate a candidate allowance set for a real command by temporarily
    ;; adding (trace "/tmp/seatbelt.trace") below.
    (deny default)

    ;; Redundant under (deny default), and stated anyway. This is the rule most likely
    ;; to be silently undone by a later allowance, and the one whose absence is
    ;; hardest to notice from the outside. Egress policy for the agent lives in the
    ;; proxy; this is the floor beneath it, for the case where the proxy is not in the
    ;; path at all.
    (deny network*)

    ;; --- Enough of the system to start a process ---------------------------------
    ;; dyld must map the shared cache and every dylib the command links. On macOS 13+
    ;; the cache lives in a cryptex under /System/Volumes/Preboot, which (subpath
    ;; "/System") already covers.
    (allow file-read*
        ;; The root directory itself, not a subpath of it. dyld opens "/" while
        ;; resolving the shared cache, and (subpath "/System") does not imply read
        ;; access to the directory "/System" hangs off. Without this literal every
        ;; command dies at exec with SIGABRT and no message, because the process is
        ;; killed before it has a stderr worth writing to. It grants a listing of the
        ;; top level and nothing under it.
        (literal "/")
        (subpath "/System")
        (subpath "/usr/lib")
        (subpath "/usr/share")
        (subpath "/usr/libexec")
        (subpath "/bin")
        (subpath "/sbin")
        (subpath "/usr/bin")
        (subpath "/usr/sbin")
        (subpath "/private/var/db/timezone")
        (literal "/private/etc/localtime")
        (literal "/private/etc/hosts")
        (literal "/private/etc/passwd")
        (literal "/dev/null")
        (literal "/dev/zero")
        (literal "/dev/random")
        (literal "/dev/urandom")
        (literal "/dev/tty")
        (literal "/dev/dtracehelper"))

    ;; Metadata on any path, which does leak the existence and mtime of files the
    ;; command cannot read. Allowed globally on purpose: resolving /a/b/c requires
    ;; stat on /a and /a/b, so a strict version has to enumerate every ancestor of
    ;; every allowed path and still breaks at the first symlink.
    (allow file-read-metadata)

    (allow file-write-data
        (literal "/dev/null")
        (literal "/dev/tty")
        (literal "/dev/dtracehelper"))
    (allow file-ioctl
        (literal "/dev/tty")
        (literal "/dev/dtracehelper"))

    ;; A shell forks and execs constantly; without these the profile denies /bin/sh
    ;; its own startup. The workspace is on the exec list because an agent that
    ;; compiles something is expected to be able to run it — delete that one subpath
    ;; for a posture where agent output is data and never code.
    (allow process-fork)
    (allow process-exec
        (subpath "/bin")
        (subpath "/sbin")
        (subpath "/usr/bin")
        (subpath "/usr/sbin")
        (subpath "/usr/libexec")
        (subpath (param "WORKSPACE_ROOT")))

    ;; Self only. Inspecting or signalling anything else on the machine stays denied.
    (allow process-info* (target self))
    (allow signal (target self))
    (allow sysctl-read)

    ;; libinfo (getpwuid and friends) and the system log are mach services. Without
    ;; them ordinary tools fail in confusing ways long before they touch a file.
    (allow mach-lookup
        (global-name "com.apple.system.notification_center")
        (global-name "com.apple.system.opendirectoryd.libinfo")
        (global-name "com.apple.system.opendirectoryd.membership")
        (global-name "com.apple.system.logger")
        (global-name "com.apple.diagnosticd"))

    ;; --- The workspace ------------------------------------------------------------
    ;; WORKSPACE_ROOT arrives via -D and must already be symlink-resolved: Seatbelt
    ;; matches the real path, so a rule written against /tmp/x never matches
    ;; /private/tmp/x. Read and write are scoped to this subpath and nowhere else,
    ;; which is the whole point of the profile.
    (allow file-read* (subpath (param "WORKSPACE_ROOT")))
    (allow file-write* (subpath (param "WORKSPACE_ROOT")))
    """#

    /// Runs `command` through `/bin/sh -c` inside the profile above.
    ///
    /// - Parameter workspaceRoot: the only writable directory. Created if absent and
    ///   symlink-resolved before it reaches the profile.
    static func run(
        command: String,
        workspaceRoot: URL,
        timeout: TimeInterval = 120
    ) async throws -> SandboxedCommandResult {
        guard FileManager.default.isExecutableFile(atPath: sandboxExecPath) else {
            throw SandboxExecError.sandboxExecMissing
        }

        let fileManager = FileManager.default
        do {
            try fileManager.createDirectory(at: workspaceRoot, withIntermediateDirectories: true)
        } catch {
            throw SandboxExecError.workspaceUnavailable(workspaceRoot.path)
        }

        // Seatbelt evaluates the resolved path. /Users is commonly reached through a
        // firmlink, and TMPDIR through /var -> /private/var, so an unresolved path
        // produces a profile whose rules never match anything.
        let root = workspaceRoot.resolvingSymlinksInPath()

        // Keep temporary files inside the one writable subtree instead of granting a
        // second one. Most tools respect TMPDIR; the ones that hardcode /tmp will be
        // denied, visibly, which is the correct outcome.
        let tempDirectory = root.appendingPathComponent(".tmp", isDirectory: true)
        try? fileManager.createDirectory(at: tempDirectory, withIntermediateDirectories: true)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: sandboxExecPath)
        process.arguments = [
            "-D", "WORKSPACE_ROOT=\(root.path)",
            "-p", profile,
            "/bin/sh", "-c", command,
        ]
        process.currentDirectoryURL = root
        process.environment = [
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            // HOME points at the workspace so the many tools that write caches and
            // dotfiles to $HOME land inside the sandbox instead of being denied — or
            // worse, quietly succeeding against the user's real home in a future,
            // looser profile.
            "HOME": root.path,
            "TMPDIR": tempDirectory.path,
            "LANG": ProcessInfo.processInfo.environment["LANG"] ?? "en_US.UTF-8",
        ]

        log.debug("sandbox-exec: \(command, privacy: .public)")
        return try await ProcessRunner.run(process: process, timeout: timeout)
    }
}

/// One-shot process execution that does not lose output and does not hang.
///
/// The three things that go wrong here, in the order people hit them: not draining
/// the pipes (the child blocks at 64KB and looks hung), resuming the continuation on
/// `terminationHandler` alone (output still buffered in the pipe is lost), and
/// resuming twice (a crash). This waits for all three completion events — stdout EOF,
/// stderr EOF, and termination — and resumes exactly once.
private enum ProcessRunner {
    static func run(process: Process, timeout: TimeInterval) async throws -> SandboxedCommandResult {
        try await withCheckedThrowingContinuation { continuation in
            let box = ResultBox(continuation: continuation)

            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            process.standardOutput = stdoutPipe
            process.standardError = stderrPipe

            stdoutPipe.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                if data.isEmpty {
                    handle.readabilityHandler = nil
                    box.signalEvent()
                } else {
                    box.appendStdout(data)
                }
            }
            stderrPipe.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                if data.isEmpty {
                    handle.readabilityHandler = nil
                    box.signalEvent()
                } else {
                    box.appendStderr(data)
                }
            }

            process.terminationHandler = { finished in
                box.setExitCode(finished.terminationStatus)
                box.signalEvent()
            }

            do {
                try process.run()
            } catch {
                // No child, so no EOF and no termination will ever arrive. Tear the
                // handlers down by hand and fail the one and only continuation.
                stdoutPipe.fileHandleForReading.readabilityHandler = nil
                stderrPipe.fileHandleForReading.readabilityHandler = nil
                box.fail(SandboxExecError.launchFailed(error.localizedDescription))
                return
            }

            let pid = process.processIdentifier
            let timeoutWork = DispatchWorkItem {
                box.markTimedOut()
                guard process.isRunning else { return }
                process.terminate()
                // sandbox-exec execs into the command, so SIGTERM reaches the shell
                // itself. Grandchildren it spawned are not in the blast radius —
                // Foundation's Process cannot put a child in its own process group, so
                // there is no group to signal. Bounding a hostile process tree is a
                // container-tier property, not something this path can promise.
                DispatchQueue.global().asyncAfter(deadline: .now() + 1.0) {
                    if process.isRunning { kill(pid, SIGKILL) }
                }
            }
            box.armTimeout(timeoutWork)
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: timeoutWork)
        }
    }
}

/// Collects output and completion events from the queues Foundation delivers them on.
/// `@unchecked Sendable` because the lock is the invariant, not the type system.
private final class ResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private let startedAt = Date()

    private var stdout = Data()
    private var stderr = Data()
    private var exitCode: Int32 = -1
    private var timedOut = false
    private var outstandingEvents = 3
    private var continuation: CheckedContinuation<SandboxedCommandResult, Error>?
    private var timeoutWork: DispatchWorkItem?

    init(continuation: CheckedContinuation<SandboxedCommandResult, Error>) {
        self.continuation = continuation
    }

    func appendStdout(_ data: Data) {
        lock.lock(); stdout.append(data); lock.unlock()
    }

    func appendStderr(_ data: Data) {
        lock.lock(); stderr.append(data); lock.unlock()
    }

    func setExitCode(_ code: Int32) {
        lock.lock(); exitCode = code; lock.unlock()
    }

    func markTimedOut() {
        lock.lock(); timedOut = true; lock.unlock()
    }

    func armTimeout(_ work: DispatchWorkItem) {
        lock.lock(); timeoutWork = work; lock.unlock()
    }

    func signalEvent() {
        lock.lock()
        outstandingEvents -= 1
        guard outstandingEvents <= 0, let continuation else {
            lock.unlock()
            return
        }
        self.continuation = nil
        let work = timeoutWork
        timeoutWork = nil
        let result = SandboxedCommandResult(
            stdout: String(decoding: stdout, as: UTF8.self),
            stderr: String(decoding: stderr, as: UTF8.self),
            // 124 is the conventional exit code for "timed out", and matches what the
            // TypeScript workspace reports for the same condition.
            exitCode: timedOut ? 124 : exitCode,
            timedOut: timedOut,
            duration: Date().timeIntervalSince(startedAt)
        )
        lock.unlock()

        work?.cancel()
        continuation.resume(returning: result)
    }

    func fail(_ error: Error) {
        lock.lock()
        guard let continuation else {
            lock.unlock()
            return
        }
        self.continuation = nil
        let work = timeoutWork
        timeoutWork = nil
        lock.unlock()

        work?.cancel()
        continuation.resume(throwing: error)
    }
}
