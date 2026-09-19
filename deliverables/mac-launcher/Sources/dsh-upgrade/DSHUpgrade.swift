import Foundation
import UpgradeTransaction

/// `dsh-upgrade` — the plain CLI for the M6 upgrade and restore transaction.
/// It is never started automatically, never by a launcher or launchd job: an
/// upgrade runs only when the user explicitly triggers it after approving a
/// candidate in the desktop flow. Subcommands:
///
///     dsh-upgrade upgrade --candidate-root <dir> --identity <json>
///         --trial-record <json> --production-app <App> --production-data-home <dir>
///         [--backups-root <dir>] [--transaction-dir <dir>]
///         [--verify-command <cmd> [args...]]
///     dsh-upgrade restore (--from-backup <dir> | --from-last-good <json>)
///         --production-app <App> --production-data-home <dir> [options]
///     dsh-upgrade resume --transaction-dir <dir>
///     dsh-upgrade make-trial-record --candidate-identity <json>
///         --approved-by <name> --result-digest <64hex> --out <json>
///
/// Exit codes: 0 committed, 1 rolled back or needs-manual, 2 usage error.
/// A usage refusal; printed to stderr and mapped to exit code 2.
struct UsageFailure: Error {
    let message: String
}

@main
struct DSHUpgrade {

    static func main() {
        let arguments = CommandLine.arguments.dropFirst().map { $0 }
        guard let subcommand = arguments.first else {
            usage()
            exit(2)
        }
        let rest = Array(arguments.dropFirst())
        switch subcommand {
        case "upgrade": exit(runUpgrade(rest))
        case "restore": exit(runRestore(rest))
        case "resume": exit(runResume(rest))
        case "make-trial-record": exit(MakeTrialRecord.run(rest))
        case "--help", "-h", "help": usage(); exit(0)
        default:
            errorLine("unknown subcommand: \(subcommand)")
            usage()
            exit(2)
        }
    }

    // MARK: - Argument parsing

    struct Parsed {
        var values: [String: String] = [:]
        /// Arguments collected after `--verify-command`.
        var verifyCommand: [String] = []
    }

