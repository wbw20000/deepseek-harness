// swift-tools-version:5.9
import PackageDescription

// The macOS launcher keeps its lifecycle logic in `LauncherCore` so the tests
// can exercise process ownership, readiness parsing, and redaction without
// booting AppKit. `LauncherApp` is the AppKit shell only. `LauncherTests` is a
// executable runner using the main run loop; run it with `swift run LauncherTests`.
// `RecoveryApp` is the independent opt-in recovery shell, built and packaged
// by `tools/build-recovery.sh`; `RecoveryTests` is its private no-GUI runner.
let package = Package(
    name: "DeepSeekHarnessLauncher",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "LauncherCore"),
        .executableTarget(
            name: "LauncherApp",
            dependencies: ["LauncherCore"]
        ),
        .executableTarget(
            name: "LauncherTests",
            dependencies: ["LauncherCore"]
        ),
        .executableTarget(
            name: "RecoveryApp",
            dependencies: ["LauncherCore"]
        ),
        .executableTarget(
            name: "RecoveryTests",
            dependencies: ["LauncherCore"]
        ),
    ]
)
