import Foundation

/// Child environment for a frozen launch. The recorded data home wins over
/// anything inherited, and the classes of variables that could redirect or
/// observe the bundled Node are removed: `NODE_OPTIONS`/`NODE_PATH` (runtime
/// redirection), every `DYLD_*` variable (dynamic-loader redirection), and
/// secret-like names (`KEY`, `SECRET`, `TOKEN`, `PASSWORD` substrings,
/// case-insensitive), so harness credentials never reach the frozen child.
/// Everything else — `HOME`, `PATH`, `TMPDIR`, `USER`, locale and other basic
/// OS context — passes through untouched. This is environment hygiene, not
/// process or network confinement: the frozen backend runs with the user's
/// normal privileges.
public enum FrozenEnvironment {

    /// Variables always removed in frozen mode besides the `DYLD_*` prefix.
    public static let removedNames: Set<String> = ["NODE_OPTIONS", "NODE_PATH"]

    /// Whether a variable name is secret-like and must be dropped.
    public static func isSecretLike(_ name: String) -> Bool {
        let lowered = name.lowercased()
        return lowered.contains("key") || lowered.contains("secret") ||
            lowered.contains("token") || lowered.contains("password")
    }

    static func isRemoved(_ name: String) -> Bool {
        removedNames.contains(name) || name.hasPrefix("DYLD_") || isSecretLike(name)
    }

    /// Build the child environment: inherited variables minus the removed
    /// classes, with `DSH_HOME` forced to the recorded data home.
    /// - Parameters:
    ///   - dshHome: the recorded absolute trial data home.
    ///   - source: the environment to start from (defaults to this process's
    ///     environment; injectable for tests).
    public static func childEnvironment(
        dshHome: String,
        source: [String: String] = ProcessInfo.processInfo.environment
    ) -> [String: String] {
        var environment = source
        for name in environment.keys where isRemoved(name) {
            environment.removeValue(forKey: name)
        }
        environment["DSH_HOME"] = dshHome
        return environment
    }
}
