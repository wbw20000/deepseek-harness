import Foundation
import Darwin
@testable import UpgradeTransaction

/// K3 review regressions. Each suite reproduces one reviewed defect and
/// asserts the repaired behavior; everything runs in private temporary
/// directories.
///
/// - marker write failure: the rollback must undo exactly the side effects
///   that happened (the ledger), restore the App, and never report a false
///   `rolled-back` while the candidate is still installed.
/// - lock: `resume`/`upgrade`/`restore` must take the transaction lock
///   before they read or write any transaction file, so a second process —
///   or a second handle in the same process — is refused with zero side
///   effects while a transaction is in progress.
/// - failed backups leave no half-built directory; a partial Recovery entry
///   installation is rolled back from the paired backup.
/// - `make-trial-record` formats and binds a manual trial record, and the
///   engine records `trialRecordSource: manual-bridge` for it.
@MainActor
struct MarkerFailureRollbackTests {

    func run(_ runner: UpgradeTestRunner) {
        let root = TempDir.make("marker-failure")
        defer { TempDir.remove(root) }
        let fixture = UpgradeFixture.make("marker", in: root)
        let before = UpgradeFixture.productionExecutableBytes(fixture)
        // A directory where the marker belongs makes the marker rename fail
        // after the App switch has already happened.
        let markerURL = fixture.productionDataHome.appendingPathComponent("data-version.json")
        try! FileManager.default.removeItem(at: markerURL)
        try! FileManager.default.createDirectory(at: markerURL, withIntermediateDirectories: true)
        UpgradeFixture.write(Data("unrelated".utf8), to: markerURL.appendingPathComponent("keep"))

        let outcome = UpgradeEngine.upgrade(
            candidateRoot: fixture.candidateRoot,
            identityPath: fixture.identityURL,
            trialRecordPath: fixture.trialRecordURL,
            productionApp: fixture.productionApp,
            productionDataHome: fixture.productionDataHome,
            options: UpgradeFixture.options())
        runner.check(outcome.state == .rolledBack,
                     "a failed marker write ends in rolled-back, not a false success")
        runner.check(before == UpgradeFixture.productionExecutableBytes(fixture),
                     "the rollback restored the production App to the pre-upgrade bytes")
        if let record = outcome.record {
            runner.check(record.state == .rolledBack, "the record state is rolled-back")
            runner.check(record.sideEffects?.swap == true,
                         "the ledger records that the App was switched")
            runner.check(record.sideEffects?.marker == false,
                         "the ledger records that the marker was not written")
            runner.check(record.replacedAppPath != nil,
                         "the ledger records the replaced bundle path")
        } else {
            runner.check(false, "the rollback record is returned")
        }
        var isDirectory: ObjCBool = false
        runner.check(FileManager.default.fileExists(atPath: markerURL.path, isDirectory: &isDirectory)
                     && isDirectory.boolValue,
                     "the pre-existing marker path (a directory here) is not deleted by the rollback")
        let residue = try? FileManager.default.contentsOfDirectory(atPath: fixture.root.path)
            .filter { $0.hasPrefix(".DeepSeek Harness.app.") }
        runner.check(residue?.isEmpty ?? false, "no switched residue survives the rollback")
    }
}

/// Every transaction-file entry point refuses while the lock is held — with
/// a second handle in this process and with a real second process — and a
/// held lock never lets `resume` reconcile an in-progress transaction.
@MainActor
struct LockBeforeReconcileTests {

