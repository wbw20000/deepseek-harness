import CryptoKit
import Darwin
import Foundation

/// Loads and verifies the explicit versioned last-good record a recovery App
/// launches from. The record names one exact frozen App bundle inside the
/// chosen managed installation plus the SHA-256 digests of its
/// `frozen-launcher-config.json` and `runtime-inventory.json`. Loading
/// performs no directory scan, no newest-mtime guess, and no fallback: every
/// rejected condition is reported, and only a fully verified bundle reaches
/// `BackendController`.
///
/// The digests detect accidental mismatch, not authenticity: a same-user
/// writer can rewrite record and payload together. This is not sandboxing and
/// not release approval.
public enum RecoverySelection {

    /// The only schema/protocol this build accepts; every other value is
    /// unsupported and refused.
    public static let supportedSchema = "deepseek-harness.recovery.last-good/1"

    /// The sealed-build record naming the managed installation root.
    public static let supportedInstallationSchema = "deepseek-harness.recovery.installation/1"

    /// Records are small bounded metadata, not documents.
    public static let maximumRecordBytes = 16 * 1024

    public struct Record: Codable, Equatable {
        let schema: String
        /// Exact absolute path of the frozen `.app` bundle.
        let appPath: String
        let frozenConfigSHA256: String
        let runtimeInventorySHA256: String
    }

    public struct SealedInstallation: Codable, Equatable {
        let schema: String
        /// Exact absolute path of the managed installation root.
        let installationRoot: String
    }

    public enum SelectionError: Error, Equatable {
        /// The record file is missing, unreadable, non-regular, linked, or
        /// over the size bound; the reader reports one condition on purpose.
        case missingRecord
        /// The record exists but is not valid JSON with the expected fields.
        case malformed(String)
        /// The record's schema is present but not the supported version.
        case unsupportedSchema(String)
        /// A record field violates its rules (relative path, wrong digest
        /// format, wrong suffix).
        case invalid(String)
        /// The resolved bundle does not live directly inside the chosen
        /// managed installation.
        case outsideInstallation(String)
        /// A named file's bytes do not match its recorded digest.
        case hashMismatch(String)
        /// A bundle path or the recorded data home names nothing usable.
        case missingPath(String)
        /// The installation root or a bundle component is not a real
        /// directory (missing, symlink, or other file type).
        case unsafePath(String)
    }

    /// A fully verified selection: the record, the real bundle locations, and
    /// the resolved frozen launch the controller validates again before start.
    public struct Verified: Equatable {
        public let record: Record
        public let installationRoot: URL
        public let appURL: URL
        public let resourcesDirectory: URL
        public let launch: FrozenLauncherConfig.Resolved
    }

