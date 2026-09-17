import Foundation
@testable import LauncherCore

/// Real-`Process` lifecycle tests, all on the main actor where the controller
/// confines its state. Every fixture child runs from a unique private
/// directory, every URL comes from an OS-assigned port or a one-off token, and
/// every controller is stopped and awaited before the test returns. No test
/// signals a process it did not create; the unrelated-process case proves the
/// controller leaves strangers alone.
@MainActor
struct ControllerTests {

    func run(_ t: TestRunner) {
        teardownDecision(t)
        startToRunningAndRestart(t)
        exitBeforeReadiness(t)
        crashAfterReadiness(t)
        signalAfterReadiness(t)
        invalidReadinessURL(t)
        stopDuringStartup(t)
        startupDeadline(t)
        graceEscalation(t)
        probeConfirmedRunning(t)
        homeAndDshHomeIsolation(t)
        unrelatedProcessSurvives(t)
    }

    // MARK: Harness

    @MainActor
    private final class Harness {
        let root: URL
        let log: DiagnosticLog
        let server: HTTPTestServer?
        let token: String
        let runner: TestRunner
        var controllers: [BackendController] = []

        init(root: URL, log: DiagnosticLog, server: HTTPTestServer?, token: String, runner: TestRunner) {
            self.root = root
            self.log = log
            self.server = server
            self.token = token
            self.runner = runner
        }

        func urlLine() -> String {
            Fixtures.authenticatedURL(port: server?.port ?? 0, token: token)
        }

        func cleanup() {
            for controller in controllers {
                let stopped = DispatchSemaphore(value: 0)
                controller.stop { stopped.signal() }
                runner.check(runner.drainUntil(stopped, timeout: 30), "fixture teardown settles before removing its files")
            }
            server?.stop()
            TempDir.remove(root)
        }
    }

    /// Builds a private harness: temp root, fixture node placeholder, log, and
    /// — when the test needs a live announced server — an OS-assigned server.
    private func harness(_ t: TestRunner, withServer: Bool) -> Harness {
        let root = TempDir.make("controller")
        let node = root.appendingPathComponent("node")
        try! Data("#!/bin/sh\nexit 0\n".utf8).write(to: node)
        try! FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        let token = "tok-\(UUID().uuidString)"
        var server: HTTPTestServer?
        if withServer {
            guard let made = try? HTTPTestServer() else {
                t.check(false, "the loopback test server starts")
                return Harness(root: root, log: log(in: root), server: nil, token: token, runner: t)
            }
            made.handler = HTTPTestServer.browserAuthHandler(token: token)
            try! made.start()
            server = made
        }
        return Harness(root: root, log: log(in: root), server: server, token: token, runner: t)
    }

    private func log(in root: URL) -> DiagnosticLog {
        try! DiagnosticLog(url: root.appendingPathComponent("launcher.log"))
    }

    private func makeController(
        _ h: Harness,
        mode: String,
        probe: AuthenticatedProbe? = nil,
        dshHomeOverride: URL? = nil,
        terminationGrace: TimeInterval = 1.0,
        startupTimeout: TimeInterval = 30.0
    ) -> (BackendController, URL) {
        let entry = Fixtures.fixtureEntry(in: h.root, mode: mode)
        Fixtures.readinessLine(for: entry, h.urlLine())
        let controller = BackendController(
            config: LauncherConfig(
                projectDirectory: h.root.path,
                nodeExecutable: entry.path,
                dshEntry: entry.path),
            diagnosticLog: h.log,
            probe: probe,
            workingDirectory: FileManager.default.homeDirectoryForCurrentUser,
            dshHomeOverride: dshHomeOverride,
            terminationGrace: terminationGrace,
            startupTimeout: startupTimeout,
            onPhaseChange: { _ in })
        h.controllers.append(controller)
        return (controller, entry)
    }

