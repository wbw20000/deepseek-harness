import Foundation
@testable import UpgradeTransaction

/// Binding rejections: a mismatched identity, a tampered bundle digest, a
/// trial record for a different candidate, or a wrong last-good record must
/// refuse the upgrade before any file is modified.
@MainActor
struct BindingTests {


    func run(_ runner: UpgradeTestRunner) {
        runner.check(
            refuses("identity digest mismatch") { fixture in
                let identity = """
                {
                  "sourceRevision": "\(fixture.sourceRevision)",
                  "frozenConfigSHA256": "\(String(repeating: "a", count: 64))",
                  "runtimeInventorySHA256": "\(UpgradeFixture.sha256Hex(Data("inventory".utf8)))"
                }
                """
                let url = fixture.root.appendingPathComponent("identity-wrong.json")
                UpgradeFixture.write(Data(identity.utf8), to: url)
                return (url, fixture.trialRecordURL)
            },
            "identity digest mismatch is refused")

        runner.check(
            refuses("bundle hash mismatch") { fixture in
                UpgradeFixture.write(
                    Data("{ \"mode\": \"frozen\", \"tampered\": true }".utf8),
                    to: fixture.candidateApp
                        .appendingPathComponent("Contents/Resources/frozen-launcher-config.json"))
                return (fixture.identityURL, fixture.trialRecordURL)
            },
            "tampered bundle metadata is refused")

        runner.check(
            refuses("trial record mismatch") { fixture in
                let record = """
                {
                  "schema": "self-development-review.trial-record/1",
                  "approvedBy": "user",
                  "resultDigest": "\(UpgradeFixture.sha256Hex(Data("other".utf8)))",
                  "candidate": {
                    "sourceRevision": "another-revision",
                    "frozenConfigSHA256": "\(String(repeating: "b", count: 64))",
                    "runtimeInventorySHA256": "\(String(repeating: "c", count: 64))",
                    "app": "\(fixture.candidateApp.path)"
                  }
                }
                """
                let url = fixture.root.appendingPathComponent("trial-record-wrong.json")
                UpgradeFixture.write(Data(record.utf8), to: url)
                return (fixture.identityURL, url)
            },
            "a trial record for another candidate is refused")

        runner.check(
            refuses("last-good mismatch") { fixture in
                let lastGood = """
                {
                  "schema": "deepseek-harness.recovery.last-good/1",
                  "appPath": "\(fixture.candidateApp.path)",
                  "frozenConfigSHA256": "\(String(repeating: "d", count: 64))",
                  "runtimeInventorySHA256": "\(UpgradeFixture.sha256Hex(Data("inventory".utf8)))"
                }
                """
                UpgradeFixture.write(Data(lastGood.utf8), to: fixture.candidateRoot
                    .appendingPathComponent("recovery-last-good.json"))
                return (fixture.identityURL, fixture.trialRecordURL)
            },
            "a last-good record with foreign digests is refused")

        do {
            let root = TempDir.make("binding-self")
            defer { TempDir.remove(root) }
            let fixture = UpgradeFixture.make("self", in: root)
            let before = UpgradeFixture.productionExecutableBytes(fixture)
            let outcome = UpgradeEngine.upgrade(
                candidateRoot: fixture.candidateRoot,
                identityPath: fixture.identityURL,
                trialRecordPath: fixture.trialRecordURL,
                productionApp: fixture.candidateApp,
                productionDataHome: fixture.productionDataHome,
                options: UpgradeFixture.options())
            runner.check(outcome.state == .needsManual && !outcome.succeeded,
                         "installing the candidate onto itself is refused")
            runner.check(before == UpgradeFixture.productionExecutableBytes(fixture),
                         "the refused self-install changed nothing")
            runner.check(
                !FileManager.default.fileExists(
                    atPath: root.appendingPathComponent("upgrade-transaction.json").path),
                "the refused self-install wrote no record")
        }
    }

