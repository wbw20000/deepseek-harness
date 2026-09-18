import Foundation
@testable import LauncherCore

/// Executable test runner for the recovery core, mirroring `LauncherTests`:
/// everything runs on the main actor, asynchronous waits drain the main run
/// loop, and the process exits nonzero when any check failed. Kept as a
/// separate target so recovery fixtures never extend the launcher suite.
@MainActor
final class RecoveryTestRunner {

    private(set) var failures = 0
    private(set) var checks = 0
    private var currentSuite = ""

    func runAll(_ suites: [(name: String, run: (RecoveryTestRunner) -> Void)]) -> Int32 {
        let startedAt = Date()
        for suite in suites {
            currentSuite = suite.name
            print("=== \(suite.name)")
            suite.run(self)
        }
        let seconds = String(format: "%.1f", Date().timeIntervalSince(startedAt))
        print("checks: \(checks), failures: \(failures), time: \(seconds)s")
        return failures == 0 ? 0 : 1
    }

    func check(_ condition: Bool, _ label: String, file: StaticString = #filePath, line: UInt = #line) {
        checks += 1
        if condition {
            print("  ok: \(label)")
        } else {
            failures += 1
            print("  FAIL: \(label) (\(currentSuite) at \(file):\(line))")
        }
    }

    /// Drains the main run loop until the semaphore fires or the deadline
    /// passes; returns whether it fired.
    @discardableResult
    func drainUntil(_ semaphore: DispatchSemaphore, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            if semaphore.wait(timeout: .now()) == .success { return true }
            if Date() >= deadline { return false }
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }
    }

    /// Waits for an externally observable condition (a readiness file another
    /// process creates) instead of sleeping a fixed interval.
    @discardableResult
    func waitUntil(_ condition: @autoclosure () -> Bool, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() >= deadline { return false }
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }
        return true
    }

    /// Bounded wait on the run loop until the controller reports the phase;
    /// the check itself is instantaneous.
    @discardableResult
    func waitForPhase(
        of controller: BackendController,
        _ phase: BackendController.Phase,
        timeout: TimeInterval
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            if controller.phase == phase { return true }
            if Date() >= deadline { return false }
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }
    }

    /// Bounded wait until the controller reports any failure; returns the
    /// failed phase so the test can read the diagnostic.
    @discardableResult
    func waitForFailure(
        of controller: BackendController,
        timeout: TimeInterval
    ) -> BackendController.Phase? {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            if case .failed = controller.phase { return controller.phase }
            if Date() >= deadline { return nil }
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }
    }
}

enum TempDir {
    /// Private per-test directory, removed by the caller after awaited cleanup.
    static func make(_ label: String) -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("recovery-tests-\(label)-\(UUID().uuidString)", isDirectory: true)
        try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
        return url
    }

    static func remove(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }
}
