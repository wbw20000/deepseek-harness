import Foundation
@testable import LauncherCore

/// Opt-in recovery test against a separately packaged last-good runtime and
/// its recorded isolated data home. No browser or model request is opened.
@MainActor
struct RecoveryRuntimeSmoke {
    let installation: URL

    func run(_ runner: RecoveryTestRunner) {
        let record = installation.appendingPathComponent("recovery-last-good.json")
        guard case let .success(verified) = RecoverySelection.load(
            recordURL: record, installationRoot: installation) else {
            runner.check(false, "the supplied last-good record selects a frozen runtime")
            return
        }
        runner.check(true, "the supplied last-good record selects a frozen runtime")
        let controller = BackendController(
            frozen: verified.launch, diagnosticLog: nil, probe: AuthenticatedProbe(),
            workingDirectory: verified.launch.dshHomeURL, onPhaseChange: { _ in })
        for attempt in 1...2 {
            controller.start()
            let deadline = Date().addingTimeInterval(120)
            while controller.phase != .running && Date() < deadline {
                if case .failed = controller.phase { break }
                RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
            }
            runner.check(controller.phase == .running,
                         "recovery launch \(attempt) verifies payload and authenticated readiness")
            if case let .failed(message) = controller.phase {
                print("  diagnostic: \(Redaction.redact(message))")
            }
            runner.check(controller.authenticatedURL?.host == "127.0.0.1",
                         "recovery launch \(attempt) announces loopback only")
            if controller.phase == .running {
                let competing = BackendController(
                    frozen: verified.launch, diagnosticLog: nil, probe: nil,
                    workingDirectory: verified.launch.dshHomeURL, onPhaseChange: { _ in })
                competing.start()
                runner.check(competing.phase == .failed(LauncherCopy.backendLeaseBusy)
                             && !competing.requiresTeardown,
                             "recovery launch \(attempt) excludes a competing frozen launcher")
                let competitorStopped = DispatchSemaphore(value: 0)
                competing.stop { competitorStopped.signal() }
                runner.check(runner.drainUntil(competitorStopped, timeout: 20),
                             "competing launcher teardown settles")
            }
            let stopped = DispatchSemaphore(value: 0)
            controller.stop { stopped.signal() }
            runner.check(runner.drainUntil(stopped, timeout: 20),
                         "recovery launch \(attempt) stops its owned backend")
            runner.check(controller.phase == .idle && !controller.requiresTeardown,
                         "recovery launch \(attempt) settles before restart")
            guard controller.phase == .idle else { break }
        }
    }
}