    /// Bounded wait on the run loop; the phase check itself is instantaneous.
    @discardableResult
    private func waitFor(
        _ controller: BackendController,
        _ predicate: (BackendController.Phase) -> Bool,
        timeout: TimeInterval,
        _ t: TestRunner,
        _ label: String
    ) -> BackendController.Phase? {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            if predicate(controller.phase) { return controller.phase }
            if Date() >= deadline {
                t.check(false, label)
                return nil
            }
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }
    }

    private func failedMessage(_ phase: BackendController.Phase?) -> String? {
        if case let .failed(message) = phase { return message }
        return nil
    }

    /// Stops and waits for the completion, so teardown is quiescent before the
    /// test returns.
    private func awaitedStop(_ controller: BackendController, _ t: TestRunner) {
        let semaphore = DispatchSemaphore(value: 0)
        controller.stop { semaphore.signal() }
        t.check(t.drainUntil(semaphore, timeout: 30), "stop completes within the test bound")
    }

    // MARK: Teardown decision (pure)

    private func teardownDecision(_ t: TestRunner) {
        t.check(
            BackendController.teardownAction(elapsed: 0.1, childRunning: true, didSendKill: false, grace: 6, backstop: 3) == .wait,
            "inside the grace the child is only waited on")
        t.check(
            BackendController.teardownAction(elapsed: 6, childRunning: true, didSendKill: false, grace: 6, backstop: 3) == .kill,
            "after the grace SIGKILL escalates")
        t.check(
            BackendController.teardownAction(elapsed: 100, childRunning: false, didSendKill: false, grace: 6, backstop: 3) == .wait,
            "an exited child is never signalled again; its exit handler owns completion")
        t.check(
            BackendController.teardownAction(elapsed: 8.9, childRunning: true, didSendKill: true, grace: 6, backstop: 3) == .wait,
            "inside the post-SIGKILL backstop the teardown keeps waiting")
        t.check(
            BackendController.teardownAction(elapsed: 9, childRunning: true, didSendKill: true, grace: 6, backstop: 3) == .confirmUnconfirmed,
            "at the backstop teardown completes unconfirmed and must be reported")
    }

    // MARK: Lifecycle

    private func startToRunningAndRestart(_ t: TestRunner) {
        let h = harness(t, withServer: false)
        defer { h.cleanup() }
        let (controller, entry) = makeController(h, mode: "ready")
        controller.start()
        waitFor(controller, { $0 == .running }, timeout: 10, t, "the readiness line moves start to running")
        t.check(controller.authenticatedURL?.query?.hasPrefix("token=") == true, "the authenticated URL is held in memory")
        t.check(controller.requiresTeardown, "a running child owes teardown")

        awaitedStop(controller, t)
        t.check(controller.phase == .idle, "stop completes to idle")
        t.check(!controller.requiresTeardown, "no teardown is owed after stop")
        t.check(controller.authenticatedURL == nil, "the authenticated URL is cleared on stop")

        Fixtures.readinessLine(for: entry, h.urlLine())
        controller.start()
        waitFor(controller, { $0 == .running }, timeout: 10, t, "a restart after stop reaches running again")
        awaitedStop(controller, t)
        t.check(controller.phase == .idle, "the second stop completes to idle")
    }

    private func exitBeforeReadiness(_ t: TestRunner) {
        let h = harness(t, withServer: false)
        defer { h.cleanup() }
        let (controller, _) = makeController(h, mode: "early-exit")
        controller.start()
        let phase = waitFor(controller, { if case .failed = $0 { return true } else { return false } },
                            timeout: 10, t, "an early exit reports failed")
        t.check(failedMessage(phase)?.contains("退出码 7") == true,
                "the diagnostic distinguishes a normal exit and carries the code")
        t.check(controller.authenticatedURL == nil, "no authenticated URL survives a dead child")
        t.check(!controller.requiresTeardown, "a failed start owes no teardown")
    }

    private func crashAfterReadiness(_ t: TestRunner) {
        let h = harness(t, withServer: false)
        defer { h.cleanup() }
        let (controller, _) = makeController(h, mode: "crash-after-ready")
        controller.start()
        waitFor(controller, { $0 == .running }, timeout: 10, t, "the ready fixture reaches running")
        let phase = waitFor(controller, { if case .failed = $0 { return true } else { return false } },
                            timeout: 10, t, "a ready-child crash reports failed, not green")
        t.check(failedMessage(phase)?.contains("已退出") == true, "the diagnostic names the exit after readiness")
        t.check(controller.authenticatedURL == nil, "the stale authenticated URL is cleared after the crash")
    }

    private func signalAfterReadiness(_ t: TestRunner) {
        let h = harness(t, withServer: false)
        defer { h.cleanup() }
        let (controller, _) = makeController(h, mode: "signal-after-ready")
        controller.start()
        waitFor(controller, { $0 == .running }, timeout: 10, t, "the ready fixture reaches running")
        let phase = waitFor(controller, { if case .failed = $0 { return true } else { return false } },
                            timeout: 10, t, "a signal death reports failed")
        t.check(failedMessage(phase)?.contains("信号 9") == true,
                "a signal death is reported as a signal, not an exit code")
        t.check(controller.authenticatedURL == nil, "the authenticated URL is cleared after a signal death")
    }

    private func invalidReadinessURL(_ t: TestRunner) {
        let h = harness(t, withServer: false)
        defer { h.cleanup() }
        let (controller, entry) = makeController(h, mode: "ready")
        Fixtures.readinessLine(for: entry, "dsh web: http://10.9.9.9:3080/?token=xyz")
        controller.start()
        let phase = waitFor(controller, { if case .failed = $0 { return true } else { return false } },
                            timeout: 10, t, "an invalid announced URL fails the run")
        let message = failedMessage(phase)
        t.check(message?.contains("已拒绝打开") == true, "the invalid URL is reported as refused")
        t.check(message?.contains("token=xyz") != true || message?.contains("token=<redacted>") == true,
                "the refused URL text is redacted")
        t.check(controller.authenticatedURL == nil, "an unvalidated URL never becomes the in-memory link")
        t.check(!controller.requiresTeardown, "the refused run tore its own child down")
    }

    private func stopDuringStartup(_ t: TestRunner) {
        let h = harness(t, withServer: false)
        defer { h.cleanup() }
        let (controller, _) = makeController(h, mode: "hang", startupTimeout: 30)
        controller.start()
        waitFor(controller, { $0 == .starting }, timeout: 10, t, "a hanging child stays in starting")
        awaitedStop(controller, t)
        t.check(controller.phase == .idle, "quitting during startup waits for the child and reports idle")
        t.check(!controller.requiresTeardown, "no teardown is owed after the startup stop")
    }

    private func startupDeadline(_ t: TestRunner) {
        let h = harness(t, withServer: false)
        defer { h.cleanup() }
        let (controller, _) = makeController(h, mode: "hang", startupTimeout: 1.0)
        controller.start()
        let phase = waitFor(controller, { if case .failed = $0 { return true } else { return false } },
                            timeout: 15, t, "the startup deadline reports failure")
        t.check(failedMessage(phase) == LauncherCopy.startupTimedOut(seconds: 1),
                "the deadline diagnostic is the technical startup bound")
        t.check(!controller.requiresTeardown, "the deadline tore its own child down")
    }

    private func graceEscalation(_ t: TestRunner) {
        let h = harness(t, withServer: false)
        defer { h.cleanup() }
        let (controller, _) = makeController(h, mode: "ignore-term", terminationGrace: 0.3)
        controller.start()
        waitFor(controller, { $0 == .running }, timeout: 10, t, "the TERM-immune fixture reaches running")
        awaitedStop(controller, t)
        t.check(controller.phase == .idle, "SIGKILL after the grace completes teardown")
        let logContent = (try? String(contentsOf: h.root.appendingPathComponent("launcher.log"), encoding: .utf8)) ?? ""
        t.check(logContent.contains("SIGKILL"), "the escalation is recorded in diagnostics")
    }

    private func probeConfirmedRunning(_ t: TestRunner) {
        let h = harness(t, withServer: true)
        defer { h.cleanup() }
        let (controller, _) = makeController(h, mode: "ready", probe: AuthenticatedProbe())
        controller.start()
        let running = waitFor(controller, { $0 == .running }, timeout: 15, t,
                              "a probe-confirmed run reaches running")
        t.check(running != nil && controller.authenticatedURL != nil,
                "the authenticated URL survives probe confirmation")
        awaitedStop(controller, t)
    }

    private func homeAndDshHomeIsolation(_ t: TestRunner) {
        let h = harness(t, withServer: false)
        defer { h.cleanup() }
        let dataHome = TempDir.make("dsh-home")
        defer { TempDir.remove(dataHome) }
        let entry = Fixtures.fixtureEntry(in: h.root, mode: "env-dump")
        Fixtures.readinessLine(for: entry, h.urlLine())
        let controller = BackendController(
            config: LauncherConfig(
                projectDirectory: h.root.path,
                nodeExecutable: entry.path,
                dshEntry: entry.path),
            diagnosticLog: h.log,
            probe: nil,
            workingDirectory: FileManager.default.homeDirectoryForCurrentUser,
            dshHomeOverride: dataHome,
            onPhaseChange: { _ in })
        h.controllers.append(controller)
        controller.start()
        waitFor(controller, { $0 == .running }, timeout: 10, t, "the env fixture reports ready")
        awaitedStop(controller, t)

        let envText = (try? String(contentsOf: URL(fileURLWithPath: entry.path + ".env"), encoding: .utf8)) ?? ""
        let envLines = envText.split(separator: "\n").map(String.init)
        let home = envLines.first { $0.hasPrefix("HOME=") }
        let dshHome = envLines.first { $0.hasPrefix("DSH_HOME=") }
        t.check(home == "HOME=\(ProcessInfo.processInfo.environment["HOME"] ?? "")",
                "the child keeps the inherited HOME")
        t.check(dshHome == "DSH_HOME=\(dataHome.path)", "the explicit DSH_HOME override reaches the child's data home")
        let overrideContents = try? FileManager.default.contentsOfDirectory(atPath: dataHome.path)
        t.check(overrideContents?.isEmpty ?? false, "the override data home is used as-is, never seeded with user data")
    }

    private func unrelatedProcessSurvives(_ t: TestRunner) {
        let h = harness(t, withServer: false)
        defer { h.cleanup() }
        let bystander = Process()
        bystander.executableURL = URL(fileURLWithPath: "/bin/sleep")
        bystander.arguments = ["120"]
        try! bystander.run()
        defer {
            if bystander.isRunning {
                bystander.terminate()
                bystander.waitUntilExit()
            }
        }

        let (controller, _) = makeController(h, mode: "ready")
        controller.start()
        waitFor(controller, { $0 == .running }, timeout: 10, t, "the controller reaches running beside an unrelated process")
        awaitedStop(controller, t)
        t.check(controller.phase == .idle, "the controller finishes its own teardown")
        t.check(bystander.isRunning, "the unrelated process is untouched")
    }
}