    /// Runs one upgrade with the given perturbation and asserts the refusal:
    /// a needs-manual-style failure before any side effect, no transaction
    /// file, and untouched production files.
    func refuses(
        _ name: String, perturb: (UpgradeFixture.Installation) -> (URL, URL)?
    ) -> Bool {
        let root = TempDir.make("binding-\(name)")
        defer { TempDir.remove(root) }
        let fixture = UpgradeFixture.make(name, in: root)
        let before = UpgradeFixture.productionExecutableBytes(fixture)
        let inputs = perturb(fixture)
        let outcome = UpgradeEngine.upgrade(
            candidateRoot: fixture.candidateRoot,
            identityPath: inputs?.0 ?? fixture.identityURL,
            trialRecordPath: inputs?.1 ?? fixture.trialRecordURL,
            productionApp: fixture.productionApp,
            productionDataHome: fixture.productionDataHome,
            options: UpgradeFixture.options())
        var refused = !outcome.succeeded && outcome.state == .needsManual
        refused = refused
            && !FileManager.default.fileExists(
                atPath: fixture.transactionDirectory
                    .appendingPathComponent("upgrade-transaction.json").path)
        refused = refused && before == UpgradeFixture.productionExecutableBytes(fixture)
        return refused
    }
}

/// The committed path: every state is persisted and readable, the production
/// App runs the candidate's bytes, the data marker pairs the versions, the
/// Recovery entries sit next to the production App, and the backup manifest
/// re-verifies independently.
@MainActor
struct UpgradePathTests {


    func run(_ runner: UpgradeTestRunner) {
        let root = TempDir.make("path")
        defer { TempDir.remove(root) }
        let fixture = UpgradeFixture.make("path", in: root)
        let outcome = UpgradeEngine.upgrade(
            candidateRoot: fixture.candidateRoot,
            identityPath: fixture.identityURL,
            trialRecordPath: fixture.trialRecordURL,
            productionApp: fixture.productionApp,
            productionDataHome: fixture.productionDataHome,
            options: UpgradeFixture.options())
        runner.check(outcome.succeeded, "the upgrade commits")
        guard outcome.succeeded else { return }

        let recordURL = fixture.transactionDirectory.appendingPathComponent("upgrade-transaction.json")
        runner.check(
            FileManager.default.fileExists(atPath: recordURL.path),
            "the transaction file exists")
        if let data = try? Data(contentsOf: recordURL),
           let record = try? JSONDecoder().decode(UpgradeTransactionRecord.self, from: data) {
            let states = record.history.map(\.state)
            runner.check(
                states == [.planned, .backedUp, .staged, .switched, .verified, .committed],
                "the record history holds every state in order")
            runner.check(record.kind == "upgrade", "the record names the upgrade kind")
            runner.check(record.sourceRevision == fixture.sourceRevision,
                         "the record binds the identity revision")
            runner.check(record.state == .committed, "the final state is committed")
            runner.check(record.candidateAppPath == fixture.candidateApp.path,
                         "the record names the exact candidate App")
            runner.check(record.dataVersion == "data-path",
                         "the record carries the candidate's paired data version")
        } else {
            runner.check(false, "the transaction file is readable JSON")
        }

        let installed = try! Data(contentsOf: fixture.productionApp
            .appendingPathComponent("Contents/MacOS/DeepSeek Harness"))
        let candidateBytes = try! Data(contentsOf: fixture.candidateApp
            .appendingPathComponent("Contents/MacOS/DeepSeek Harness"))
        runner.check(installed == candidateBytes, "the production App now carries the candidate's bytes")

        if let marker = UpgradeFixture.marker(in: fixture.productionDataHome) {
            runner.check(marker.programVersion == fixture.sourceRevision,
                         "the data marker pairs the program version")
            runner.check(marker.dataVersion == "data-path", "the data marker pairs the data version")
        } else {
            runner.check(false, "the production data home carries a data-version marker")
        }
        let settings = try? Data(contentsOf: fixture.productionDataHome
            .appendingPathComponent("settings.json"))
        runner.check(settings == Data("production user data".utf8),
                     "the production data files are preserved")

        for entry in AppSwitch.recoveryEntryNames {
            runner.check(
                FileManager.default.isExecutableFile(
                    atPath: fixture.productionApp.deletingLastPathComponent()
                        .appendingPathComponent(entry, isDirectory: true)
                        .appendingPathComponent("Contents/MacOS/Recovery").path),
                "the \(entry) entry is installed next to the production App")
        }

        // The backup manifest re-verifies with an independent reader.
        if let record = outcome.record, let backupPath = record.backupDirectory,
           let manifestData = try? Data(contentsOf: URL(fileURLWithPath: backupPath)
               .appendingPathComponent("manifest.json")),
           let manifest = try? JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
           let entries = manifest["appFiles"] as? [[String: Any]] {
            var allVerified = !entries.isEmpty
            for entry in entries {
                guard let relative = entry["path"] as? String,
                      let digest = entry["sha256"] as? String,
                      let size = entry["size"] as? Int else {
                    allVerified = false
                    continue
                }
                let url = URL(fileURLWithPath: backupPath).appendingPathComponent(relative)
                let bytes = try? Data(contentsOf: url)
                allVerified = allVerified && bytes != nil
                    && UpgradeFixture.sha256Hex(bytes!) == digest
                    && bytes!.count == size
            }
            runner.check(allVerified, "the backup manifest re-verifies file by file")
            let manifestEntry = (manifest["dataHomeFiles"] as? [[String: Any]] ?? [])
                .contains { ($0["path"] as? String)?.hasPrefix("data-home/") == true }
            runner.check(manifestEntry, "the manifest records the paired data-home copy")
        } else {
            runner.check(false, "the backup manifest is readable")
        }
    }
}

