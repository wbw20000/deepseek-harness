import Foundation

/// What one engine run produced. `state` is the persisted final state of the
/// transaction file; `messages` are human-readable lines the CLI prints
/// verbatim, including needs-manual guidance.
public struct UpgradeOutcome {
    public let state: UpgradeTransactionState
    public let record: UpgradeTransactionRecord?
    public let messages: [String]

    public var succeeded: Bool { state == .committed }
}

/// Where a restore takes the production installation from.
public enum RestoreSource: Equatable {
    /// A `<backupsRoot>/<timestamp>-<sourceRevision>` directory created by a
    /// previous transaction; its manifest is hash-verified first.
    case backupDirectory(URL)
    /// A `recovery-last-good.json` record naming the App to return to.
    case lastGoodRecord(URL)
}

/// The upgrade/restore state machine. Every entry point takes the
/// transaction directory's exclusive `flock` before it reads or writes any
/// transaction file — a busy lock refuses the whole run, including the
/// reconciliation of an interrupted transaction — then reconciles an
/// interrupted transaction, persists each state transition and each
/// side-effect step atomically, and rolls back exactly the side effects the
/// run actually performed, in reverse order. All paths are caller-supplied;
/// nothing here needs root, touches launchd, or triggers automatically —
/// the CLI is only ever run by an explicit user/desktop action.
public enum UpgradeEngine {

    public struct Options {
        public var transactionDirectory: URL?
        public var backupsRoot: URL?
        public var verifyCommand: [String]?
        /// Execute only up to this state and return, leaving the transaction
        /// file in that intermediate state exactly as a crash would. This is
        /// the interruption-drill control, not a resumable execution: a later
        /// run reconciles the record from scratch instead of continuing it.
        public var stopAfter: UpgradeTransactionState?

        public init(transactionDirectory: URL? = nil, backupsRoot: URL? = nil,
                    verifyCommand: [String]? = nil, stopAfter: UpgradeTransactionState? = nil) {
            self.transactionDirectory = transactionDirectory
            self.backupsRoot = backupsRoot
            self.verifyCommand = verifyCommand
            self.stopAfter = stopAfter
        }
    }

    /// Installs an approved candidate to the production location.
    public static func upgrade(
        candidateRoot: URL, identityPath: URL, trialRecordPath: URL,
        productionApp: URL, productionDataHome: URL, options: Options = Options()
    ) -> UpgradeOutcome {
        let transactionDirectory = options.transactionDirectory
            ?? productionApp.deletingLastPathComponent()
        let lock: TransactionLock
        switch TransactionLock.acquire(directory: transactionDirectory) {
        case let .failure(.locked(detail)):
            return failureOutcome(nil, .lockBusy(detail))
        case let .failure(.unavailable(detail)):
            return failureOutcome(nil, .lockUnavailable(detail))
        case let .success(value): lock = value
        }
        defer { lock.release() }

        // An interrupted transaction is reconciled — under the lock — before
        // any new work, and the new work is never started in the same run.
        switch reconcile(recordIn: transactionDirectory, startHint: "rerun the upgrade") {
        case let .outcome(outcome): return outcome
        case .clear: break
        case let .failure(error): return failureOutcome(nil, error)
        }

        let bound: BoundUpgradeInputs
        switch BoundUpgradeInputs.bind(
            candidateRoot: candidateRoot, identityPath: identityPath,
            trialRecordPath: trialRecordPath, productionApp: productionApp,
            productionDataHome: productionDataHome) {
        case let .failure(error):
            return failureOutcome(nil, error)
        case let .success(value): bound = value
        }
        let verifyCommand = options.verifyCommand
            ?? Verification.defaultCommand(forApp: productionApp)
        let record = UpgradeTransactionRecord(
            kind: "upgrade",
            candidateAppPath: bound.candidateApp.path,
            productionAppPath: productionApp.path,
            productionDataHome: productionDataHome.path,
            backupsRoot: (options.backupsRoot
                ?? transactionDirectory.appendingPathComponent("upgrade-backups")).path,
            verifyCommand: verifyCommand,
            sourceRevision: bound.identity.sourceRevision,
            dataVersion: bound.dataVersion,
            candidateRoot: candidateRoot.path,
            identityPath: identityPath.path,
            trialRecordPath: trialRecordPath.path,
            trialRecordSource: bound.trialRecordSource,
            now: FileOps.isoNow())
        return run(Plan(
            record: record,
            transactionDirectory: transactionDirectory,
            stageSource: bound.candidateApp,
            expectedConfigDigest: bound.identity.frozenConfigSHA256,
            expectedInventoryDigest: bound.identity.runtimeInventorySHA256,
            programVersion: bound.identity.sourceRevision,
            dataVersion: bound.dataVersion,
            installRecoveryEntries: true,
            stopAfter: options.stopAfter), lock: lock)
    }

