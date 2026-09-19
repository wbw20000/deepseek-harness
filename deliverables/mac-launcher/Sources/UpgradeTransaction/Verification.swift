import Foundation

/// The post-switch verification: one injected command run against the
/// installed App. The engine treats exit 0 as pass and anything else —
/// including a crash, a timeout, or an unlaunchable command — as failure,
/// which rolls the transaction back to the paired backup.
public struct Verification {

    /// How long a verify command may run before it is killed and treated as
    /// a failure.
    public static let defaultTimeout: TimeInterval = 120

    public enum VerifyError: Error, Equatable {
        case commandUnavailable(String)
        case timedOut(String)
        case exitStatus(Int32, String)
    }

    public let command: [String]

    /// - Parameter command: absolute program path plus arguments; the
    ///   program must exist and be executable.
    public init(command: [String]) {
        self.command = command
    }

    /// The default probe: run the installed bundle's own executable with
    /// `--version`, so verification never depends on this module.
    public static func defaultCommand(forApp app: URL) -> [String] {
        let executable = app.appendingPathComponent("Contents/MacOS")
            .appendingPathComponent(app.lastPathComponent.replacingOccurrences(
                of: ".app", with: ""))
        return [executable.path, "--version"]
    }

    /// Accumulates child output from the pipe-reader callbacks.
    private final class TranscriptBox {
        private let lock = NSLock()
        private var data = Data()

        func append(_ bytes: Data) {
            lock.lock()
            data.append(bytes)
            lock.unlock()
        }

        var value: String {
            lock.lock()
            defer { lock.unlock() }
            return String(data: data, encoding: .utf8) ?? ""
        }
    }

    /// Runs the command once, bounded by the timeout. Stdout and stderr are
    /// read while the child runs — a chatty child can never fill the pipe
    /// buffer and block on its own write — and captured for the transaction
    /// detail.
    @discardableResult
    public func run(timeout: TimeInterval = Verification.defaultTimeout)
        -> Result<String, VerifyError> {
        guard let executable = command.first, !executable.isEmpty,
              FileManager.default.isExecutableFile(atPath: executable) else {
            return .failure(.commandUnavailable(command.joined(separator: " ")))
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = Array(command.dropFirst())
        let stdout = TranscriptBox()
        let stderr = TranscriptBox()
        let output = Pipe()
        let errors = Pipe()
        process.standardOutput = output
        process.standardError = errors
        // The handler runs on a Foundation queue; it drains the pipe until
        // EOF and must be detached before any post-exit read.
        output.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
            } else {
                stdout.append(data)
            }
        }
        errors.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
            } else {
                stderr.append(data)
            }
        }
        do {
            try process.run()
        } catch {
            output.fileHandleForReading.readabilityHandler = nil
            errors.fileHandleForReading.readabilityHandler = nil
            return .failure(.commandUnavailable("\(executable): \(error)"))
        }
        let finished = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in finished.signal() }
        guard finished.wait(timeout: .now() + timeout) == .success else {
            process.terminate()
            _ = finished.wait(timeout: .now() + 5)
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            output.fileHandleForReading.readabilityHandler = nil
            errors.fileHandleForReading.readabilityHandler = nil
            return .failure(.timedOut(command.joined(separator: " ")))
        }
        process.waitUntilExit()
        output.fileHandleForReading.readabilityHandler = nil
        errors.fileHandleForReading.readabilityHandler = nil
        let transcript = [stdout.value, stderr.value]
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        switch process.terminationStatus {
        case 0:
            return .success(transcript)
        default:
            return .failure(.exitStatus(process.terminationStatus, command.joined(separator: " ")))
        }
    }
}
