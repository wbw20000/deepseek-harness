import Foundation

@main
struct LauncherTestsProgram {
    @MainActor
    static func main() {
        exit(runSuites())
    }

    @MainActor
    private static func runSuites() -> Int32 {
        let runner = TestRunner()
        let arguments = CommandLine.arguments
        if arguments.count == 3 && arguments[1] == "--frozen-smoke-resources" {
            return runner.runAll([("bundled runtime launch and reopen", FrozenRuntimeSmoke(
                resources: URL(fileURLWithPath: arguments[2], isDirectory: true)).run)])
        }
        guard arguments.count == 1 else {
            print("usage: LauncherTests [--frozen-smoke-resources <absolute Resources path>]")
            return 2
        }
        return runner.runAll([
            ("readiness-line parsing, redaction, config", ParsingTests().run),
            ("authenticated probe", ProbeTests().run),
            ("backend controller lifecycle", ControllerTests().run),
            ("frozen launch config, integrity, and selection", FrozenLaunchTests().run),
        ])
    }
}