    /// Returns the production installation to a previous version taken from a
    /// paired backup or a last-good record, through the same transaction,
    /// verification, and rollback machinery as an upgrade.
    public static func restore(
        source: RestoreSource, productionApp: URL, productionDataHome: URL,
        options: Options = Options()
    ) -> UpgradeOutcome {
        let transactionDirectory = options.transactionDirectory
            ?? productionApp.deletingLastPathComponent()
        let lock: TransactionLock
        switch TransactionLock.acquire(directory: transactionDirectory) {
        case let .failure(.locked(detail)):
            return failureOutcome(nil, .lockBusy(detail))
        case let .failure(.unavailable(detail)):
            return failureOutcome(nil, .lockUnavailable(detail))
        case let .success(value): lock = value
        }
        defer { lock.release() }

        switch reconcile(recordIn: transactionDirectory, startHint: "rerun the restore") {
        case let .outcome(outcome): return outcome
        case .clear: break
        case let .failure(error): return failureOutcome(nil, error)
        }

        let plan: Plan
        switch makeRestorePlan(source: source, productionApp: productionApp,
                               productionDataHome: productionDataHome, options: options) {
        case let .failure(error): return failureOutcome(nil, error)
        case let .success(value): plan = value
        }
        return run(plan, lock: lock)
    }

    /// Reconciles an interrupted transaction only. The transaction
    /// directory's exclusive lock is taken before the record is read; a busy
    /// lock refuses the run without touching anything.
    public static func resume(transactionDirectory: URL) -> UpgradeOutcome {
        let lock: TransactionLock
        switch TransactionLock.acquire(directory: transactionDirectory) {
        case let .failure(.locked(detail)):
            return failureOutcome(nil, .lockBusy(detail))
        case let .failure(.unavailable(detail)):
            return failureOutcome(nil, .lockUnavailable(detail))
        case let .success(value): lock = value
        }
        defer { lock.release() }
        switch reconcile(recordIn: transactionDirectory, startHint: "the interrupted transaction") {
        case let .outcome(outcome): return outcome
        case .clear:
            return UpgradeOutcome(
                state: .committed,
                record: nil,
                messages: ["no interrupted transaction in \(transactionDirectory.path)"])
        case let .failure(error): return failureOutcome(nil, error)
        }
    }

    // MARK: - Plan

    struct Plan {
        var record: UpgradeTransactionRecord
        var transactionDirectory: URL
        /// Directory copied into staging at the `staged` step.
        var stageSource: URL
        var expectedConfigDigest: String
        var expectedInventoryDigest: String
        var programVersion: String
        var dataVersion: String
        var installRecoveryEntries: Bool
        var stopAfter: UpgradeTransactionState?
        /// Restore transactions only: the manifest the restored App must
        /// match during commit.
        var restoreManifest: BackupManifest?
    }