/// A failing verification rolls the transaction back automatically: the
/// production App bytes equal the backup, the prior data marker is restored,
/// and no staging residue survives.
@MainActor
struct RollbackTests {


    func run(_ runner: UpgradeTestRunner) {
        let root = TempDir.make("rollback")
        defer { TempDir.remove(root) }
        let fixture = UpgradeFixture.make("rollback", in: root)
        let before = UpgradeFixture.productionExecutableBytes(fixture)
        let outcome = UpgradeEngine.upgrade(
            candidateRoot: fixture.candidateRoot,
            identityPath: fixture.identityURL,
            trialRecordPath: fixture.trialRecordURL,
            productionApp: fixture.productionApp,
            productionDataHome: fixture.productionDataHome,
            options: UpgradeFixture.options(verify: UpgradeFixture.verifyFail))
        runner.check(outcome.state == .rolledBack, "verification failure ends in rolled-back")
        runner.check(before == UpgradeFixture.productionExecutableBytes(fixture),
                     "the production App equals the pre-upgrade bytes again")
        if let marker = UpgradeFixture.marker(in: fixture.productionDataHome) {
            runner.check(marker.programVersion == "before",
                         "the prior data marker pairing is restored")
        } else {
            runner.check(false, "the data marker survives the rollback")
        }
        let residue = try? FileManager.default.contentsOfDirectory(
            atPath: fixture.root.path)
            .filter { $0.hasPrefix(".DeepSeek Harness.app.") }
        runner.check(residue?.isEmpty ?? false, "no staging residue survives the rollback")
        if let record = outcome.record {
            runner.check(record.state == .rolledBack, "the transaction file records rolled-back")
            runner.check(!record.detail.isEmpty, "the record explains the rollback cause")
        } else {
            runner.check(false, "the rollback record is returned")
        }
    }
}

/// A crash mid-transaction is simulated by returning after a chosen state.
/// The next start reconciles the record without repeating any side effect,
/// and a fresh upgrade afterwards commits normally.
@MainActor
struct InterruptionTests {


