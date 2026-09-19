import Foundation

/// A paired backup of the production App and the production data home,
/// created before any switch. The backup directory is readable and
/// self-describing: `manifest.json` records every copied file with its path,
/// size, and SHA-256, and the backup is hash-verified before the transaction
/// may continue to `staged`.
struct BackupManifest: Codable, Equatable {
    static let schema = "deepseek-harness.upgrade.backup-manifest/1"
    static let fileName = "manifest.json"
    static let maximumJSONBytes = 64 * 1024 * 1024

    let schema: String
    let createdAt: String
    /// The program version that was replaced (what a restore returns to).
    let sourceRevision: String
    let productionAppPath: String
    let productionDataHome: String
    /// Backup-root-relative path of the copied App bundle.
    let appRoot: String
    let appFiles: [FileOps.FileEntry]
    let dataHomeFiles: [FileOps.FileEntry]
    /// The production installation's prior `recovery-last-good.json`, when
    /// one existed.
    let lastGoodFile: FileOps.FileEntry?
    /// The Recovery entry Apps that existed next to the production App
    /// before the switch, copied under `recovery/<entry name>/`; the
    /// rollback restores exactly these. Absent in backups created before
    /// this field existed.
    let recoveryFiles: [FileOps.FileEntry]?

    var allFiles: [FileOps.FileEntry] {
        appFiles + dataHomeFiles + recoveryFiles.orEmpty
            + (lastGoodFile.map { [$0] } ?? [])
    }
}

private extension Optional where Wrapped == [FileOps.FileEntry] {
    var orEmpty: [FileOps.FileEntry] { self ?? [] }
}

enum PairedBackup {

    /// Copies the production App and the production data home into
    /// `<backupsRoot>/<UTC timestamp>-<sourceRevision>/`, writes the manifest,
    /// and verifies the copy byte-for-byte against it. The production files
    /// are only ever read.
    static func create(
        productionApp: URL, productionDataHome: URL, backupsRoot: URL,
        sourceRevision: String
    ) -> Result<(directory: URL, manifest: BackupManifest), TransactionError> {
        let fileManager = FileManager.default
        if !FileOps.isRealDirectory(backupsRoot) {
            do {
                try fileManager.createDirectory(atPath: backupsRoot.path, withIntermediateDirectories: true)
            } catch {
                return .failure(.stepFailed("cannot create backups root \(backupsRoot.path): \(error)"))
            }
        }
        let base = "\(Self.timestamp())-\(Self.sanitize(sourceRevision))"
        var name = base
        while fileManager.fileExists(atPath: backupsRoot.appendingPathComponent(name).path) {
            // Two transactions in the same second must never share a backup
            // directory; a short suffix keeps the readable name unique.
            name = "\(base)-\(String(format: "%04x", UInt32.random(in: 0...UInt32.max)))"
        }
        let directory = backupsRoot.appendingPathComponent(name, isDirectory: true)
        do {
            try fileManager.createDirectory(atPath: directory.path, withIntermediateDirectories: false)
        } catch {
            return .failure(.stepFailed("cannot create backup directory \(directory.path): \(error)"))
        }
        // A failure after this point must not leave a half-built backup
        // behind: the backup is only trustworthy as a complete, verified
        // pair, and a partial directory would be mistaken for one.
        func failed(_ error: TransactionError) -> TransactionError {
            try? fileManager.removeItem(at: directory)
            return error
        }

        // Manifest entries are backup-root-relative, so a manifest reader
        // never needs to know the copied layout.
        let appRoot = "app/\(productionApp.lastPathComponent)"
        let appEntries: [FileOps.FileEntry]
        switch FileOps.copyTree(from: productionApp,
                                to: directory.appendingPathComponent(appRoot)) {
        case let .failure(error): return .failure(failed(error))
        case let .success(entries):
            appEntries = entries.map { entry in
                FileOps.FileEntry(path: "\(appRoot)/\(entry.path)",
                                  size: entry.size, sha256: entry.sha256)
            }
        }
        let dataEntries: [FileOps.FileEntry]
        switch FileOps.copyTree(from: productionDataHome,
                                to: directory.appendingPathComponent("data-home")) {
        case let .failure(error): return .failure(failed(error))
        case let .success(entries):
            dataEntries = entries.map { entry in
                FileOps.FileEntry(path: "data-home/\(entry.path)",
                                  size: entry.size, sha256: entry.sha256)
            }
        }
        var lastGood: FileOps.FileEntry?
        let lastGoodURL = productionApp.deletingLastPathComponent()
            .appendingPathComponent("recovery-last-good.json")
        if FileOps.isRegularFile(lastGoodURL) {
            switch FileOps.copyFile(from: lastGoodURL,
                                    to: directory.appendingPathComponent("recovery-last-good.json"),
                                    relativePath: "recovery-last-good.json") {
            case let .failure(error): return .failure(failed(error))
            case let .success(entry): lastGood = entry
            }
        }
        // The Recovery entry Apps sit next to the production App and an
        // upgrade replaces them, so a rollback needs their pre-upgrade bytes.
        let recoveryParent = productionApp.deletingLastPathComponent()
        var recoveryEntries: [FileOps.FileEntry] = []
        for name in AppSwitch.recoveryEntryNames {
            let entryApp = recoveryParent.appendingPathComponent(name, isDirectory: true)
            guard FileOps.isRealDirectory(entryApp) else { continue }
            let backupRoot = "recovery/\(name)"
            switch FileOps.copyTree(from: entryApp,
                                    to: directory.appendingPathComponent(backupRoot)) {
            case let .failure(error): return .failure(failed(error))
            case let .success(entries):
                recoveryEntries.append(contentsOf: entries.map { entry in
                    FileOps.FileEntry(path: "\(backupRoot)/\(entry.path)",
                                      size: entry.size, sha256: entry.sha256)
                })
            }
        }

        let manifest = BackupManifest(
            schema: BackupManifest.schema,
            createdAt: FileOps.isoNow(),
            sourceRevision: sourceRevision,
            productionAppPath: productionApp.path,
            productionDataHome: productionDataHome.path,
            appRoot: appRoot,
            appFiles: appEntries,
            dataHomeFiles: dataEntries,
            lastGoodFile: lastGood,
            recoveryFiles: recoveryEntries)
        switch Self.encode(manifest, to: directory.appendingPathComponent(BackupManifest.fileName)) {
        case let .failure(error): return .failure(failed(error))
        case .success: break
        }
        switch verify(directory: directory, manifest: manifest) {
        case let .failure(error): return .failure(failed(error))
        case .success: break
        }
        return .success((directory, manifest))
    }

