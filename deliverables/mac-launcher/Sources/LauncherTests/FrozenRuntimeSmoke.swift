import Foundation
@testable import LauncherCore

/// Opt-in test of a separately built frozen bundle. Uses its recorded trial
/// home and actual Node/backend; it never opens a browser or sends model input.
@MainActor
struct FrozenRuntimeSmoke {
    let resources: URL

    func run(_ t: TestRunner) {
        guard case let .success(launch) = FrozenLauncherConfig.load(from: resources) else {
            t.check(false, "the supplied frozen bundle configuration loads")
            return
        }
        let controller = BackendController(
            frozen: launch, diagnosticLog: nil, probe: AuthenticatedProbe(),
            workingDirectory: launch.dshHomeURL, onPhaseChange: { _ in })
        for attempt in 1...2 {
            controller.start()
            let deadline = Date().addingTimeInterval(120)
            while controller.phase != .running && Date() < deadline {
                if case .failed = controller.phase { break }
                RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
            }
            t.check(controller.phase == .running, "bundled backend launch \(attempt) reaches authenticated readiness")
            if case let .failed(message) = controller.phase {
                print("  diagnostic: \(Redaction.redact(message))")
            }
            t.check(controller.authenticatedURL?.host == "127.0.0.1",
                    "bundled backend launch \(attempt) announces loopback only")
            let stopped = DispatchSemaphore(value: 0)
            controller.stop { stopped.signal() }
            t.check(t.drainUntil(stopped, timeout: 20), "bundled backend launch \(attempt) stop completes")
            t.check(controller.phase == .idle && !controller.requiresTeardown,
                    "bundled backend launch \(attempt) leaves no owned child")
            guard controller.phase == .idle else { break }
        }
    }
}