    func run(_ runner: UpgradeTestRunner) {
        // Two handles, one process: a drilled `switched` transaction stays
        // untouched while the lock is held.
        let root = TempDir.make("lock-reconcile")
        defer { TempDir.remove(root) }
        let fixture = UpgradeFixture.make("lockrec", in: root)
        let drill = UpgradeEngine.upgrade(
            candidateRoot: fixture.candidateRoot,
            identityPath: fixture.identityURL,
            trialRecordPath: fixture.trialRecordURL,
            productionApp: fixture.productionApp,
            productionDataHome: fixture.productionDataHome,
            options: UpgradeFixture.options(stopAfter: .switched))
        runner.check(drill.state == .switched, "the drill leaves the record at switched")
        let recordURL = root.appendingPathComponent("upgrade-transaction.json")
        let recordBefore = try! Data(contentsOf: recordURL)
        let candidateBytes = try! Data(contentsOf: fixture.candidateApp
            .appendingPathComponent("Contents/MacOS/DeepSeek Harness"))

        guard case .success(let held) = TransactionLock.acquire(directory: root) else {
            runner.check(false, "the test acquires the transaction lock (first handle)")
            return
        }
        runner.check(true, "the test acquires the transaction lock (first handle)")
        let resumed = UpgradeEngine.resume(transactionDirectory: root)
        runner.check(resumed.state == .needsManual
                     && resumed.messages.contains(where: { $0.contains("another transaction is active") }),
                     "resume under a held lock is refused, not reconciled")
        runner.check((try! Data(contentsOf: recordURL)) == recordBefore,
                     "the refused resume changed no transaction byte")
        runner.check((try! Data(contentsOf: fixture.productionApp
            .appendingPathComponent("Contents/MacOS/DeepSeek Harness"))) == candidateBytes,
                     "the refused resume did not roll the switched App back")
        let upgraded = UpgradeEngine.upgrade(
            candidateRoot: fixture.candidateRoot,
            identityPath: fixture.identityURL,
            trialRecordPath: fixture.trialRecordURL,
            productionApp: fixture.productionApp,
            productionDataHome: fixture.productionDataHome,
            options: UpgradeFixture.options())
        runner.check(upgraded.state == .needsManual
                     && upgraded.messages.contains(where: { $0.contains("another transaction is active") }),
                     "upgrade under a held lock is refused before reconciliation")
        runner.check((try! Data(contentsOf: recordURL)) == recordBefore,
                     "the refused upgrade changed no transaction byte")
        held.release()

        let reconciled = UpgradeEngine.resume(transactionDirectory: root)
        runner.check(reconciled.state == .rolledBack,
                     "after the lock is released, resume reconciles the interrupted transaction")
        runner.check(
            (try! Data(contentsOf: fixture.productionApp
                .appendingPathComponent("Contents/MacOS/DeepSeek Harness")))
            == UpgradeFixture.productionExecutableBytes(fixture),
            "the released reconciliation restored the previous App")

        // A real second process: the holder keeps the lock while this
        // process asks for reconciliation.
        let processRoot = TempDir.make("lock-reconcile-process")
        defer { TempDir.remove(processRoot) }
        let processFixture = UpgradeFixture.make("lockrec2", in: processRoot)
        let processDrill = UpgradeEngine.upgrade(
            candidateRoot: processFixture.candidateRoot,
            identityPath: processFixture.identityURL,
            trialRecordPath: processFixture.trialRecordURL,
            productionApp: processFixture.productionApp,
            productionDataHome: processFixture.productionDataHome,
            options: UpgradeFixture.options(stopAfter: .switched))
        runner.check(processDrill.state == .switched,
                     "the second-process drill leaves the record at switched")
        let processRecordURL = processRoot.appendingPathComponent("upgrade-transaction.json")
        let processRecordBefore = try! Data(contentsOf: processRecordURL)
        let readyFile = processRoot.appendingPathComponent("holder-ready")
        let holder = Process()
        holder.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        holder.arguments = ["--hold-lock", processRoot.path, readyFile.path]
        try? holder.run()
        var holderRan = true
        let deadline = Date().addingTimeInterval(30)
        while !FileManager.default.fileExists(atPath: readyFile.path) {
            if !holder.isRunning || Date() > deadline {
                holderRan = false
                break
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        if holderRan {
            let refused = UpgradeEngine.resume(transactionDirectory: processRoot)
            runner.check(refused.state == .needsManual,
                         "a second process cannot resume the transaction the holder owns")
            runner.check((try! Data(contentsOf: processRecordURL)) == processRecordBefore,
                         "the refused second process changed no transaction byte")
        } else {
            runner.check(false, "the lock holder process started")
        }
        holder.terminate()
        holder.waitUntilExit()
    }
}

/// A backup that fails midway is removed entirely — never left behind as a
/// half-built directory a later restore could mistake for a complete pair.
@MainActor
struct FailedBackupCleanupTests {

    func run(_ runner: UpgradeTestRunner) {
        let root = TempDir.make("backup-residue")
        defer { TempDir.remove(root) }
        let fixture = UpgradeFixture.make("backup", in: root)
        let fifo = fixture.productionDataHome.appendingPathComponent("pipe")
        runner.check(mkfifo(fifo.path, 0o644) == 0, "the test creates the blocking FIFO")
        let outcome = UpgradeEngine.upgrade(
            candidateRoot: fixture.candidateRoot,
            identityPath: fixture.identityURL,
            trialRecordPath: fixture.trialRecordURL,
            productionApp: fixture.productionApp,
            productionDataHome: fixture.productionDataHome,
            options: UpgradeFixture.options())
        runner.check(outcome.state == .rolledBack,
                     "a backup failure ends in rolled-back with nothing switched")
        let backupsRoot = root.appendingPathComponent("upgrade-backups")
        let leftovers = (try? FileManager.default.contentsOfDirectory(atPath: backupsRoot.path)) ?? []
        runner.check(leftovers.isEmpty,
                     "no half-built backup directory survives the failed backup")
        runner.check(FileManager.default.fileExists(atPath: fifo.path),
                     "the production data home is untouched by the refused backup")
        runner.check(
            UpgradeFixture.productionExecutableBytes(fixture)
                == Data("production executable before upgrade".utf8),
            "the production App is untouched by the refused backup")
    }
}

/// A Recovery entry installation that stops halfway is rolled back from the
/// paired backup: a pre-existing entry returns to its old bytes, an entry
/// that did not exist before the upgrade is removed again.
@MainActor
struct RecoveryEntryRollbackTests {

    func run(_ runner: UpgradeTestRunner, preExisting: Bool) {
        let label = preExisting ? "recovery-rollback-existing" : "recovery-rollback-new"
        let root = TempDir.make(label)
        defer { TempDir.remove(root) }
        let fixture = UpgradeFixture.make(label, in: root)
        let firstEntry = AppSwitch.recoveryEntryNames[0]
        let entryExecutable = fixture.root
            .appendingPathComponent(firstEntry, isDirectory: true)
            .appendingPathComponent("Contents/MacOS/Recovery")
        if preExisting {
            UpgradeFixture.write(Data("old recovery entry bytes".utf8),
                                 to: entryExecutable, executable: true)
        }
        // The second candidate entry cannot be copied, so the installation
        // stops after the first entry was already put in place.
        let brokenEntry = fixture.candidateRoot
            .appendingPathComponent(AppSwitch.recoveryEntryNames[1], isDirectory: true)
            .appendingPathComponent("Contents/MacOS/Recovery")
        try? FileManager.default.removeItem(at: brokenEntry)
        runner.check(mkfifo(brokenEntry.path, 0o644) == 0,
                     "the test makes the second candidate entry uncopiable")

        let outcome = UpgradeEngine.upgrade(
            candidateRoot: fixture.candidateRoot,
            identityPath: fixture.identityURL,
            trialRecordPath: fixture.trialRecordURL,
            productionApp: fixture.productionApp,
            productionDataHome: fixture.productionDataHome,
            options: UpgradeFixture.options())
        runner.check(outcome.state == .rolledBack,
                     "a failed Recovery entry installation rolls back")
        if preExisting {
            runner.check(
                (try? Data(contentsOf: entryExecutable)) == Data("old recovery entry bytes".utf8),
                "the rollback restored the pre-existing entry's old bytes")
        } else {
            runner.check(!FileManager.default.fileExists(atPath: fixture.root
                .appendingPathComponent(firstEntry, isDirectory: true).path),
                         "the rollback removed the entry that did not exist before")
        }
        let residue = try? FileManager.default.contentsOfDirectory(atPath: fixture.root.path)
            .filter { $0.hasPrefix(".") }
        runner.check(residue?.isEmpty ?? false, "no entry installation residue survives")
    }

    func run(_ runner: UpgradeTestRunner) {
        run(runner, preExisting: true)
        run(runner, preExisting: false)
    }
}

/// A rollback whose transaction file cannot be updated reports needs-manual
/// with the persist failure — it never claims a `rolled-back` it could not
/// record. The installation itself is still restored.
@MainActor
struct RollbackRecordFailureTests {

    func run(_ runner: UpgradeTestRunner) {
        let root = TempDir.make("rollback-record")
        defer { TempDir.remove(root) }
        let fixture = UpgradeFixture.make("rollback-record", in: root)
        let transactionDirectory = root.appendingPathComponent("txn", isDirectory: true)
        try! FileManager.default.createDirectory(at: transactionDirectory,
                                                 withIntermediateDirectories: true)
        let before = UpgradeFixture.productionExecutableBytes(fixture)
        let chmod = "/bin/sh -c 'chmod 555 \"\(transactionDirectory.path)\"'"
        let outcome = UpgradeEngine.upgrade(
            candidateRoot: fixture.candidateRoot,
            identityPath: fixture.identityURL,
            trialRecordPath: fixture.trialRecordURL,
            productionApp: fixture.productionApp,
            productionDataHome: fixture.productionDataHome,
            options: UpgradeFixture.options(
                verify: ["/bin/sh", "-c", "chmod 555 \"\(transactionDirectory.path)\""],
                transactionDirectory: transactionDirectory))
        _ = chmod
        runner.check(outcome.state == .needsManual,
                     "a rollback that cannot persist its record ends in needs-manual")
        runner.check(outcome.messages.contains(where: {
            $0.contains("could not be updated") && $0.contains("the rollback itself succeeded")
        }), "the outcome reports both the successful undo and the lost record")
        runner.check(before == UpgradeFixture.productionExecutableBytes(fixture),
                     "the installation was restored even though the record write failed")
        if let data = try? Data(contentsOf: transactionDirectory
            .appendingPathComponent("upgrade-transaction.json")),
           let record = try? JSONDecoder().decode(UpgradeTransactionRecord.self, from: data) {
            runner.check(record.state == .switched,
                         "the on-disk record stops at the last state that could be persisted")
        } else {
            runner.check(false, "the transaction file is still readable")
        }
        try? FileManager.default.setAttributes([.posixPermissions: 0o755],
                                               ofItemAtPath: transactionDirectory.path)
        let recovered = UpgradeEngine.resume(transactionDirectory: transactionDirectory)
        runner.check(recovered.state == .rolledBack,
                     "once the directory is writable again, resume reconciles the record")
    }
}

/// `make-trial-record` formats a manual trial record, binds it to the
/// identity file, and marks it `manual-bridge`; the upgrade engine accepts
/// it and copies the source marker into the transaction record. An unknown
/// source marker or a malformed digest is refused. Every functional
/// assertion runs in-process through `MakeTrialRecordCommand`, so the suite
/// passes on a clean `.build` where the `dsh-upgrade` executable is not
/// built; one real-CLI smoke runs when the binary exists and is recorded as
/// an explicit skip with its reason when it does not.
@MainActor
struct ManualBridgeTests {

    /// The real `dsh-upgrade` binary, when it was built. `swift run
    /// UpgradeTests` builds the test target and its library dependencies
    /// only, never the `dsh-upgrade` executable target.
    private static let cliExecutableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        .deletingLastPathComponent()
        .appendingPathComponent("dsh-upgrade")

    /// Bound on every CLI wait; no path in this suite can block forever.
    private static let cliTimeout: TimeInterval = 60

    /// Runs the real `dsh-upgrade` binary and returns its exit code and
    /// combined stdout/stderr text. Never blocks indefinitely: a failed
    /// `process.run()` returns a nonzero code with the error text instead of
    /// reading a pipe no child will write, and both the output read and the
    /// exit wait carry a 60 s timeout — on timeout the child is terminated
    /// and the invocation is judged failed.
    private func runCLI(_ arguments: [String]) -> (code: Int32, output: String) {
        final class LockedBuffer {
            private let lock = NSLock()
            private var data = Data()

            func append(_ chunk: Data) {
                lock.lock(); data.append(chunk); lock.unlock()
            }

            var text: String {
                lock.lock(); defer { lock.unlock() }
                return String(data: data, encoding: .utf8) ?? ""
            }
        }
        let process = Process()
        process.executableURL = Self.cliExecutableURL
        process.arguments = arguments
        let outputPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = outputPipe
        let buffer = LockedBuffer()
        let readFinished = DispatchSemaphore(value: 0)
        outputPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                readFinished.signal()
            } else {
                buffer.append(chunk)
            }
        }
        do {
            try process.run()
        } catch {
            outputPipe.fileHandleForReading.readabilityHandler = nil
            return (1, "dsh-upgrade could not start: \(error)")
        }
        let exitFinished = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            process.waitUntilExit()
            exitFinished.signal()
        }
        let timedOut = readFinished.wait(timeout: .now() + Self.cliTimeout) == .timedOut
            || exitFinished.wait(timeout: .now() + Self.cliTimeout) == .timedOut
        if timedOut {
            process.terminate()
            _ = exitFinished.wait(timeout: .now() + 5)
            outputPipe.fileHandleForReading.readabilityHandler = nil
            return (-1, "dsh-upgrade did not exit within \(Int(Self.cliTimeout)) s and was "
                + "terminated; output so far: \(buffer.text)")
        }
        outputPipe.fileHandleForReading.readabilityHandler = nil
        return (process.terminationStatus, buffer.text)
    }

    func run(_ runner: UpgradeTestRunner) {
        // Happy path in-process: the bridge writes a bound, marked record
        // and the upgrade accepts it.
        let root = TempDir.make("bridge")
        defer { TempDir.remove(root) }
        let fixture = UpgradeFixture.make("bridge", in: root)
        let outURL = root.appendingPathComponent("bridged-trial-record.json")
        let digest = UpgradeFixture.sha256Hex(Data("manual candidate summary".utf8))
        let (code, output) = MakeTrialRecordCommand.run([
            "--candidate-identity", fixture.identityURL.path,
            "--approved-by", "tester (manual bridge regression)",
            "--result-digest", digest,
            "--out", outURL.path,
        ])
        runner.check(code == 0, "make-trial-record succeeds on a valid identity (\(code)): \(output)")
        if let data = try? Data(contentsOf: outURL),
           let record = try? JSONDecoder().decode(TrialRecord.self, from: data) {
            runner.check(record.trialRecordSource == TrialRecord.manualBridgeSource,
                         "the bridged record carries the manual-bridge source")
            runner.check(record.approvedBy == "tester (manual bridge regression)",
                         "the bridged record keeps the given approver")
            runner.check(record.resultDigest == digest, "the bridged record keeps the given digest")
            runner.check(record.candidate.sourceRevision == fixture.sourceRevision,
                         "the bridged record binds the identity's revision")
            runner.check(record.candidate.app == fixture.candidateApp.path,
                         "the bridged record binds the identity's App")
        } else {
            runner.check(false, "the bridged record is readable JSON")
        }
        let upgradeOutcome = UpgradeEngine.upgrade(
            candidateRoot: fixture.candidateRoot,
            identityPath: fixture.identityURL,
            trialRecordPath: outURL,
            productionApp: fixture.productionApp,
            productionDataHome: fixture.productionDataHome,
            options: UpgradeFixture.options())
        runner.check(upgradeOutcome.succeeded, "an upgrade with the bridged record commits")
        runner.check(upgradeOutcome.record?.trialRecordSource == TrialRecord.manualBridgeSource,
                     "the transaction record names the manual-bridge source")

        // A digest that is not 64 lowercase hex characters is refused and
        // writes nothing.
        let badRoot = TempDir.make("bridge-bad-digest")
        defer { TempDir.remove(badRoot) }
        let badFixture = UpgradeFixture.make("bridge-bad-digest", in: badRoot)
        let badOut = badRoot.appendingPathComponent("never-written.json")
        let (badCode, _) = MakeTrialRecordCommand.run([
            "--candidate-identity", badFixture.identityURL.path,
            "--approved-by", "tester",
            "--result-digest", "not-a-digest",
            "--out", badOut.path,
        ])
        runner.check(badCode == 2, "a malformed resultDigest is a usage refusal")
        runner.check(!FileManager.default.fileExists(atPath: badOut.path),
                     "a refused bridge wrote no record")

        // An existing destination is never overwritten.
        UpgradeFixture.write(Data("sentinel".utf8), to: badOut)
        let (overwriteCode, _) = MakeTrialRecordCommand.run([
            "--candidate-identity", badFixture.identityURL.path,
            "--approved-by", "tester",
            "--result-digest", digest,
            "--out", badOut.path,
        ])
        runner.check(overwriteCode == 2, "an existing destination is refused")
        runner.check((try? Data(contentsOf: badOut)) == Data("sentinel".utf8),
                     "an existing trial record is left intact")

        // An unknown trial-record source is refused by the binding check.
        let unknownRoot = TempDir.make("bridge-unknown-source")
        defer { TempDir.remove(unknownRoot) }
        let unknownFixture = UpgradeFixture.make("bridge-unknown-source", in: unknownRoot)
        let unknownData = try! JSONSerialization.jsonObject(
            with: try! Data(contentsOf: unknownFixture.trialRecordURL)) as! [String: Any]
        var tampered = unknownData
        tampered["trialRecordSource"] = "fortune-cookie"
        let unknownURL = unknownRoot.appendingPathComponent("trial-record-unknown-source.json")
        UpgradeFixture.write(try! JSONSerialization.data(
            withJSONObject: tampered, options: [.prettyPrinted, .sortedKeys]), to: unknownURL)
        let unknownOutcome = UpgradeEngine.upgrade(
            candidateRoot: unknownFixture.candidateRoot,
            identityPath: unknownFixture.identityURL,
            trialRecordPath: unknownURL,
            productionApp: unknownFixture.productionApp,
            productionDataHome: unknownFixture.productionDataHome,
            options: UpgradeFixture.options())
        runner.check(unknownOutcome.state == .needsManual
                     && unknownOutcome.messages.contains(where: {
                         $0.contains("unsupported trial-record source")
                     }),
                     "an unknown trial-record source is refused before any file change")

        // One real-CLI smoke: only when the dsh-upgrade binary was built.
        // On a clean `.build` it is absent; the smoke is then an explicit
        // skip with the reason, never a silent pass, a failure, or a hang.
        guard FileManager.default.isExecutableFile(atPath: Self.cliExecutableURL.path) else {
            runner.skip("the dsh-upgrade CLI smoke: skipped — the dsh-upgrade binary was not built "
                + "(`swift run UpgradeTests` builds only the test target and its library dependencies; "
                + "run `swift build --product dsh-upgrade` to enable the smoke). "
                + "The same make-trial-record assertions ran in-process through MakeTrialRecordCommand")
            return
        }
        runner.check(true, "the dsh-upgrade CLI is built next to the test executable")
        let smokeRoot = TempDir.make("bridge-cli")
        defer { TempDir.remove(smokeRoot) }
        let smokeFixture = UpgradeFixture.make("bridge-cli", in: smokeRoot)
        let smokeOut = smokeRoot.appendingPathComponent("cli-trial-record.json")
        let (smokeCode, smokeOutput) = runCLI([
            "make-trial-record",
            "--candidate-identity", smokeFixture.identityURL.path,
            "--approved-by", "tester (CLI smoke)",
            "--result-digest", digest,
            "--out", smokeOut.path,
        ])
        runner.check(smokeCode == 0,
                     "the real dsh-upgrade CLI make-trial-record succeeds (\(smokeCode)): \(smokeOutput)")
        if let data = try? Data(contentsOf: smokeOut),
           let record = try? JSONDecoder().decode(TrialRecord.self, from: data) {
            runner.check(record.trialRecordSource == TrialRecord.manualBridgeSource,
                         "the CLI-written record carries the manual-bridge source")
        } else {
            runner.check(false, "the CLI-written record is readable JSON")
        }
    }
}
