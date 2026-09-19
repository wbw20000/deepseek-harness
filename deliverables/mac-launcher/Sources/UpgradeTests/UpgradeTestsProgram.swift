import Foundation
@testable import UpgradeTransaction

/// Executable test runner for the upgrade transaction, in the same style as
/// `RecoveryTests`: everything runs on the main actor in private temporary
/// directories, the process exits nonzero when any check failed. The
/// `--hold-lock` mode is a separate short-lived process for the concurrency
/// test: it takes a transaction lock, signals readiness, and holds until the
/// test parent terminates it.
@main
struct UpgradeTestsProgram {

    @MainActor
    static func main() {
        let arguments = CommandLine.arguments
        if arguments.count == 4, arguments[1] == "--hold-lock" {
            let directory = URL(fileURLWithPath: arguments[2], isDirectory: true)
            let readyFile = URL(fileURLWithPath: arguments[3])
            switch TransactionLock.acquire(directory: directory) {
            case .failure:
                FileHandle.standardError.write(Data("holder could not acquire the lock\n".utf8))
                exit(3)
            case .success(let lock):
                try? Data().write(to: readyFile)
                _ = sleep(120)
                lock.release()
                exit(0)
            }
        }
        guard arguments.count == 1 else {
            print("usage: UpgradeTests [--hold-lock <dir> <readyfile>]")
            exit(2)
        }
        exit(runSuites())
    }

    @MainActor
    private static func runSuites() -> Int32 {
        let runner = UpgradeTestRunner()
        let suites: [(String, @MainActor (UpgradeTestRunner) -> Void)] = [
            ("upgrade input binding", { BindingTests().run($0) }),
            ("upgrade transaction path", { UpgradePathTests().run($0) }),
            ("verification failure rollback", { RollbackTests().run($0) }),
            ("interrupted transaction recovery", { InterruptionTests().run($0) }),
            ("restore to the previous version", { RestoreTests().run($0) }),
            ("transaction lock", { LockTests().run($0) }),
            ("marker failure rollback", { MarkerFailureRollbackTests().run($0) }),
            ("lock before reconciliation", { LockBeforeReconcileTests().run($0) }),
            ("failed backup cleanup", { FailedBackupCleanupTests().run($0) }),
            ("recovery entry rollback", { RecoveryEntryRollbackTests().run($0) }),
            ("rollback record persist failure", { RollbackRecordFailureTests().run($0) }),
            ("manual trial record bridge", { ManualBridgeTests().run($0) }),
        ]
        return runner.runAll(suites)
    }
}

@MainActor
final class UpgradeTestRunner {

    private(set) var failures = 0
    private(set) var checks = 0
    private var currentSuite = ""

    func runAll(_ suites: [(name: String, run: @MainActor (UpgradeTestRunner) -> Void)]) -> Int32 {
        let startedAt = Date()
        for suite in suites {
            currentSuite = suite.name
            print("=== \(suite.name)")
            suite.run(self)
        }
        let seconds = String(format: "%.1f", Date().timeIntervalSince(startedAt))
        print("checks: \(checks), failures: \(failures), time: \(seconds)s")
        return failures == 0 ? 0 : 1
    }

    func check(_ condition: Bool, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        checks += 1
        if condition {
            print("  ok: \(label)")
        } else {
            failures += 1
            print("  FAIL: \(label) (\(currentSuite) at \(file):\(line))")
        }
    }
}

enum TempDir {
    static func make(_ label: String) -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("upgrade-tests-\(label)-\(UUID().uuidString)", isDirectory: true)
        try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
        return url
    }

    static func remove(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }
}