    private static func makeRestorePlan(
        source: RestoreSource, productionApp: URL, productionDataHome: URL,
        options: Options
    ) -> Result<Plan, TransactionError> {
        guard FileOps.isRealDirectory(productionApp) else {
            return .failure(.invalidInput("production App is not a directory: \(productionApp.path)"))
        }
        guard FileOps.isRealDirectory(productionDataHome) else {
            return .failure(.invalidInput("production data home is not a directory: \(productionDataHome.path)"))
        }
        let transactionDirectory = options.transactionDirectory
            ?? productionApp.deletingLastPathComponent()
        let verifyCommand = options.verifyCommand
            ?? Verification.defaultCommand(forApp: productionApp)

        func record(stageSource: URL, revision: String, trialRecordPath: URL?,
                    candidateRoot: String?) -> Plan {
            let dataVersion = currentDataVersion(in: productionDataHome) ?? revision
            return Plan(
                record: UpgradeTransactionRecord(
                    kind: "restore",
                    candidateAppPath: stageSource.path,
                    productionAppPath: productionApp.path,
                    productionDataHome: productionDataHome.path,
                    backupsRoot: (options.backupsRoot
                        ?? transactionDirectory.appendingPathComponent("upgrade-backups")).path,
                    verifyCommand: verifyCommand,
                    sourceRevision: revision,
                    dataVersion: dataVersion,
                    candidateRoot: candidateRoot,
                    identityPath: nil,
                    trialRecordPath: trialRecordPath?.path,
                    trialRecordSource: nil,
                    now: FileOps.isoNow()),
                transactionDirectory: transactionDirectory,
                stageSource: stageSource,
                expectedConfigDigest: "",
                expectedInventoryDigest: "",
                programVersion: revision,
                dataVersion: dataVersion,
                installRecoveryEntries: false,
                stopAfter: options.stopAfter,
                restoreManifest: nil)
        }

        switch source {
        case let .backupDirectory(directory):
            let manifest: BackupManifest
            switch PairedBackup.load(directory: directory) {
            case let .failure(error): return .failure(error)
            case let .success(value): manifest = value
            }
            switch PairedBackup.verify(directory: directory, manifest: manifest) {
            case let .failure(error): return .failure(error)
            case .success: break
            }
            let sourceApp = directory.appendingPathComponent(manifest.appRoot, isDirectory: true)
            guard FileOps.isRealDirectory(sourceApp) else {
                return .failure(.invalidInput("backup App missing: \(sourceApp.path)"))
            }
            let resources = sourceApp.appendingPathComponent("Contents/Resources", isDirectory: true)
            guard let configDigest = FileOps.sha256File(
                    resources.appendingPathComponent("frozen-launcher-config.json")),
                  let inventoryDigest = FileOps.sha256File(
                    resources.appendingPathComponent("runtime-inventory.json")) else {
                return .failure(.invalidInput("backup App has no hashed frozen metadata"))
            }
            var plan = record(stageSource: sourceApp, revision: manifest.sourceRevision,
                              trialRecordPath: nil, candidateRoot: nil)
            plan.expectedConfigDigest = configDigest
            plan.expectedInventoryDigest = inventoryDigest
            plan.restoreManifest = manifest
            return .success(plan)
        case let .lastGoodRecord(recordURL):
            let lastGood: LastGoodRecord
            switch FileOps.decodeJSON(LastGoodRecord.self, from: recordURL,
                                      maximumBytes: LastGoodRecord.maximumJSONBytes) {
            case let .failure(error): return .failure(error)
            case let .success(value): lastGood = value
            }
            guard lastGood.schema == LastGoodRecord.schema else {
                return .failure(.bindingRejected("unsupported last-good schema \(lastGood.schema)"))
            }
            let sourceApp = URL(fileURLWithPath: lastGood.appPath, isDirectory: true)
            guard FileOps.isRealDirectory(sourceApp), sourceApp.path.hasSuffix(".app") else {
                return .failure(.bindingRejected("last-good App missing: \(lastGood.appPath)"))
            }
            let resources = sourceApp.appendingPathComponent("Contents/Resources", isDirectory: true)
            for (url, expected, label) in [
                (resources.appendingPathComponent("frozen-launcher-config.json"),
                 lastGood.frozenConfigSHA256, "frozen-launcher-config.json"),
                (resources.appendingPathComponent("runtime-inventory.json"),
                 lastGood.runtimeInventorySHA256, "runtime-inventory.json"),
            ] {
                guard let digest = FileOps.sha256File(url), digest == expected else {
                    return .failure(.bindingRejected("last-good \(label) hash mismatch for \(url.path)"))
                }
            }
            let revision = recordedSourceRevision(in: resources) ?? "unknown"
            var plan = record(stageSource: sourceApp, revision: revision,
                              trialRecordPath: recordURL, candidateRoot: nil)
            plan.expectedConfigDigest = lastGood.frozenConfigSHA256
            plan.expectedInventoryDigest = lastGood.runtimeInventorySHA256
            return .success(plan)
        }
    }

    static func currentDataVersion(in dataHome: URL) -> String? {
        let url = dataHome.appendingPathComponent(DataVersionMarker.fileName)
        guard FileOps.isRegularFile(url) else { return nil }
        switch FileOps.decodeJSON(DataVersionMarker.self, from: url, maximumBytes: 64 * 1024) {
        case let .success(marker): return marker.dataVersion
        case .failure: return nil
        }
    }

    /// The program version a data home is currently paired with, read from
    /// its marker; `nil` when no readable marker exists.
    static func currentProgramVersion(in dataHome: URL) -> String? {
        let url = dataHome.appendingPathComponent(DataVersionMarker.fileName)
        guard FileOps.isRegularFile(url) else { return nil }
        switch FileOps.decodeJSON(DataVersionMarker.self, from: url, maximumBytes: 64 * 1024) {
        case let .success(marker): return marker.programVersion
        case .failure: return nil
        }
    }

    /// Leniently reads a restored bundle's recorded source revision; the
    /// frozen configuration is the only place a bare App records it.
    static func recordedSourceRevision(in resourcesDirectory: URL) -> String? {
        struct Partial: Decodable { let sourceRevision: String? }
        switch FileOps.decodeJSON(Partial.self, from: resourcesDirectory
            .appendingPathComponent("frozen-launcher-config.json"), maximumBytes: 64 * 1024) {
        case let .success(partial): return partial.sourceRevision
        case .failure: return nil
        }
    }

    // MARK: - Run