    /// SHA-256 of a bounded regular file, read without following a final
    /// symlink. `nil` when the read rules reject the file.
    static func sha256Hex(of url: URL, maximumBytes: Int) -> String? {
        guard let data = FrozenFileReader.read(url, maximumBytes: maximumBytes) else { return nil }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func isValidDigest(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    /// Real-directory check: lstat (never follow a final symlink) must report
    /// a directory.
    static func isRealDirectory(_ url: URL) -> Bool {
        var stats = stat()
        guard lstat(url.path, &stats) == 0 else { return false }
        return (stats.st_mode & S_IFMT) == S_IFDIR
    }

    /// Canonical absolute path with symlinks resolved; `nil` for paths that
    /// name nothing.
    static func canonicalPath(_ url: URL) -> String? {
        URL(fileURLWithPath: url.path).resolvingSymlinksInPath().standardizedFileURL.path
    }

    /// Load the sealed build configuration from a Recovery App's resources
    /// directory and return the managed installation root it was built for.
    public static func loadSealedInstallation(from resourcesDirectory: URL) -> Result<URL, SelectionError> {
        let url = resourcesDirectory.appendingPathComponent("recovery-installation.json")
        guard let data = FrozenFileReader.read(url, maximumBytes: maximumRecordBytes) else {
            return .failure(.missingRecord)
        }
        let sealed: SealedInstallation
        do {
            sealed = try JSONDecoder().decode(SealedInstallation.self, from: data)
        } catch {
            return .failure(.malformed(String(describing: error)))
        }
        guard sealed.schema == supportedInstallationSchema else {
            return .failure(.unsupportedSchema(sealed.schema))
        }
        return installationRoot(fromPath: sealed.installationRoot)
    }

    /// Resolve an absolute, existing, non-symlink installation directory.
    public static func installationRoot(fromPath path: String) -> Result<URL, SelectionError> {
        guard !path.isEmpty, path.hasPrefix("/"), !path.contains("\0") else {
            return .failure(.invalid("installation root must be an absolute path"))
        }
        let url = URL(fileURLWithPath: path, isDirectory: true)
        guard isRealDirectory(url) else {
            return .failure(.unsafePath(url.path))
        }
        return .success(url)
    }

    /// Load and verify the last-good record for one managed installation.
    /// - Parameters:
    ///   - recordURL: the explicit versioned last-good record file. Nothing
    ///     else is ever consulted.
    ///   - installationRoot: the chosen installation root; the record's app
    ///     bundle must sit directly inside it.
    public static func load(
        recordURL: URL,
        installationRoot: URL
    ) -> Result<Verified, SelectionError> {
        guard let data = FrozenFileReader.read(recordURL, maximumBytes: maximumRecordBytes) else {
            return .failure(.missingRecord)
        }
        let record: Record
        do {
            record = try JSONDecoder().decode(Record.self, from: data)
        } catch {
            return .failure(.malformed(String(describing: error)))
        }
        guard record.schema == supportedSchema else {
            return .failure(.unsupportedSchema(record.schema))
        }
        guard !record.appPath.isEmpty, record.appPath.hasPrefix("/"), !record.appPath.contains("\0"),
              record.appPath.hasSuffix(".app") else {
            return .failure(.invalid("appPath must be an absolute path to a .app bundle"))
        }
        guard isValidDigest(record.frozenConfigSHA256), isValidDigest(record.runtimeInventorySHA256) else {
            return .failure(.invalid("digests must be lowercase 64-character SHA-256 values"))
        }

        let appURL = URL(fileURLWithPath: record.appPath, isDirectory: true)
        guard let canonicalRoot = canonicalPath(installationRoot),
              let canonicalApp = canonicalPath(appURL) else {
            return .failure(.unsafePath(record.appPath))
        }
        // The bundle must be a direct child of the canonical installation
        // root, so a symlinked or `..`-carrying record cannot point outside
        // the chosen installation. Canonical paths resolve symlinks; the
        // recorded parent must additionally match the recorded root without
        // resolution, so the record names the real location it claims.
        guard canonicalRoot != "/", canonicalApp.hasPrefix(canonicalRoot + "/"),
              canonicalApp.dropFirst(canonicalRoot.count + 1).contains("/") == false else {
            return .failure(.outsideInstallation(record.appPath))
        }
        let recordedParent = appURL.deletingLastPathComponent().standardizedFileURL.path
        guard recordedParent == installationRoot.standardizedFileURL.path else {
            return .failure(.unsafePath(record.appPath))
        }
        guard isRealDirectory(appURL) else {
            return .failure(.missingPath(record.appPath))
        }
        let contentsURL = appURL.appendingPathComponent("Contents", isDirectory: true)
        let resourcesURL = contentsURL.appendingPathComponent("Resources", isDirectory: true)
        for directory in [contentsURL, resourcesURL] where !isRealDirectory(directory) {
            return .failure(.missingPath(directory.path))
        }

        let configURL = resourcesURL.appendingPathComponent("frozen-launcher-config.json")
        let inventoryURL = resourcesURL.appendingPathComponent("runtime-inventory.json")
        guard let configDigest = sha256Hex(of: configURL, maximumBytes: FrozenFileReader.maximumConfigBytes) else {
            return .failure(.missingPath(configURL.path))
        }
        guard configDigest == record.frozenConfigSHA256 else {
            return .failure(.hashMismatch(configURL.lastPathComponent))
        }
        guard let inventoryDigest = sha256Hex(of: inventoryURL, maximumBytes: FrozenFileReader.maximumInventoryBytes) else {
            return .failure(.missingPath(inventoryURL.path))
        }
        guard inventoryDigest == record.runtimeInventorySHA256 else {
            return .failure(.hashMismatch(inventoryURL.lastPathComponent))
        }

        // The existing frozen validator owns the schema and relative-path
        // rules; recovery reuses it instead of a second parser.
        switch FrozenLauncherConfig.load(from: resourcesURL) {
        case let .failure(error):
            switch error {
            case .missingResource:
                return .failure(.missingPath(configURL.path))
            case let .malformed(detail):
                return .failure(.malformed(detail))
            case let .invalid(detail):
                return .failure(.invalid(detail))
            case let .pathEscapes(path):
                return .failure(.outsideInstallation(path))
            }
        case let .success(launch):
            switch launch.config.validate(resolved: launch) {
            case let .failure(error):
                return .failure(.invalid(describeFrozenValidation(error)))
            case .success:
                switch validateDataHome(launch.dshHomeURL, installationRoot: installationRoot, appURL: appURL) {
                case let .failure(error):
                    return .failure(error)
                case .success:
                    return .success(Verified(
                        record: record,
                        installationRoot: installationRoot,
                        appURL: appURL,
                        resourcesDirectory: resourcesURL,
                        launch: launch))
                }
            }
        }
    }

    /// The recorded data home must be a real directory strictly inside the
    /// chosen managed installation, reached through checked components, and
    /// must not overlap the selected App bundle in either direction. Only the
    /// recorded path is consulted: no directory scan and no mtime fallback.
    /// Intermediate components are checked below the recorded root (or, when
    /// the record names a `/tmp`-style path whose canonical prefix differs,
    /// below the canonical root), so a legitimate `/tmp`-prefixed home stays
    /// valid while a symlinked, missing, or `..` component is refused.
    static func validateDataHome(
        _ home: URL,
        installationRoot: URL,
        appURL: URL
    ) -> Result<Void, SelectionError> {
        let homePath = home.path
        guard !homePath.contains("\0") else {
            return .failure(.invalid("data home path contains NUL"))
        }
        let recordedComponents = homePath.split(separator: "/").map(String.init)
        guard !recordedComponents.isEmpty,
              !recordedComponents.contains("."),
              !recordedComponents.contains("..") else {
            return .failure(.invalid("data home must be an explicit path without `.` or `..` components"))
        }
        guard let canonicalRoot = canonicalPath(installationRoot),
              let canonicalHome = canonicalPath(home),
              let canonicalApp = canonicalPath(appURL),
              canonicalRoot != "/",
              canonicalHome.hasPrefix(canonicalRoot + "/") else {
            return .failure(.outsideInstallation(homePath))
        }
        guard !Self.overlap(canonicalHome, canonicalApp) else {
            return .failure(.invalid("data home overlaps the selected App: \(homePath)"))
        }
        guard isRealDirectory(home) else {
            return .failure(.unsafePath(homePath))
        }
        let rootPath = installationRoot.standardizedFileURL.path
        let recordedUnderRoot = homePath.hasPrefix(rootPath == "/" ? "/" : rootPath + "/")
        var cursor = recordedUnderRoot ? rootPath : canonicalRoot
        let relative = recordedUnderRoot
            ? homePath.dropFirst((rootPath == "/" ? 0 : rootPath.count) + 1)
            : canonicalHome.dropFirst(canonicalRoot.count + 1)
        for component in relative.split(separator: "/") {
            cursor += "/" + component
            if !isRealDirectory(URL(fileURLWithPath: cursor, isDirectory: true)) {
                return .failure(.unsafePath(homePath))
            }
        }
        return .success(())
    }

    /// `true` when the two canonical paths are equal or one is an ancestor of
    /// the other, so neither directory can be the other's data.
    static func overlap(_ first: String, _ second: String) -> Bool {
        first == second
            || first.hasPrefix(second.hasSuffix("/") ? second : second + "/")
            || second.hasPrefix(first.hasSuffix("/") ? first : first + "/")
    }

    static func describeFrozenValidation(_ error: FrozenLauncherConfig.ConfigError) -> String {
        switch error {
        case .missingResource: return "missing frozen configuration resource"
        case let .malformed(detail): return detail
        case let .invalid(detail): return detail
        case let .pathEscapes(path): return "path escapes the bundle: \(path)"
        }
    }
}
