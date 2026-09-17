import Foundation

/// Buffers raw child-output bytes into complete lines across arbitrary chunk
/// splits, so a token or URL split across two pipe reads is still scanned as one
/// line. Lines are bounded: output that never terminates keeps accumulating only
/// up to the bound and is then reported as truncated, never persisted raw.
public final class OutputAssembler {

    /// One decoded line of child output.
    public enum Line: Equatable {
        /// A complete line (terminated by a newline or by end of stream).
        case text(String)
        /// A line that exceeded the byte bound; its payload is empty so even
        /// a partial token cannot escape into diagnostics.
        case truncated(String)
    }

    /// Maximum buffered bytes for one line. Backend lines are short; the bound
    /// only exists so a pathological stream cannot grow memory or a log.
    public static let defaultMaxLineBytes = 8_192

    private let maxLineBytes: Int
    private var pending = Data()
    private var truncateCurrentLine = false

    /// - Parameter maxLineBytes: bound for a single buffered line.
    public init(maxLineBytes: Int = OutputAssembler.defaultMaxLineBytes) {
        self.maxLineBytes = maxLineBytes
    }

    /// Ingest one read from the child's pipe and return every line it completed.
    /// Decoding happens per completed line, so multibyte characters split across
    /// chunks survive intact.
    public func ingest(_ data: Data) -> [Line] {
        var lines: [Line] = []
        for byte in data {
            if byte == 0x0A {
                if let line = emitPending(terminated: true) {
                    lines.append(line)
                }
            } else if pending.count >= maxLineBytes {
                truncateCurrentLine = true
                pending.removeAll(keepingCapacity: false)
            } else {
                pending.append(byte)
            }
        }
        return lines
    }

    /// Flush at end of stream; returns a trailing partial line if one remained.
    public func finish() -> [Line] {
        let line = emitPending(terminated: false)
        return line.map { [$0] } ?? []
    }

    private func emitPending(terminated: Bool) -> Line? {
        if truncateCurrentLine {
            truncateCurrentLine = false
            pending.removeAll(keepingCapacity: false)
            return .truncated("")
        }
        guard !pending.isEmpty || terminated else { return nil }
        // A lone "\r" from CRLF output is stripped; decoding is lossy for
        // non-UTF-8 bytes, which never carry a readiness line.
        if pending.last == 0x0D { pending.removeLast() }
        let text = String(decoding: pending, as: UTF8.self)
        pending.removeAll(keepingCapacity: false)
        return .text(text)
    }
}