    func run(_ runner: UpgradeTestRunner) {
        // staged: nothing was switched; the next start must clean up only.
        let stagedRoot = TempDir.make("interrupt-staged")
        defer { TempDir.remove(stagedRoot) }
        let staged = UpgradeFixture.make("staged", in: stagedRoot)
        let beforeStaged = UpgradeFixture.productionExecutableBytes(staged)
        let stagedOutcome = UpgradeEngine.upgrade(
            candidateRoot: staged.candidateRoot,
            identityPath: staged.identityURL,
            trialRecordPath: staged.trialRecordURL,
            productionApp: staged.productionApp,
            productionDataHome: staged.productionDataHome,
            options: UpgradeFixture.options(stopAfter: .staged))
        runner.check(stagedOutcome.state == .staged, "the drill leaves the record at staged")
        runner.check(beforeStaged == UpgradeFixture.productionExecutableBytes(staged),
                     "staged leaves the production App untouched")
        runner.check(
            FileManager.default.fileExists(
                atPath: staged.root.appendingPathComponent("upgrade-transaction.json").path),
            "the intermediate state is on disk")
        let resumed = UpgradeEngine.resume(transactionDirectory: staged.root)
        runner.check(resumed.state == .rolledBack, "the next start reconciles staged to rolled-back")
        runner.check(beforeStaged == UpgradeFixture.productionExecutableBytes(staged),
                     "reconciliation changed nothing that was not changed already")
        let rerun = UpgradeEngine.upgrade(
            candidateRoot: staged.candidateRoot,
            identityPath: staged.identityURL,
            trialRecordPath: staged.trialRecordURL,
            productionApp: staged.productionApp,
            productionDataHome: staged.productionDataHome,
            options: UpgradeFixture.options())
        runner.check(rerun.succeeded, "after reconciliation a fresh upgrade commits")

        // switched: the switch happened; the next start must roll the App back.
        let switchedRoot = TempDir.make("interrupt-switched")
        defer { TempDir.remove(switchedRoot) }
        let switched = UpgradeFixture.make("switched", in: switchedRoot)
        let beforeSwitched = UpgradeFixture.productionExecutableBytes(switched)
        let switchedOutcome = UpgradeEngine.upgrade(
            candidateRoot: switched.candidateRoot,
            identityPath: switched.identityURL,
            trialRecordPath: switched.trialRecordURL,
            productionApp: switched.productionApp,
            productionDataHome: switched.productionDataHome,
            options: UpgradeFixture.options(stopAfter: .switched))
        runner.check(switchedOutcome.state == .switched, "the drill leaves the record at switched")
        let candidateBytes = try! Data(contentsOf: switched.candidateApp
            .appendingPathComponent("Contents/MacOS/DeepSeek Harness"))
        runner.check(
            (try! Data(contentsOf: switched.productionApp
                .appendingPathComponent("Contents/MacOS/DeepSeek Harness"))) == candidateBytes,
            "at switched the production App carries the new bytes")
        let recovered = UpgradeEngine.resume(transactionDirectory: switchedRoot)
        runner.check(recovered.state == .rolledBack, "the next start rolls the switched state back")
        runner.check(beforeSwitched == UpgradeFixture.productionExecutableBytes(switched),
                     "the previous App bytes are back after recovery")
        if let marker = UpgradeFixture.marker(in: switched.productionDataHome) {
            runner.check(marker.programVersion == "before",
                         "the prior data pairing is restored after recovery")
        } else {
            runner.check(false, "the data marker survives recovery")
        }
    }
}

/// Restore returns the production installation to a previous version through
/// the same transaction machinery, from a paired backup or from a last-good
/// record.
@MainActor
struct RestoreTests {


    func run(_ runner: UpgradeTestRunner) {
        let root = TempDir.make("restore")
        defer { TempDir.remove(root) }
        let fixture = UpgradeFixture.make("restore", in: root)
        let original = UpgradeFixture.productionExecutableBytes(fixture)
        let upgradeOutcome = UpgradeEngine.upgrade(
            candidateRoot: fixture.candidateRoot,
            identityPath: fixture.identityURL,
            trialRecordPath: fixture.trialRecordURL,
            productionApp: fixture.productionApp,
            productionDataHome: fixture.productionDataHome,
            options: UpgradeFixture.options())
        runner.check(upgradeOutcome.succeeded, "the upgrade commits before the restore")
        guard let record = upgradeOutcome.record, let backupPath = record.backupDirectory else {
            runner.check(false, "the upgrade recorded a backup directory")
            return
        }

        let fromBackup = UpgradeEngine.restore(
            source: .backupDirectory(URL(fileURLWithPath: backupPath, isDirectory: true)),
            productionApp: fixture.productionApp,
            productionDataHome: fixture.productionDataHome,
            options: UpgradeFixture.options())
        runner.check(fromBackup.state == .committed, "restore from the paired backup commits")
        runner.check(original == UpgradeFixture.productionExecutableBytes(fixture),
                     "restore puts the previous App bytes back")
        if let restored = fromBackup.record {
            runner.check(restored.kind == "restore", "the restore records its own transaction")
            runner.check(restored.sourceRevision == "before",
                         "the restore records the version it returned to")
        } else {
            runner.check(false, "the restore record is returned")
        }
        runner.check(
            (UpgradeFixture.marker(in: fixture.productionDataHome)?.dataVersion) == "data-restore",
            "the restore keeps the data version pairing readable")

        // From the candidate's last-good record: the candidate bytes return.
        let fromLastGood = UpgradeEngine.restore(
            source: .lastGoodRecord(fixture.candidateRoot
                .appendingPathComponent("recovery-last-good.json")),
            productionApp: fixture.productionApp,
            productionDataHome: fixture.productionDataHome,
            options: UpgradeFixture.options())
        runner.check(fromLastGood.state == .committed, "restore from last-good commits")
        let candidateBytes = try! Data(contentsOf: fixture.candidateApp
            .appendingPathComponent("Contents/MacOS/DeepSeek Harness"))
        runner.check(
            (try! Data(contentsOf: fixture.productionApp
                .appendingPathComponent("Contents/MacOS/DeepSeek Harness"))) == candidateBytes,
            "restore from last-good installs the recorded App")
    }
}

