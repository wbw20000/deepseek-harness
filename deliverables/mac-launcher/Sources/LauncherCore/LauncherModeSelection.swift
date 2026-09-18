import Foundation

/// Selects the launcher shell's mode from the bundle identity alone. A frozen
/// bundle stays frozen even when its configuration resource is missing or
/// unreadable, so a damaged bundle never falls back to source-linked mode and
/// never probes resource files (a FIFO at a probed path would block `open`).
/// The footer note and the controller construction must consult the same
/// answer, which is why both call sites use this one selector.
public enum LauncherModeSelection {

    /// Bundle identifier of a frozen candidate built by `build.sh --frozen`.
    public static let frozenBundleIdentifier =
        "com.local.deepseek-harness-launcher.candidate.frozen"

    /// - Parameter bundleIdentifier: the running bundle's identifier; `nil`
    ///   when the bundle has none.
    /// - Returns: `true` only for the exact frozen candidate identity.
    public static func isFrozenCandidate(bundleIdentifier: String?) -> Bool {
        bundleIdentifier == frozenBundleIdentifier
    }
}