    /// Runs the transaction with the already-acquired lock. The caller (and
    /// only the caller) owns the lock: every read and write of the
    /// transaction file in this function happens while it is held.
    private static func run(_ plan: Plan, lock: TransactionLock) -> UpgradeOutcome {
        // The caller acquired the exclusive transaction lock and releases it
        // after this returns; nothing here may run without it.
        _ = lock
        var record = plan.record

        func persist(_ state: UpgradeTransactionState, detail: String = "") -> TransactionError? {
            record.state = state
            record.updatedAt = FileOps.isoNow()
            record.history.append(UpgradeHistoryEntry(state: state, at: record.updatedAt))
            record.detail = detail
            do {
                try TransactionStore(directory: plan.transactionDirectory).write(record)
                return nil
            } catch let error as TransactionError {
                return error
            } catch {
                return .persistFailed("\(plan.transactionDirectory.path): \(error)")
            }
        }
        /// Persists the record without advancing the state: the on-disk
        /// ledger of finished side effects must be ahead of the next
        /// irreversible step, so the rollback and a crash recovery undo
        /// exactly what happened.
        func checkpoint() -> TransactionError? {
            record.updatedAt = FileOps.isoNow()
            do {
                try TransactionStore(directory: plan.transactionDirectory).write(record)
                return nil
            } catch let error as TransactionError {
                return error
            } catch {
                return .persistFailed("\(plan.transactionDirectory.path): \(error)")
            }
        }

        if let error = persist(.planned) {
            return failureOutcome(record, error)
        }
        let productionAppURL = URL(fileURLWithPath: record.productionAppPath, isDirectory: true)
        let productionDataHomeURL = URL(fileURLWithPath: record.productionDataHome, isDirectory: true)
        // The backup manifest records the version it replaced, so a restore
        // knows exactly which program version it returns to.
        let replacedVersion = currentProgramVersion(in: productionDataHomeURL) ?? "unknown"
        let backup: (directory: URL, manifest: BackupManifest)
        switch PairedBackup.create(
            productionApp: productionAppURL, productionDataHome: productionDataHomeURL,
            backupsRoot: URL(fileURLWithPath: plan.record.backupsRoot, isDirectory: true),
            sourceRevision: replacedVersion) {
        case let .failure(error):
            return finishWithRollback(plan, record: &record, stepError: error)
        case let .success(value): backup = value
        }
        record.backupDirectory = backup.directory.path
        record.sideEffects?.backup = true
        if let error = persist(.backedUp) {
            return finishWithRollback(plan, record: &record, stepError: error)
        }
        if plan.stopAfter == .backedUp {
            return intermediateOutcome(record, at: .backedUp)
        }

        let stagedApp: URL
        switch AppSwitch.stageCandidateApp(
            candidateApp: plan.stageSource, productionApp: productionAppURL,
            expectedConfigDigest: plan.expectedConfigDigest,
            expectedInventoryDigest: plan.expectedInventoryDigest) {
        case let .failure(error):
            return finishWithRollback(plan, record: &record, stepError: error)
        case let .success(value): stagedApp = value
        }
        record.stagedAppPath = stagedApp.path
        record.sideEffects?.stage = true
        if let error = persist(.staged) {
            return finishWithRollback(plan, record: &record, stepError: error)
        }
        if plan.stopAfter == .staged {
            return intermediateOutcome(record, at: .staged)
        }

        switch AppSwitch.swapApp(productionApp: productionAppURL, stagedApp: stagedApp) {
        case let .refused(error):
            return finishWithRollback(plan, record: &record, stepError: error)
        case let .movedAsideOnly(replaced, error):
            // The side effect already happened: record it before the
            // rollback renames the replaced bundle back.
            record.replacedAppPath = replaced.path
            record.sideEffects?.swap = true
            return finishWithRollback(plan, record: &record, stepError: error)
        case let .swapped(replaced):
            record.replacedAppPath = replaced.path
            record.sideEffects?.swap = true
            if let error = persist(.switched) {
                return finishWithRollback(plan, record: &record, stepError: error)
            }
        }
        if plan.stopAfter == .switched {
            return intermediateOutcome(record, at: .switched)
        }

        // Read and persist the prior marker bytes before overwriting the
        // marker, so even a crash between the write and the next checkpoint
        // can restore the exact prior pairing.
        let priorMarker: Data?
        switch AppSwitch.readDataMarker(dataHome: productionDataHomeURL) {
        case let .failure(error):
            return finishWithRollback(plan, record: &record, stepError: error)
        case let .success(value): priorMarker = value
        }
        record.priorDataMarkerBase64 = priorMarker?.base64EncodedString()
        if let error = checkpoint() {
            return finishWithRollback(plan, record: &record, stepError: error)
        }
        switch AppSwitch.writeDataMarker(
            dataHome: productionDataHomeURL, prior: priorMarker,
            programVersion: plan.programVersion, dataVersion: plan.dataVersion) {
        case let .failure(error):
            return finishWithRollback(plan, record: &record, stepError: error)
        case .success: break
        }
        record.sideEffects?.marker = true
        if let error = checkpoint() {
            return finishWithRollback(plan, record: &record, stepError: error)
        }

        let verification = Verification(command: record.verifyCommand)
        var messages: [String] = []
        switch verification.run() {
        case let .failure(error):
            return finishWithRollback(
                plan, record: &record, stepError: .stepFailed("verification failed: \(error)"))
        case let .success(transcript):
            if !transcript.isEmpty { messages.append(transcript) }
        }
        if let error = persist(.verified) {
            return finishWithRollback(plan, record: &record, stepError: error)
        }
        if plan.stopAfter == .verified {
            return intermediateOutcome(record, at: .verified)
        }

        // Commit: the replaced bundle is already backed up, and the Recovery
        // entry Apps are installed only by an upgrade, from the approved
        // candidate.
        if let replacedPath = record.replacedAppPath {
            AppSwitch.removeLeftover(URL(fileURLWithPath: replacedPath))
        }
        if plan.installRecoveryEntries, let candidateRoot = record.candidateRoot {
            let install = AppSwitch.installRecoveryEntries(
                candidateRoot: URL(fileURLWithPath: candidateRoot, isDirectory: true),
                productionApp: productionAppURL)
            record.recoveryEntriesInstalled = install.installed
            record.sideEffects?.recoveryEntries = !install.installed.isEmpty
            if let error = install.failure {
                if let checkpointError = checkpoint() {
                    return finishWithRollback(
                        plan, record: &record,
                        stepError: .stepFailed("\(error); \(checkpointError)"))
                }
                return finishWithRollback(plan, record: &record, stepError: error)
            }
            if let error = checkpoint() {
                return finishWithRollback(plan, record: &record, stepError: error)
            }
            if !install.installed.isEmpty {
                messages.append("installed recovery entries: \(install.installed.joined(separator: ", "))")
            }
        }
        if let error = persist(.committed) {
            return failureOutcome(record, error)
        }
        messages.insert("committed \(record.kind) to \(record.productionAppPath)", at: 0)
        messages.append("paired backup kept at \(record.backupDirectory ?? plan.record.backupsRoot)")
        return UpgradeOutcome(state: .committed, record: record, messages: messages)
    }

