import Foundation
import Darwin

/// Append-only launcher diagnostics written to the user's log directory.
/// Child stdout/stderr are never captured raw: every line is redacted through
/// `Redaction` and the file is capped, so the launch token cannot reach disk
/// and the log cannot grow without bound. Main-queue confined; the owning
/// controller marshals writes onto the main queue.
public final class DiagnosticLog {

    /// Total bytes after which the log stops accepting lines.
    public static let defaultMaxBytes = 256 * 1024

    /// Location of the log file.
    public let url: URL
    private let fileHandle: FileHandle
    private let maxBytes: Int
    private var bytesWritten = 0
    private var secrets: [String] = []
    private var refusedFurtherWrites = false

    /// Open (and truncate) the log file. A previous run's content is discarded
    /// because child output is not retained across runs in any form.
    /// - Parameters:
    ///   - url: destination file; created owner-only (0600) when absent.
    ///   - maxBytes: total cap; further writes are refused once exceeded.
    /// - Throws: filesystem errors from creating or opening the file.
    public init(url: URL, maxBytes: Int = DiagnosticLog.defaultMaxBytes) throws {
        self.url = url
        self.maxBytes = maxBytes
        let descriptor = Darwin.open(url.path, O_WRONLY | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG else {
            Darwin.close(descriptor)
            throw POSIXError(.EINVAL)
        }
        guard fchmod(descriptor, 0o600) == 0 else {
            let code = errno
            Darwin.close(descriptor)
            throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO)
        }
        fileHandle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        try fileHandle.truncate(atOffset: 0)
    }

    /// Register an observed secret (the launch token once readiness parses) so
    /// it is erased from every later line as defense in depth.
    public func addSecret(_ secret: String) {
        guard !secret.isEmpty else { return }
        secrets.append(secret)
    }

    /// Write one redacted, bounded line with a timestamp. Never throws: a log
    /// failure must not fail the lifecycle it is diagnosing.
    public func write(_ line: String) {
        guard !refusedFurtherWrites else { return }
        guard let loggable = Redaction.loggable(line, secrets: secrets) else { return }
        let stamped = "\(Self.timestamp()) \(loggable)\n"
        let data = Data(stamped.utf8)
        if bytesWritten + data.count > maxBytes {
            refusedFurtherWrites = true
            writeBounded(Data("launcher: diagnostic log reached its byte cap; later lines were dropped\n".utf8))
            return
        }
        writeBounded(data)
    }

    private func writeBounded(_ data: Data) {
        guard data.count <= maxBytes - bytesWritten else { return }
        do {
            try fileHandle.seekToEnd()
            try fileHandle.write(contentsOf: data)
            bytesWritten += data.count
        } catch {
            refusedFurtherWrites = true
        }
    }

    static func timestamp() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return formatter.string(from: Date())
    }
}
