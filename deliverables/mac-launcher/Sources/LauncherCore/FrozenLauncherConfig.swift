import Foundation

/// Everything the frozen candidate needs to run its materialized payload:
/// the bundle-relative runtime paths, the recorded absolute trial data home,
/// and the source identifiers recorded at build time. The file
/// (`Contents/Resources/frozen-launcher-config.json`) is non-secret and is
/// sealed by the runtime inventory; the Swift loader re-checks the schema and
/// the relative-path rules instead of trusting the build tool.
public struct FrozenLauncherConfig: Codable, Equatable {

    public let mode: String
    /// Bundle-relative directory holding the materialized dsh runtime.
    public let runtimeDirectory: String
    /// Bundle-relative path of the copied standalone Node binary.
    public let nodePath: String
    /// Runtime-relative path of the `dsh` CLI entry, resolved by the build
    /// from the deployed manifest's `bin.dsh`.
    public let dshEntryPath: String
    /// Absolute trial data home recorded at build time. The candidate uses
    /// exactly this home and never inherits an ambient `DSH_HOME`.
    public let dshHome: String
    /// Bundle-relative path of the immutable `--patch` launch overlay.
    public let patchPath: String
    /// Source revision recorded verbatim from an explicit build argument.
    public let sourceRevision: String
    /// SHA-256 digest of the deployed runtime's lockfile, recorded from an
    /// explicit build argument. Informational only: this is not an approved
    /// stable release marker.
    public let lockfileDigest: String
    /// Bundle-relative inventory the Swift integrity validator seals against.
    public let inventoryFile: String

    public enum ConfigError: Error, Equatable {
        /// The bundle contains no frozen configuration; it is not a frozen
        /// candidate.
        case missingResource
        /// The file exists but is not valid JSON with the expected fields.
        case malformed(String)
        /// A field violates its schema (wrong mode, empty source revision, a data
        /// home that is not absolute).
        case invalid(String)
        /// A bundle-relative field escapes the bundle or names nothing usable.
        case pathEscapes(String)
    }

    /// The resolved filesystem locations one frozen launch needs.
    public struct Resolved: Equatable {
        public let config: FrozenLauncherConfig
        public let resourcesDirectory: URL
        public let runtimeDirectory: URL
        public let nodeURL: URL
        public let dshEntryURL: URL
        public let patchURL: URL
        public let inventoryURL: URL
        public let dshHomeURL: URL
    }

    /// A relative path is accepted only as `/`-separated components that stay
    /// inside the bundle; `..`, absolute paths, empty components, and
    /// separators other than `/` are refused before any URL is built.
    static func isValidBundleRelativePath(_ value: String) -> Bool {
        guard !value.isEmpty, !value.hasPrefix("/"), !value.contains("\\"), !value.contains("\0") else {
            return false
        }
        return value.split(separator: "/", omittingEmptySubsequences: false).allSatisfy {
            $0 != "." && $0 != ".." && !$0.isEmpty
        }
    }

    /// Load and resolve the frozen configuration from a bundle resources
    /// directory. Returns the first violated rule; nothing is guessed.
    public static func load(from resourcesDirectory: URL) -> Result<Resolved, ConfigError> {
        let url = resourcesDirectory.appendingPathComponent("frozen-launcher-config.json")
        guard let data = FrozenFileReader.read(url, maximumBytes: 64 * 1024) else { return .failure(.missingResource) }
        let config: FrozenLauncherConfig
        do {
            config = try JSONDecoder().decode(FrozenLauncherConfig.self, from: data)
        } catch {
            return .failure(.malformed(String(describing: error)))
        }
        guard config.mode == "frozen" else {
            return .failure(.invalid("mode must be \"frozen\", got \(config.mode)"))
        }
        guard config.inventoryFile == "runtime-inventory.json" else {
            return .failure(.invalid("inventoryFile must be runtime-inventory.json"))
        }
        for relative in [config.runtimeDirectory, config.nodePath, config.dshEntryPath, config.patchPath, config.inventoryFile]
        where !isValidBundleRelativePath(relative) {
            return .failure(.pathEscapes(relative))
        }
        guard config.dshHome.hasPrefix("/") else {
            return .failure(.invalid("dshHome must be an absolute path, got \(config.dshHome)"))
        }
        guard !config.sourceRevision.isEmpty else {
            return .failure(.invalid("sourceRevision is empty"))
        }
        guard config.lockfileDigest.count == 64,
              config.lockfileDigest.allSatisfy({ ("0"..."9").contains($0) || ("a"..."f").contains($0) }) else {
            return .failure(.invalid("lockfileDigest must be a lowercase 64-character SHA-256 digest"))
        }
        let resolved = Resolved(
            config: config,
            resourcesDirectory: resourcesDirectory,
            runtimeDirectory: resourcesDirectory.appendingPathComponent(config.runtimeDirectory, isDirectory: true),
            nodeURL: resourcesDirectory.appendingPathComponent(config.nodePath),
            dshEntryURL: resourcesDirectory.appendingPathComponent(config.runtimeDirectory, isDirectory: true)
                .appendingPathComponent(config.dshEntryPath),
            patchURL: resourcesDirectory.appendingPathComponent(config.patchPath),
            inventoryURL: resourcesDirectory.appendingPathComponent(config.inventoryFile),
            dshHomeURL: URL(fileURLWithPath: config.dshHome, isDirectory: true))
        return .success(resolved)
    }

    /// Cheap filesystem checks the App runs before and after the integrity
    /// validation: the copied Node must be executable, the entry and the
    /// launch overlay readable, and the recorded data home must exist as a
    /// real (non-symlink) directory. The home is used as recorded; the
    /// launcher never creates it and never seeds it.
    public func validate(resolved: Resolved, fileManager: FileManager = .default) -> Result<Void, ConfigError> {
        let nodeIsRegular = try? resolved.nodeURL.resolvingSymlinksInPath()
            .resourceValues(forKeys: [.isRegularFileKey]).isRegularFile
        guard nodeIsRegular == true, fileManager.isExecutableFile(atPath: resolved.nodeURL.path) else {
            return .failure(.invalid("the bundled Node is missing or not executable: \(resolved.nodeURL.path)"))
        }
        guard fileManager.isReadableFile(atPath: resolved.dshEntryURL.path) else {
            return .failure(.invalid("the bundled dsh entry is not readable: \(resolved.dshEntryURL.path)"))
        }
        guard fileManager.isReadableFile(atPath: resolved.patchURL.path) else {
            return .failure(.invalid("the bundled launch overlay is not readable: \(resolved.patchURL.path)"))
        }
        let homeValues = try? resolved.dshHomeURL.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey])
        guard homeValues?.isDirectory == true, homeValues?.isSymbolicLink != true else {
            return .failure(.invalid("the recorded data home is not a real directory: \(resolved.dshHomeURL.path)"))
        }
        let home = resolved.dshHomeURL.resolvingSymlinksInPath().standardizedFileURL.path
        let resources = resolved.resourcesDirectory.resolvingSymlinksInPath().standardizedFileURL.path
        let stableHome = fileManager.homeDirectoryForCurrentUser.appendingPathComponent(".dsh")
            .resolvingSymlinksInPath().standardizedFileURL.path
        guard home != stableHome, home != resources,
              !home.hasPrefix(resources + "/"), !resources.hasPrefix(home + "/") else {
            return .failure(.invalid("the trial data home overlaps the stable home or bundled runtime"))
        }
        return .success(())
    }
}