    private static func intermediateOutcome(_ record: UpgradeTransactionRecord,
                                            at state: UpgradeTransactionState) -> UpgradeOutcome {
        UpgradeOutcome(
            state: state, record: record,
            messages: ["transaction left in intermediate state \(state.rawValue) as a crash would"])
    }

    private static func failureOutcome(_ record: UpgradeTransactionRecord?,
                                       _ error: TransactionError) -> UpgradeOutcome {
        UpgradeOutcome(state: .needsManual, record: record, messages: [describe(error)])
    }

    static func describe(_ error: TransactionError) -> String {
        switch error {
        case .invalidInput(let detail): return "refused: \(detail)"
        case .bindingRejected(let detail): return "binding rejected: \(detail)"
        case .malformedRecord(let detail): return "malformed transaction record: \(detail)"
        case .persistFailed(let detail): return "cannot persist transaction record: \(detail)"
        case .lockBusy(let detail): return "another transaction is active: \(detail)"
        case .lockUnavailable(let detail): return "cannot lock transaction directory: \(detail)"
        case .stepFailed(let detail): return "transaction step failed: \(detail)"
        }
    }

    // MARK: - Rollback

    /// Undoes exactly the side effects the transaction file records, in
    /// reverse order, and persists `rolled-back` — or `needs-manual` with
    /// readable guidance when the undo itself fails or the restored
    /// installation does not match the backup.
    private static func finishWithRollback(
        _ plan: Plan, record: inout UpgradeTransactionRecord, stepError: TransactionError
    ) -> UpgradeOutcome {
        let rollback = rollbackSideEffects(record: record)
        let backupPath = record.backupDirectory ?? record.backupsRoot
        switch rollback {
        case .success:
            if let detail = persistRollbackState(&record, transactionDirectory: plan.transactionDirectory,
                                                 state: .rolledBack,
                                                 detail: "rolled back: \(stepError)") {
                return UpgradeOutcome(
                    state: .needsManual, record: record,
                    messages: [
                        describe(stepError),
                        "the rollback itself succeeded, but the transaction file could not be updated: \(detail)",
                        "the installation was restored from the paired backup at \(backupPath)",
                        "MANUAL ACTION REQUIRED",
                        "1. quit the DeepSeek Harness App",
                        "2. verify the App runs before starting another transaction",
                        "3. inspect the transaction file: \(TransactionStore(directory: plan.transactionDirectory).fileURL.path)",
                    ])
            }
            return UpgradeOutcome(
                state: .rolledBack, record: record,
                messages: [
                    describe(stepError),
                    "rolled back to the paired backup at \(backupPath)",
                    "the installation is unchanged; rerun only after the cause is fixed",
                ])
        case let .failure(rollbackDetail):
            var detail = rollbackDetail
            if let persistDetail = persistRollbackState(&record, transactionDirectory: plan.transactionDirectory,
                                                        state: .needsManual,
                                                        detail: "\(stepError); rollback failed: \(detail)") {
                detail = "\(detail); the transaction file could not be updated: \(persistDetail)"
            }
            return UpgradeOutcome(
                state: .needsManual, record: record,
                messages: [
                    describe(stepError),
                    "rollback failed: \(detail)",
                    "MANUAL ACTION REQUIRED",
                    "1. quit the DeepSeek Harness App",
                    "2. restore from the paired backup: dsh-upgrade restore --from-backup \"\(backupPath)\"",
                    "3. inspect the transaction file: \(TransactionStore(directory: plan.transactionDirectory).fileURL.path)",
                    "4. do not rerun the upgrade before the App runs again",
                ])
        }
    }