    /// Reads and verifies a backup manifest: every recorded file must exist
    /// with the recorded size and SHA-256, and the backup must contain no
    /// unrecorded regular file.
    static func verify(directory: URL, manifest: BackupManifest) -> Result<Void, TransactionError> {
        for entry in manifest.allFiles {
            let url = directory.appendingPathComponent(entry.path)
            guard FileOps.isRegularFile(url) else {
                return .failure(.stepFailed("backup file missing: \(url.path)"))
            }
            guard let digest = FileOps.sha256File(url), digest == entry.sha256 else {
                return .failure(.stepFailed("backup hash mismatch: \(url.path)"))
            }
            let size = ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int) ?? -1
            guard size == entry.size else {
                return .failure(.stepFailed("backup size mismatch: \(url.path)"))
            }
        }
        // No unrecorded regular file may hide in the backup. The root is
        // canonicalized because the enumerator resolves symlinks in the root.
        var recorded = Set(manifest.allFiles.map(\.path))
        recorded.insert(BackupManifest.fileName)
        let rootPath = FileOps.canonicalPath(directory) ?? directory.path
        let enumerator = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil)
        while let item = enumerator?.nextObject() as? URL {
            guard FileOps.isRegularFile(item) else { continue }
            guard item.path.hasPrefix(rootPath + "/") else {
                return .failure(.stepFailed("backup path escaped the root: \(item.path)"))
            }
            let relative = String(item.path.dropFirst(rootPath.count + 1))
            guard recorded.contains(relative) else {
                return .failure(.stepFailed("backup contains an unrecorded file: \(item.path)"))
            }
        }
        return .success(())
    }

    static func load(directory: URL) -> Result<BackupManifest, TransactionError> {
        FileOps.decodeJSON(BackupManifest.self,
                           from: directory.appendingPathComponent(BackupManifest.fileName),
                           maximumBytes: BackupManifest.maximumJSONBytes)
    }

    private static func encode(_ manifest: BackupManifest, to url: URL) -> Result<Void, TransactionError> {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(manifest) else {
            return .failure(.stepFailed("cannot encode \(url.path)"))
        }
        return FileOps.atomicWrite(data, to: url)
    }

    static func timestamp() -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
        let components = calendar.dateComponents(
            [.year, .month, .day, .hour, .minute, .second], from: Date())
        return String(format: "%04d%02d%02dT%02d%02d%02dZ",
                      components.year ?? 0, components.month ?? 0, components.day ?? 0,
                      components.hour ?? 0, components.minute ?? 0, components.second ?? 0)
    }

    /// Backup directory names are read by humans; a revision string keeps
    /// alphanumerics, `.`, `-`, and `_`, everything else becomes `_`.
    static func sanitize(_ revision: String) -> String {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz"
            + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_")
        return String(revision.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" })
    }
}
