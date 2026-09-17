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
        return runner.runAll([
            ("readiness-line parsing, redaction, config", ParsingTests().run),
            ("authenticated probe", ProbeTests().run),
            ("backend controller lifecycle", ControllerTests().run),
        ])
    }
}
