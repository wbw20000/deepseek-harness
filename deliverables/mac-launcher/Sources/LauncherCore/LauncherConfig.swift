import Foundation

/// Non-secret launcher configuration that build.sh emits into the candidate
/// bundle (`Contents/Resources/launcher-config.json`). It records where the
/// runtime and the checked `dsh` CLI entry live; it carries no secrets and no
/// personal defaults: every value is an explicit build input.
public struct LauncherConfig: Codable, Equatable {

    /// Absolute path of the DeepSeek Harness checkout whose built CLI is run.
    public let projectDirectory: String
    /// Absolute path of the Node executable that runs the CLI entry.
    public let nodeExecutable: String
    /// Absolute path of the checked `dsh` CLI entry (resolved by build.sh from
    /// `apps/cli/package.json`'s `bin.dsh` and verified to exist at build time).
    public let dshEntry: String

    /// Everything that can fail while loading or validating the configuration.
    public enum ConfigError: Error, Equatable {
        /// The bundle does not contain `launcher-config.json`; the App must be
        /// built through build.sh, not run from an ad-hoc binary.
        case missingResource
        /// The file exists but is not valid JSON with the expected fields.
        case malformed(String)
        /// A recorded path is not absolute.
        case notAbsolute(String)
        /// The Node executable is missing or not executable.
        case nodeNotExecutable(String)
        /// The CLI entry is missing or not readable by the current user.
        case entryNotReadable(String)
    }

    /// Load the configuration from a bundle resources directory.
    /// - Parameter resourcesDirectory: directory that should contain
    ///   `launcher-config.json` (typically `Bundle.main/resourceURL`).
    public static func load(from resourcesDirectory: URL) -> Result<LauncherConfig, ConfigError> {
        let url = resourcesDirectory.appendingPathComponent("launcher-config.json")
        guard let data = try? Data(contentsOf: url) else { return .failure(.missingResource) }
        do {
            return .success(try JSONDecoder().decode(LauncherConfig.self, from: data))
        } catch {
            return .failure(.malformed(String(describing: error)))
        }
    }

    /// Validate the recorded paths against the current filesystem. The entry
    /// check is also what makes macOS surface its Documents permission prompt
    /// once, before the child process needs the file.
    /// - Parameter fileManager: manager used for the filesystem checks.
    /// - Returns: `failure` with the first violated rule; never guesses a path.
    public func validate(fileManager: FileManager = .default) -> Result<Void, ConfigError> {
        for path in [projectDirectory, nodeExecutable, dshEntry] where !path.hasPrefix("/") {
            return .failure(.notAbsolute(path))
        }
        let nodeIsRegular = try? URL(fileURLWithPath: nodeExecutable)
            .resolvingSymlinksInPath().resourceValues(forKeys: [.isRegularFileKey]).isRegularFile
        guard nodeIsRegular == true, fileManager.isExecutableFile(atPath: nodeExecutable) else {
            return .failure(.nodeNotExecutable(nodeExecutable))
        }
        let entryIsRegular = try? URL(fileURLWithPath: dshEntry)
            .resolvingSymlinksInPath().resourceValues(forKeys: [.isRegularFileKey]).isRegularFile
        guard entryIsRegular == true, fileManager.isReadableFile(atPath: dshEntry) else {
            return .failure(.entryNotReadable(dshEntry))
        }
        return .success(())
    }
}
