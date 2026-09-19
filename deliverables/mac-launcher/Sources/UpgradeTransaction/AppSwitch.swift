import Foundation

/// The switch-step filesystem operations: staging copy, the two-rename App
/// exchange, the paired data-version marker, recovery entry installation, and
/// their inverses. Every operation returns the first violated rule and leaves
/// already-completed renames undoable by the engine's rollback.
enum AppSwitch {

    /// Copies the candidate App bundle next to the production App as a hidden
    /// staging directory and re-hashes its frozen metadata against the
    /// expected digests, so the bytes that will be renamed into place are
    /// exactly the approved identity.
    static func stageCandidateApp(
        candidateApp: URL, productionApp: URL,
        expectedConfigDigest: String, expectedInventoryDigest: String
    ) -> Result<URL, TransactionError> {
        let parent = productionApp.deletingLastPathComponent()
        let staging = parent.appendingPathComponent(
            ".\(productionApp.lastPathComponent).staging.\(UUID().uuidString)", isDirectory: true)
        switch FileOps.copyTree(from: candidateApp, to: staging) {
        case let .failure(error): return .failure(error)
        case .success:
            break
        }
        let resources = staging.appendingPathComponent("Contents/Resources", isDirectory: true)
        for (url, expected, label) in [
            (resources.appendingPathComponent("frozen-launcher-config.json"),
             expectedConfigDigest, "frozen-launcher-config.json"),
            (resources.appendingPathComponent("runtime-inventory.json"),
             expectedInventoryDigest, "runtime-inventory.json"),
        ] {
            guard let digest = FileOps.sha256File(url), digest == expected else {
                try? FileManager.default.removeItem(at: staging)
                return .failure(.stepFailed("staged \(label) hash mismatch in \(staging.path)"))
            }
        }
        return .success(staging)
    }

    /// What the two-rename exchange actually did. The engine records the
    /// side effect (`replaced` exists) in the transaction ledger even when
    /// the publish rename failed, so the rollback — not this function —
    /// undoes it in exactly one place.
    enum SwapOutcome {
        /// Both renames succeeded; `replaced` holds the old bundle.
        case swapped(replaced: URL)
        /// The old bundle was moved aside but the staged copy could not be
        /// published; `replaced` must be renamed back by the rollback.
        case movedAsideOnly(replaced: URL, error: TransactionError)
        /// Nothing happened; the production App is untouched.
        case refused(TransactionError)
    }

    /// Exchanges the production App for the staged copy with two atomic
    /// renames: production moves aside to a hidden `replaced` name, staging
    /// moves into the production path. A failed publish is never silently
    /// undone here: the outcome names the `replaced` bundle so the engine
    /// records the side effect and the rollback renames it back.
    static func swapApp(productionApp: URL, stagedApp: URL) -> SwapOutcome {
        let parent = productionApp.deletingLastPathComponent()
        let replaced = parent.appendingPathComponent(
            ".\(productionApp.lastPathComponent).replaced.\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.moveItem(at: productionApp, to: replaced)
        } catch {
            return .refused(.stepFailed("cannot move \(productionApp.path) aside: \(error)"))
        }
        do {
            try FileManager.default.moveItem(at: stagedApp, to: productionApp)
        } catch {
            return .movedAsideOnly(
                replaced: replaced,
                error: .stepFailed("cannot publish staged App: \(error)"))
        }
        return .swapped(replaced: replaced)
    }

    /// Reads the current `data-version.json` bytes (`nil` when there is
    /// none). A present but unreadable marker is a loud failure, never a
    /// silent `nil`, so a rollback can never delete a marker it failed to
    /// read.
    static func readDataMarker(dataHome: URL) -> Result<Data?, TransactionError> {
        let url = dataHome.appendingPathComponent(DataVersionMarker.fileName)
        guard FileOps.isRegularFile(url) else { return .success(nil) }
        guard let bytes = FileManager.default.contents(atPath: url.path) else {
            return .failure(.stepFailed("cannot read \(url.path)"))
        }
        return .success(bytes)
    }

    /// Writes the paired `data-version.json` marker into the data home.
    /// The prior bytes are read (and recorded in the transaction) before
    /// this call, so the rollback restores exactly what was there before
    /// even when the write itself fails midway.
    static func writeDataMarker(
        dataHome: URL, prior: Data?, programVersion: String, dataVersion: String
    ) -> Result<Void, TransactionError> {
        let url = dataHome.appendingPathComponent(DataVersionMarker.fileName)
        let marker = DataVersionMarker(
            schema: DataVersionMarker.schema,
            programVersion: programVersion,
            dataVersion: dataVersion,
            switchedAt: FileOps.isoNow())
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(marker) else {
            return .failure(.stepFailed("cannot encode \(DataVersionMarker.fileName)"))
        }
        return FileOps.atomicWrite(data, to: url)
    }

    /// Restores the prior marker bytes, or removes the marker when there was
    /// none.
    static func restoreDataMarker(dataHome: URL, prior: Data?) -> Result<Void, TransactionError> {
        let url = dataHome.appendingPathComponent(DataVersionMarker.fileName)
        if let prior {
            return FileOps.atomicWrite(prior, to: url)
        }
        do {
            try FileManager.default.removeItem(at: url)
            return .success(())
        } catch {
            return .failure(.stepFailed("cannot remove \(url.path)"))
        }
    }