    /// Persists the end state of a rollback. Returns the failure detail when
    /// the record could not be written, so a lost rollback record is never
    /// reported as if it had been persisted.
    private static func persistRollbackState(_ record: inout UpgradeTransactionRecord,
                                             transactionDirectory: URL,
                                             state: UpgradeTransactionState, detail: String) -> String? {
        record.state = state
        record.updatedAt = FileOps.isoNow()
        record.history.append(UpgradeHistoryEntry(state: state, at: record.updatedAt))
        record.detail = detail
        do {
            try TransactionStore(directory: transactionDirectory).write(record)
            return nil
        } catch {
            return String(describing: error)
        }
    }

    /// The undo result: success, or the detail carried into `needs-manual`.
    enum RollbackOutcome {
        case success
        case failure(String)
    }

    /// Undoes the side effects the record's ledger lists as done, in reverse
    /// order: the installed Recovery entries, the data-version marker, the
    /// App switch, then the staging copy. Nothing is deleted that the undo
    /// of a later step might still need, and after the App is restored its
    /// contents are asserted against the paired backup's manifest.
    static func rollbackSideEffects(
        record: UpgradeTransactionRecord
    ) -> RollbackOutcome {
        let productionApp = URL(fileURLWithPath: record.productionAppPath, isDirectory: true)
        let parent = productionApp.deletingLastPathComponent()
        let sideEffects = record.sideEffects ?? legacySideEffects(from: record)
        var failures: [String] = []

        // 1. Recovery entries: back to the backup copy, or removed when the
        // backup has none (the entry did not exist before the upgrade).
        if sideEffects.recoveryEntries {
            let installed = record.recoveryEntriesInstalled ?? []
            for name in installed {
                let backupEntry = record.backupDirectory.map {
                    URL(fileURLWithPath: $0, isDirectory: true)
                        .appendingPathComponent("recovery/\(name)", isDirectory: true)
                }
                switch AppSwitch.restoreRecoveryEntry(parent: parent, name: name, backupEntry: backupEntry) {
                case .success: break
                case let .failure(error): failures.append(String(describing: error))
                }
            }
        }

        // 2. The data-version marker: restore the recorded prior bytes, or
        // remove the marker when there was none.
        if sideEffects.marker || record.priorDataMarkerBase64 != nil {
            let prior = record.priorDataMarkerBase64.flatMap { Data(base64Encoded: $0) }
            switch AppSwitch.restoreDataMarker(
                dataHome: URL(fileURLWithPath: record.productionDataHome, isDirectory: true),
                prior: prior) {
            case .success: break
            case let .failure(error): failures.append(String(describing: error))
            }
        }

        // 3. The App switch: rename the replaced bundle back (fast path) or
        // restore the backup copy, then assert the result matches the
        // backup manifest.
        if sideEffects.swap {
            let replaced = record.replacedAppPath.map { URL(fileURLWithPath: $0) }
            switch restoreApp(productionApp: productionApp, replaced: replaced,
                              backupDirectory: record.backupDirectory.map { URL(fileURLWithPath: $0, isDirectory: true) }) {
            case .success: break
            case let .failure(detail): failures.append(detail)
            }
            if record.backupDirectory != nil, failures.isEmpty {
                switch verifyRestoredAppMatchesBackup(
                    productionApp: productionApp,
                    backupDirectory: URL(fileURLWithPath: record.backupDirectory!, isDirectory: true)) {
                case .success: break
                case let .failure(detail): failures.append(detail)
                }
            }
        }

        // 4. The staging copy.
        if sideEffects.stage, let staged = record.stagedAppPath {
            AppSwitch.removeLeftover(URL(fileURLWithPath: staged))
        }

        // Residue is deleted only when every undo succeeded: a `.replaced`
        // directory still holds the old App after a failed restore.
        if failures.isEmpty {
            removeResidue(around: productionApp)
            return .success
        }
        return .failure(failures.joined(separator: "; "))
    }

