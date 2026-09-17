import Foundation

/// Prepares child output lines for logging and diagnostics without ever
/// releasing the launch token. Every value that leaves the launcher
/// (disk log, alert text, status text) passes through here first.
public enum Redaction {

    /// Placeholder written in place of any token value.
    public static let placeholder = "<redacted>"

    /// Replaces `token=<value>` query values and every supplied secret with the
    /// placeholder. Idempotent: redacting an already-redacted line is a no-op.
    /// - Parameters:
    ///   - line: one output line or diagnostic fragment.
    ///   - secrets: exact strings (such as the observed launch token) to erase
    ///     in addition to the `token=` pattern.
    /// - Returns: the line with every secret replaced; never contains a
    ///   `token=` value or one of `secrets` when the caller supplied the token.
    public static func redact(_ line: String, secrets: [String] = []) -> String {
        var result = tokenPattern.stringByReplacingMatches(
            in: line, range: NSRange(line.startIndex..., in: line),
            withTemplate: "token=\(placeholder)")
        for secret in secrets where !secret.isEmpty {
            result = result.replacingOccurrences(of: secret, with: placeholder)
        }
        return result
    }

    /// Prepare one line for the disk log: redact first, then bound the length.
    /// Redaction before truncation means a cut can never expose a partial token.
    /// - Parameters:
    ///   - line: one output line.
    ///   - secrets: exact secrets to erase (see `redact`).
    ///   - maxCharacters: maximum returned length, including the truncation mark.
    /// - Returns: the bounded redacted line, or `nil` for whitespace-only input
    ///   or a nonpositive limit. Small limits contain only a truncated marker.
    public static func loggable(_ line: String, secrets: [String] = [], maxCharacters: Int = 500) -> String? {
        guard maxCharacters > 0 else { return nil }
        let redacted = redact(line, secrets: secrets).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !redacted.isEmpty else { return nil }
        guard redacted.count > maxCharacters else { return redacted }
        guard maxCharacters > truncationMark.count else {
            return String(truncationMark.prefix(maxCharacters))
        }
        return String(redacted.prefix(maxCharacters - truncationMark.count)) + truncationMark
    }

    static let truncationMark = "…<truncated>"

    /// Matches a non-empty `token=` query value up to the next query separator
    /// or whitespace. The upstream launch token is `[A-Za-z0-9_-]+`, but the
    /// pattern is value-agnostic so percent-encoded values are covered too.
    static let tokenPattern: NSRegularExpression = {
        // swiftlint:disable:next force_try — the pattern is a fixed literal verified by tests.
        try! NSRegularExpression(pattern: "token=[^&\\s]+")
    }()
}