    /// The Recovery entry Apps an upgrade installs next to the production
    /// App. Names match `candidate-identity.json`'s `recoveryApps`.
    public static let recoveryEntryNames = [
        "DeepSeek Harness Recovery.app",
        "DeepSeek Harness Emergency Recovery.app",
    ]

    /// What installation actually did, including a partial success: the
    /// engine records `installed` in the transaction ledger even when a
    /// later entry failed, so the rollback restores exactly what exists.
    struct RecoveryInstallOutcome {
        var installed: [String] = []
        var failure: TransactionError?
    }

    /// Copies the candidate's Recovery entry Apps next to the production App
    /// (byte copies, no reseal), so the existing opt-in Recovery semantics
    /// stay available from the production location. An existing entry is
    /// replaced by the same two-rename exchange; a refused or failed replace
    /// keeps the previous entry and stops the loop with the entries already
    /// installed reported.
    static func installRecoveryEntries(
        candidateRoot: URL, productionApp: URL
    ) -> RecoveryInstallOutcome {
        let parent = productionApp.deletingLastPathComponent()
        var outcome = RecoveryInstallOutcome()
        for name in recoveryEntryNames {
            let source = candidateRoot.appendingPathComponent(name, isDirectory: true)
            guard FileOps.isRealDirectory(source) else { continue }
            let destination = parent.appendingPathComponent(name, isDirectory: true)
            let staging = parent.appendingPathComponent(
                ".\(name).staging.\(UUID().uuidString)", isDirectory: true)
            switch FileOps.copyTree(from: source, to: staging) {
            case let .failure(error):
                try? FileManager.default.removeItem(at: staging)
                outcome.failure = error
                return outcome
            case .success: break
            }
            if FileOps.isRealDirectory(destination) {
                let replaced = parent.appendingPathComponent(
                    ".\(name).replaced.\(UUID().uuidString)", isDirectory: true)
                do {
                    try FileManager.default.moveItem(at: destination, to: replaced)
                    try FileManager.default.moveItem(at: staging, to: destination)
                    try FileManager.default.removeItem(at: replaced)
                } catch {
                    try? FileManager.default.moveItem(at: replaced, to: destination)
                    try? FileManager.default.removeItem(at: staging)
                    outcome.failure = .stepFailed("cannot replace \(destination.path): \(error)")
                    return outcome
                }
            } else {
                do {
                    try FileManager.default.moveItem(at: staging, to: destination)
                } catch {
                    try? FileManager.default.removeItem(at: staging)
                    outcome.failure = .stepFailed("cannot install \(destination.path): \(error)")
                    return outcome
                }
            }
            outcome.installed.append(name)
        }
        return outcome
    }

    /// Restores one Recovery entry App to its pre-upgrade state: when the
    /// paired backup holds a copy, it replaces the installed entry through
    /// the same staging-and-rename exchange as installation; when it does
    /// not, the entry did not exist before the upgrade and is removed.
    static func restoreRecoveryEntry(
        parent: URL, name: String, backupEntry: URL?
    ) -> Result<Void, TransactionError> {
        let destination = parent.appendingPathComponent(name, isDirectory: true)
        guard let backupEntry, FileOps.isRealDirectory(backupEntry) else {
            guard FileOps.isRealDirectory(destination) else { return .success(()) }
            do {
                try FileManager.default.removeItem(at: destination)
                return .success(())
            } catch {
                return .failure(.stepFailed("cannot remove \(destination.path): \(error)"))
            }
        }
        let staging = parent.appendingPathComponent(
            ".\(name).staging.\(UUID().uuidString)", isDirectory: true)
        switch FileOps.copyTree(from: backupEntry, to: staging) {
        case let .failure(error):
            try? FileManager.default.removeItem(at: staging)
            return .failure(error)
        case .success: break
        }
        if FileOps.isRealDirectory(destination) {
            let replaced = parent.appendingPathComponent(
                ".\(name).replaced.\(UUID().uuidString)", isDirectory: true)
            do {
                try FileManager.default.moveItem(at: destination, to: replaced)
                try FileManager.default.moveItem(at: staging, to: destination)
                try FileManager.default.removeItem(at: replaced)
            } catch {
                try? FileManager.default.moveItem(at: replaced, to: destination)
                try? FileManager.default.removeItem(at: staging)
                return .failure(.stepFailed("cannot restore \(destination.path): \(error)"))
            }
        } else {
            do {
                try FileManager.default.moveItem(at: staging, to: destination)
            } catch {
                try? FileManager.default.removeItem(at: staging)
                return .failure(.stepFailed("cannot install \(destination.path): \(error)"))
            }
        }
        return .success(())
    }

    /// Removes a hidden leftover (`.staging.` or `.replaced.`) after a
    /// committed or rolled-back transaction.
    static func removeLeftover(_ url: URL) {
        guard url.lastPathComponent.hasPrefix(".") else { return }
        try? FileManager.default.removeItem(at: url)
    }
}