    /// The side-effect reading for records written before the ledger field
    /// existed: the recorded path fields are the only evidence.
    private static func legacySideEffects(from record: UpgradeTransactionRecord) -> UpgradeSideEffects {
        var sideEffects = UpgradeSideEffects()
        sideEffects.backup = record.backupDirectory != nil
        sideEffects.stage = record.stagedAppPath != nil
        sideEffects.swap = record.replacedAppPath != nil
        switch record.state {
        case .switched, .verified: sideEffects.marker = true
        default: break
        }
        sideEffects.recoveryEntries = record.recoveryEntriesInstalled != nil
        return sideEffects
    }

    /// Asserts that every App file the backup manifest recorded is present
    /// at the production path with the recorded SHA-256. A rollback that
    /// cannot prove the restored installation matches the backup is a
    /// `needs-manual`, never a silent `rolled-back`.
    static func verifyRestoredAppMatchesBackup(
        productionApp: URL, backupDirectory: URL
    ) -> RollbackOutcome {
        let manifest: BackupManifest
        switch PairedBackup.load(directory: backupDirectory) {
        case let .failure(error): return .failure(String(describing: error))
        case let .success(value): manifest = value
        }
        for entry in manifest.appFiles {
            let relative = entry.path.dropFirst(manifest.appRoot.count + 1)
            let url = productionApp.appendingPathComponent(String(relative))
            guard let digest = FileOps.sha256File(url), digest == entry.sha256 else {
                return .failure("the restored installation does not match the backup: \(url.path)")
            }
        }
        return .success
    }

    /// Puts the previous App bundle back at the production path: the fast
    /// path renames the `.replaced` bundle back; otherwise the backup copy is
    /// staged and renamed in, and every restored file is hash-checked against
    /// the backup manifest.
    static func restoreApp(
        productionApp: URL, replaced: URL?, backupDirectory: URL?
    ) -> RollbackOutcome {
        let fileManager = FileManager.default
        if let replaced, FileOps.isRealDirectory(replaced) {
            let discarded = productionApp.deletingLastPathComponent()
                .appendingPathComponent(".\(productionApp.lastPathComponent).failed.\(UUID().uuidString)")
            do {
                try fileManager.moveItem(at: productionApp, to: discarded)
                try fileManager.moveItem(at: replaced, to: productionApp)
                AppSwitch.removeLeftover(discarded)
                return .success
            } catch {
                try? fileManager.moveItem(at: discarded, to: productionApp)
                return .failure("cannot rename the replaced bundle back: \(error)")
            }
        }
        guard let backupDirectory else {
            return .failure("no backup directory recorded in the transaction")
        }
        let backupManifest: BackupManifest
        switch PairedBackup.load(directory: backupDirectory) {
        case let .failure(error): return .failure(String(describing: error))
        case let .success(manifest): backupManifest = manifest
        }
        let sourceApp = backupDirectory.appendingPathComponent(backupManifest.appRoot, isDirectory: true)
        guard FileOps.isRealDirectory(sourceApp) else {
            return .failure("backup App missing: \(sourceApp.path)")
        }
        let staging = productionApp.deletingLastPathComponent()
            .appendingPathComponent(".\(productionApp.lastPathComponent).rollback.\(UUID().uuidString)")
        switch FileOps.copyTree(from: sourceApp, to: staging) {
        case let .failure(error): return .failure(String(describing: error))
        case .success: break
        }
        let discarded = productionApp.deletingLastPathComponent()
            .appendingPathComponent(".\(productionApp.lastPathComponent).failed.\(UUID().uuidString)")
        do {
            try fileManager.moveItem(at: productionApp, to: discarded)
            try fileManager.moveItem(at: staging, to: productionApp)
        } catch {
            try? fileManager.moveItem(at: discarded, to: productionApp)
            try? fileManager.removeItem(at: staging)
            return .failure("cannot publish the restored App: \(error)")
        }
        AppSwitch.removeLeftover(discarded)
        for entry in backupManifest.appFiles {
            let relative = entry.path.dropFirst(backupManifest.appRoot.count + 1)
            let url = productionApp.appendingPathComponent(String(relative))
            guard let digest = FileOps.sha256File(url), digest == entry.sha256 else {
                return .failure("restored file does not match the backup: \(url.path)")
            }
        }
        return .success
    }

    /// Removes hidden staging/replaced/failed/rollback leftovers of a crashed
    /// run. Only engine-owned dot-prefixed names are ever deleted.
    static func removeResidue(around productionApp: URL) {
        let parent = productionApp.deletingLastPathComponent()
        let prefix = ".\(productionApp.lastPathComponent)."
        let kinds = ["staging.", "replaced.", "failed.", "rollback."]
        guard let contents = try? FileManager.default.contentsOfDirectory(atPath: parent.path) else {
            return
        }
        for name in contents where name.hasPrefix(prefix) {
            if kinds.contains(where: { name.dropFirst(prefix.count).hasPrefix($0) }) {
                AppSwitch.removeLeftover(parent.appendingPathComponent(name))
            }
        }
    }

