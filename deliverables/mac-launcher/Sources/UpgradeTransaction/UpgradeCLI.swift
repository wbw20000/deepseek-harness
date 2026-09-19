import Foundation

/// A `dsh-upgrade` usage refusal: printed to the user and mapped to exit
/// code 2 by the CLI surface.
public struct UsageFailure: Error {
    public let message: String

    public init(message: String) {
        self.message = message
    }
}

/// Shared `--flag value` argument parsing for the `dsh-upgrade` CLI surface.
/// It lives in the library so `MakeTrialRecordCommand` (called in-process by
/// `UpgradeTests`) and the thin `dsh-upgrade` executable parse arguments
/// identically — one parser, one set of refusals.
public enum UpgradeCLI {

    public struct Parsed {
        public var values: [String: String] = [:]
        /// Arguments collected after `--verify-command`.
        public var verifyCommand: [String] = []

        public init() {}
    }

    /// Parses `--name value` pairs plus an optional terminal
    /// `--verify-command <cmd> [args...]`; unknown flags and missing values
    /// are usage errors, never silently ignored.
    public static func parse(_ arguments: [String], flags: [String]) -> Result<Parsed, UsageFailure> {
        var parsed = Parsed()
        var index = 0
        while index < arguments.count {
            let token = arguments[index]
            guard token.hasPrefix("--") else {
                return .failure(UsageFailure(message: "unexpected argument: \(token)"))
            }
            guard token != "--verify-command" else {
                let command = Array(arguments[(index + 1)...])
                guard !command.isEmpty else {
                    return .failure(UsageFailure(message: "--verify-command needs a command"))
                }
                parsed.verifyCommand = command
                return .success(parsed)
            }
            guard flags.contains(token) else {
                return .failure(UsageFailure(message: "unknown flag: \(token)"))
            }
            guard index + 1 < arguments.count else {
                return .failure(UsageFailure(message: "\(token) needs a value"))
            }
            parsed.values[token] = arguments[index + 1]
            index += 2
        }
        return .success(parsed)
    }

    /// The value of `flag` as an absolute URL, or a usage failure naming the
    /// missing flag.
    public static func required(_ parsed: Parsed, _ flag: String) -> Result<URL, UsageFailure> {
        guard let value = parsed.values[flag] else {
            return .failure(UsageFailure(message: "missing required flag \(flag)"))
        }
        return absoluteURL(value, flag: flag)
    }

    public static func absoluteURL(_ value: String, flag: String) -> Result<URL, UsageFailure> {
        guard !value.isEmpty, value.hasPrefix("/"),
              !value.split(separator: "/").contains("..") else {
            return .failure(UsageFailure(message: "\(flag) must be an absolute path without `..`"))
        }
        return .success(URL(fileURLWithPath: value, isDirectory: true))
    }

    public static func parseOptions(from parsed: Parsed) -> Result<UpgradeEngine.Options, UsageFailure> {
        var options = UpgradeEngine.Options()
        if let value = parsed.values["--transaction-dir"] {
            switch absoluteURL(value, flag: "--transaction-dir") {
            case let .failure(error): return .failure(error)
            case let .success(url): options.transactionDirectory = url
            }
        }
        if let value = parsed.values["--backups-root"] {
            switch absoluteURL(value, flag: "--backups-root") {
            case let .failure(error): return .failure(error)
            case let .success(url): options.backupsRoot = url
            }
        }
        if !parsed.verifyCommand.isEmpty {
            options.verifyCommand = parsed.verifyCommand
        }
        return .success(options)
    }
}
