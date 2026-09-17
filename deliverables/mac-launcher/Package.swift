// swift-tools-version:5.9
import PackageDescription

// The macOS launcher keeps its lifecycle logic in `LauncherCore` so the tests
// can exercise process ownership, readiness parsing, and redaction without
// booting AppKit. `LauncherApp` is the AppKit shell only. `LauncherTests` is a
// executable runner using the main run loop; run it with `swift run LauncherTests`.
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
    ]
)