    /// Parses `--name value` pairs plus an optional terminal
    /// `--verify-command <cmd> [args...]`; unknown flags and missing values
    /// are usage errors, never silently ignored.
    static func parse(_ arguments: [String], flags: [String]) -> Result<Parsed, UsageFailure> {
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

    static func required(_ parsed: Parsed, _ flag: String) -> Result<URL, UsageFailure> {
        guard let value = parsed.values[flag] else {
            return .failure(UsageFailure(message: "missing required flag \(flag)"))
        }
        return absoluteURL(value, flag: flag)
    }

    static func absoluteURL(_ value: String, flag: String) -> Result<URL, UsageFailure> {
        guard !value.isEmpty, value.hasPrefix("/"),
              !value.split(separator: "/").contains("..") else {
            return .failure(UsageFailure(message: "\(flag) must be an absolute path without `..`"))
        }
        return .success(URL(fileURLWithPath: value, isDirectory: true))
    }

    static func parseOptions(from parsed: Parsed) -> Result<UpgradeEngine.Options, UsageFailure> {
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

    // MARK: - Subcommands

    static func runUpgrade(_ arguments: [String]) -> Int32 {
        let flags = ["--candidate-root", "--identity", "--trial-record",
                     "--production-app", "--production-data-home",
                     "--backups-root", "--transaction-dir"]
        let parsed: Parsed
        switch parse(arguments, flags: flags) {
        case let .failure(error): printUsageError(error); return 2
        case let .success(value): parsed = value
        }
        let options: UpgradeEngine.Options
        switch parseOptions(from: parsed) {
        case let .failure(error): printUsageError(error); return 2
        case let .success(value): options = value
        }
        let inputs: [(String, Result<URL, UsageFailure>)] = [
            ("--candidate-root", required(parsed, "--candidate-root")),
            ("--identity", required(parsed, "--identity")),
            ("--trial-record", required(parsed, "--trial-record")),
            ("--production-app", required(parsed, "--production-app")),
            ("--production-data-home", required(parsed, "--production-data-home")),
        ]
        var urls: [String: URL] = [:]
        for (flag, result) in inputs {
            switch result {
            case let .failure(error): printUsageError(error); return 2
            case let .success(url): urls[flag] = url
            }
        }
        let outcome = UpgradeEngine.upgrade(
            candidateRoot: urls["--candidate-root"]!,
            identityPath: urls["--identity"]!,
            trialRecordPath: urls["--trial-record"]!,
            productionApp: urls["--production-app"]!,
            productionDataHome: urls["--production-data-home"]!,
            options: options)
        return report(outcome)
    }

    static func runRestore(_ arguments: [String]) -> Int32 {
        let flags = ["--from-backup", "--from-last-good", "--production-app",
                     "--production-data-home", "--backups-root", "--transaction-dir"]
        let parsed: Parsed
        switch parse(arguments, flags: flags) {
        case let .failure(error): printUsageError(error); return 2
        case let .success(value): parsed = value
        }
        let options: UpgradeEngine.Options
        switch parseOptions(from: parsed) {
        case let .failure(error): printUsageError(error); return 2
        case let .success(value): options = value
        }
        let source: RestoreSource
        switch (parsed.values["--from-backup"], parsed.values["--from-last-good"]) {
        case (.some, .some(let lastGood)):
            printUsageError(UsageFailure(message: "--from-backup and --from-last-good are mutually exclusive; both given (\(lastGood))"))
            return 2
        case let (.some(backup), .none):
            switch absoluteURL(backup, flag: "--from-backup") {
            case let .failure(error): printUsageError(error); return 2
            case let .success(url): source = .backupDirectory(url)
            }
        case let (.none, .some(lastGood)):
            switch absoluteURL(lastGood, flag: "--from-last-good") {
            case let .failure(error): printUsageError(error); return 2
            case let .success(url): source = .lastGoodRecord(url)
            }
        default:
            printUsageError(UsageFailure(message: "one of --from-backup or --from-last-good is required"))
            return 2
        }
        let productionApp: URL
        let dataHome: URL
        switch (required(parsed, "--production-app"), required(parsed, "--production-data-home")) {
        case let (.failure(error), _):
            printUsageError(error); return 2
        case let (_, .failure(error)):
            printUsageError(error); return 2
        case let (.success(app), .success(home)):
            productionApp = app
            dataHome = home
        }
        return report(UpgradeEngine.restore(
            source: source, productionApp: productionApp,
            productionDataHome: dataHome, options: options))
    }

    static func runResume(_ arguments: [String]) -> Int32 {
        let parsed: Parsed
        switch parse(arguments, flags: ["--transaction-dir"]) {
        case let .failure(error): printUsageError(error); return 2
        case let .success(value): parsed = value
        }
        let directory: URL
        switch required(parsed, "--transaction-dir") {
        case let .failure(error): printUsageError(error); return 2
        case let .success(url): directory = url
        }
        return report(UpgradeEngine.resume(transactionDirectory: directory))
    }

    /// Prints every message and maps the outcome to a process exit code.
    static func report(_ outcome: UpgradeOutcome) -> Int32 {
        for message in outcome.messages {
            print(message)
        }
        if let record = outcome.record {
            print("transaction: \(record.kind) state=\(outcome.state.rawValue)")
        }
        switch outcome.state {
        case .committed: return 0
        case .rolledBack, .needsManual: return 1
        default: return 1
        }
    }

    static let standardError = FileHandleTextOutputStream(handle: .standardError)

    static func errorLine(_ message: String) {
        FileHandle.standardError.write(Data("dsh-upgrade: \(message)\n".utf8))
    }

    static func printUsageError(_ failure: UsageFailure) {
        errorLine(failure.message)
    }

    static func usage() {
        print("""
        usage:
          dsh-upgrade upgrade --candidate-root <dir> --identity <json> --trial-record <json> \\
              --production-app <App> --production-data-home <dir> \\
              [--backups-root <dir>] [--transaction-dir <dir>] [--verify-command <cmd> [args...]]
          dsh-upgrade restore (--from-backup <dir> | --from-last-good <json>) \\
              --production-app <App> --production-data-home <dir> [options]
          dsh-upgrade resume --transaction-dir <dir>
          dsh-upgrade make-trial-record --candidate-identity <json> --approved-by <name> \\
              --result-digest <64hex> --out <json>
        """)
    }
}

struct FileHandleTextOutputStream: TextOutputStream {
    let handle: FileHandle

    mutating func write(_ string: String) {
        handle.write(Data(string.utf8))
    }
}
