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
/// Argument parsing is shared with the in-process command surface in
/// `UpgradeCLI`; this executable only maps outcomes to exit codes and
/// streams.
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

    // MARK: - Subcommands

    static func runUpgrade(_ arguments: [String]) -> Int32 {
        let flags = ["--candidate-root", "--identity", "--trial-record",
                     "--production-app", "--production-data-home",
                     "--backups-root", "--transaction-dir"]
        let parsed: UpgradeCLI.Parsed
        switch UpgradeCLI.parse(arguments, flags: flags) {
        case let .failure(error): printUsageError(error); return 2
        case let .success(value): parsed = value
        }
        let options: UpgradeEngine.Options
        switch UpgradeCLI.parseOptions(from: parsed) {
        case let .failure(error): printUsageError(error); return 2
        case let .success(value): options = value
        }
        let inputs: [(String, Result<URL, UsageFailure>)] = [
            ("--candidate-root", UpgradeCLI.required(parsed, "--candidate-root")),
            ("--identity", UpgradeCLI.required(parsed, "--identity")),
            ("--trial-record", UpgradeCLI.required(parsed, "--trial-record")),
            ("--production-app", UpgradeCLI.required(parsed, "--production-app")),
            ("--production-data-home", UpgradeCLI.required(parsed, "--production-data-home")),
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
        let parsed: UpgradeCLI.Parsed
        switch UpgradeCLI.parse(arguments, flags: flags) {
        case let .failure(error): printUsageError(error); return 2
        case let .success(value): parsed = value
        }
        let options: UpgradeEngine.Options
        switch UpgradeCLI.parseOptions(from: parsed) {
        case let .failure(error): printUsageError(error); return 2
        case let .success(value): options = value
        }
        let source: RestoreSource
        switch (parsed.values["--from-backup"], parsed.values["--from-last-good"]) {
        case (.some, .some(let lastGood)):
            printUsageError(UsageFailure(message: "--from-backup and --from-last-good are mutually exclusive; both given (\(lastGood))"))
            return 2
        case let (.some(backup), .none):
            switch UpgradeCLI.absoluteURL(backup, flag: "--from-backup") {
            case let .failure(error): printUsageError(error); return 2
            case let .success(url): source = .backupDirectory(url)
            }
        case let (.none, .some(lastGood)):
            switch UpgradeCLI.absoluteURL(lastGood, flag: "--from-last-good") {
            case let .failure(error): printUsageError(error); return 2
            case let .success(url): source = .lastGoodRecord(url)
            }
        default:
            printUsageError(UsageFailure(message: "one of --from-backup or --from-last-good is required"))
            return 2
        }
        let productionApp: URL
        let dataHome: URL
        switch (UpgradeCLI.required(parsed, "--production-app"),
                UpgradeCLI.required(parsed, "--production-data-home")) {
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
        let parsed: UpgradeCLI.Parsed
        switch UpgradeCLI.parse(arguments, flags: ["--transaction-dir"]) {
        case let .failure(error): printUsageError(error); return 2
        case let .success(value): parsed = value
        }
        let directory: URL
        switch UpgradeCLI.required(parsed, "--transaction-dir") {
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