/// A second transaction while one holds the lock is refused immediately, in
/// the same process and from a real second process.
@MainActor
struct LockTests {


    func run(_ runner: UpgradeTestRunner) {
        // In process: a held lock refuses the engine before any side effect.
        let root = TempDir.make("lock-in-process")
        defer { TempDir.remove(root) }
        let fixture = UpgradeFixture.make("lock", in: root)
        let lock = TransactionLock.acquire(directory: fixture.root)
        runner.check({
            if case .success = lock { return true }
            return false
        }(), "the test acquires the transaction lock")
        if case .success(let held) = lock {
            let before = UpgradeFixture.productionExecutableBytes(fixture)
            let outcome = UpgradeEngine.upgrade(
                candidateRoot: fixture.candidateRoot,
                identityPath: fixture.identityURL,
                trialRecordPath: fixture.trialRecordURL,
                productionApp: fixture.productionApp,
                productionDataHome: fixture.productionDataHome,
                options: UpgradeFixture.options())
            runner.check(outcome.state == .needsManual && !outcome.succeeded,
                         "a second transaction is refused while the lock is held")
            runner.check(before == UpgradeFixture.productionExecutableBytes(fixture),
                         "the refused transaction changed nothing")
            runner.check(
                !FileManager.default.fileExists(
                    atPath: fixture.root.appendingPathComponent("upgrade-transaction.json").path),
                "the refused transaction wrote no record")
            held.release()
            let after = UpgradeEngine.upgrade(
                candidateRoot: fixture.candidateRoot,
                identityPath: fixture.identityURL,
                trialRecordPath: fixture.trialRecordURL,
                productionApp: fixture.productionApp,
                productionDataHome: fixture.productionDataHome,
                options: UpgradeFixture.options())
            runner.check(after.succeeded, "after the lock is released the upgrade commits")
        }

        // Second process: the holder keeps the lock; this process is refused.
        let processRoot = TempDir.make("lock-second-process")
        defer { TempDir.remove(processRoot) }
        let processFixture = UpgradeFixture.make("lock2", in: processRoot)
        let readyFile = processRoot.appendingPathComponent("holder-ready")
        let holder = Process()
        let executable = URL(fileURLWithPath: CommandLine.arguments[0])
        holder.executableURL = executable
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
            let outcome = UpgradeEngine.upgrade(
                candidateRoot: processFixture.candidateRoot,
                identityPath: processFixture.identityURL,
                trialRecordPath: processFixture.trialRecordURL,
                productionApp: processFixture.productionApp,
                productionDataHome: processFixture.productionDataHome,
                options: UpgradeFixture.options())
            runner.check(outcome.state == .needsManual,
                         "a concurrent second process is refused by the lock")
            runner.check(!outcome.succeeded, "the refused concurrent process changes nothing")
        } else {
            runner.check(false, "the lock holder process started")
        }
        holder.terminate()
        holder.waitUntilExit()
    }
}
