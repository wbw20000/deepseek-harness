import Foundation

/// Executable test runner. Everything runs on the main actor, exactly where
/// `BackendController` confines its state; asynchronous waits drain the main
/// run loop, which also services the controller's main-queue hops, so no wait
/// is a sleep and no assertion races the controller. The process exits nonzero
/// when any check failed.
@MainActor
final class TestRunner {

    private(set) var failures = 0
    private(set) var checks = 0
    private var currentSuite = ""

    func runAll(_ suites: [(name: String, run: (TestRunner) -> Void)]) -> Int32 {
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

    /// Drains the main run loop, servicing pending main-queue work, until the
    /// semaphore fires or the deadline passes. Returns whether it fired.
    @discardableResult
    func drainUntil(_ semaphore: DispatchSemaphore, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            switch semaphore.wait(timeout: .now()) {
            case .success: return true
            case .timedOut: break
            }
            if Date() >= deadline { return false }
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }
    }
}

enum TempDir {
    /// Creates a unique directory under the process temp root; tests always
    /// clean up what they create.
    static func make(_ label: String) -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("launcher-tests-\(label)-\(UUID().uuidString)", isDirectory: true)
        try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
        return url
    }

    static func remove(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }
}

enum Fixtures {
    /// Writes an executable fixture script. The script plays the backend's
    /// stdout contract for the encoded mode; the launcher runs it as both the
    /// "node" executable and the "dsh entry", so `$1` is the script path and
    /// the sidecar `"$1.url"` carries the readiness line. No fixed port, no
    /// shared path, no user process touched.
    static func fixtureEntry(in root: URL, mode: String) -> URL {
        let entry = root.appendingPathComponent("entry-\(mode).sh")
        let behavior: String
        switch mode {
        case "ready":
            behavior = "cat \"$1.url\"\nexec sleep 120\n"
        case "crash-after-ready":
            behavior = "cat \"$1.url\"\nsleep 0.4\n"
        case "signal-after-ready":
            behavior = "cat \"$1.url\"\nsleep 0.4\nkill -9 \"$$\"\n"
        case "ignore-term":
            behavior = "trap '' TERM\ncat \"$1.url\"\nexec sleep 120\n"
        case "hang":
            behavior = "exec sleep 120\n"
        case "early-exit":
            behavior = "echo fixture-not-ready >&2\nexit 7\n"
        case "env-dump":
            behavior = "printf 'HOME=%s\\nDSH_HOME=%s\\n' \"$HOME\" \"$DSH_HOME\" > \"$1.env\"\ncat \"$1.url\"\nexec sleep 120\n"
        default:
            fatalError("unknown fixture mode \(mode)")
        }
        try! ("#!/bin/sh\n" + behavior).write(to: entry, atomically: true, encoding: .utf8)
        try! FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: entry.path)
        return entry
    }

    /// Writes the readiness sidecar for a fixture entry.
    static func readinessLine(for entry: URL, _ line: String) {
        try! (line + "\n").write(to: URL(fileURLWithPath: entry.path + ".url"), atomically: true, encoding: .utf8)
    }

    /// A well-formed loopback readiness line with a fresh opaque token.
    static func authenticatedURL(port: Int, token: String, lanSuffix: Bool = false) -> String {
        let base = "dsh web: http://127.0.0.1:\(port)/?token=\(token)"
        return lanSuffix ? base + " (LAN: http://192.168.1.20:\(port)/?token=\(token))" : base
    }
}