    // MARK: - Interruption

    private enum Reconcile {
        case clear
        case outcome(UpgradeOutcome)
        case failure(TransactionError)
    }

    /// The start-of-run interruption rule: a record in an intermediate state
    /// describes a crashed transaction and is reconciled — the side-effect
    /// ledger (or, for records without one, the replaced residue) decides
    /// whether the App switch already happened — and the pending operation
    /// is never started in the same run, so no side effect is ever repeated.
    /// The caller holds the transaction directory's exclusive lock.
    private static func reconcile(recordIn directory: URL, startHint: String) -> Reconcile {
        let store = TransactionStore(directory: directory)
        let existing: UpgradeTransactionRecord?
        switch store.load() {
        case let .failure(error): return .failure(error)
        case let .success(value): existing = value
        }
        guard let record = existing else { return .clear }
        guard record.state.isIntermediate else { return .clear }
        let productionApp = URL(fileURLWithPath: record.productionAppPath, isDirectory: true)
        var sideEffects = record.sideEffects ?? legacySideEffects(from: record)

        // A switch whose state transition never reached `switched` — the
        // crash landed between the rename and the persist — is still a
        // switch: the ledger says so, or the replaced residue does.
        var working = record
        if !sideEffects.swap {
            if let residue = replacedResidue(around: productionApp) {
                working.replacedAppPath = residue.path
                sideEffects.swap = true
            }
        }
        working.sideEffects = sideEffects

        if !sideEffects.swap {
            var cleaned = record
            cleaned.sideEffects = sideEffects
            cleaned.state = .rolledBack
            cleaned.updatedAt = FileOps.isoNow()
            cleaned.history.append(UpgradeHistoryEntry(state: .rolledBack, at: cleaned.updatedAt))
            cleaned.detail = "recovered from interruption at \(record.state.rawValue); no switch happened"
            if sideEffects.stage, let staged = record.stagedAppPath {
                AppSwitch.removeLeftover(URL(fileURLWithPath: staged))
            }
            removeResidue(around: productionApp)
            do {
                try store.write(cleaned)
                return .outcome(UpgradeOutcome(
                    state: .rolledBack, record: cleaned,
                    messages: [
                        "recovered an interrupted transaction left at \(record.state.rawValue); no switch had happened",
                        "nothing was changed; \(startHint) when ready",
                    ]))
            } catch {
                return .failure(.persistFailed("\(directory.path): \(error)"))
            }
        }

        let backupDirectory = record.backupDirectory.map { URL(fileURLWithPath: $0, isDirectory: true) }
        let rollback = rollbackSideEffects(record: working)
        var finished = record
        finished.replacedAppPath = working.replacedAppPath
        finished.sideEffects = sideEffects
        finished.updatedAt = FileOps.isoNow()
        switch rollback {
        case .success:
            finished.state = .rolledBack
            finished.history.append(UpgradeHistoryEntry(state: .rolledBack, at: finished.updatedAt))
            finished.detail = "recovered from interruption at \(record.state.rawValue); rolled back to the backup"
            do {
                try store.write(finished)
                return .outcome(UpgradeOutcome(
                    state: .rolledBack, record: finished,
                    messages: [
                        "recovered an interrupted transaction left at \(record.state.rawValue); the previous App was restored from \(backupDirectory?.path ?? record.backupsRoot)",
                        "\(startHint) when ready",
                    ]))
            } catch {
                return .failure(.persistFailed("\(directory.path): \(error)"))
            }
        case let .failure(detail):
            finished.state = .needsManual
            finished.history.append(UpgradeHistoryEntry(state: .needsManual, at: finished.updatedAt))
            finished.detail = "interrupted at \(record.state.rawValue); rollback failed: \(detail)"
            do {
                try store.write(finished)
            } catch {
                return .failure(.persistFailed("\(directory.path): \(error)"))
            }
            return .outcome(UpgradeOutcome(
                state: .needsManual, record: finished,
                messages: [
                    "an interrupted transaction could not roll itself back: \(detail)",
                    "MANUAL ACTION REQUIRED",
                    "restore from \(backupDirectory?.path ?? record.backupsRoot) with dsh-upgrade restore --from-backup",
                ]))
        }
    }

    /// The first hidden `.replaced.` bundle next to the production App, when
    /// one exists — the proof that a crashed run renamed the production App
    /// aside without recording it.
    static func replacedResidue(around productionApp: URL) -> URL? {
        let parent = productionApp.deletingLastPathComponent()
        let prefix = ".\(productionApp.lastPathComponent).replaced."
        guard let contents = try? FileManager.default.contentsOfDirectory(atPath: parent.path) else {
            return nil
        }
        let matches = contents.filter { $0.hasPrefix(prefix) }.sorted()
        guard let name = matches.first else { return nil }
        return parent.appendingPathComponent(name, isDirectory: true)
    }
}
