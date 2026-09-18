import Foundation
@testable import LauncherCore

@main
struct RecoveryTestsProgram {

    @MainActor
    static func main() async {
        let arguments = CommandLine.arguments
        // Holder mode for the independent-process lease test: acquire the
        // lease, signal readiness through a private file, and hold until the
        // test parent terminates the process. The kernel releases the lock.
        if arguments.count == 4, arguments[1] == "--hold-recovery-lease" {
            let home = URL(fileURLWithPath: arguments[2], isDirectory: true)
            let readyFile = URL(fileURLWithPath: arguments[3])
            switch RecoveryLease.acquire(dataHome: home) {
            case .failure:
                FileHandle.standardError.write(Data("holder could not acquire\n".utf8))
                exit(3)
            case .success(let lease):
                try? Data().write(to: readyFile)
                // Hold until the parent's SIGTERM ends the process; the
                // release() call only documents the ownership.
                _ = sleep(120)
                lease.release()
                exit(0)
            }
        }
        // Fixture smoke mode: an explicitly enabled end-to-end pass over one
        // fixture installation — selection, full payload integrity validation,
        // and a real owned BackendController launch and stop. Fixtures only:
        // no credentials, no network, and no installed App is touched.
        if arguments.count == 3, arguments[1] == "--fixture-install" {
            exit(await runFixtureSmoke(container: URL(fileURLWithPath: arguments[2], isDirectory: true)))
        }
        if arguments.count == 3, arguments[1] == "--last-good-smoke" {
            let smoke = RecoveryRuntimeSmoke(installation: URL(fileURLWithPath: arguments[2], isDirectory: true))
            exit(RecoveryTestRunner().runAll([("packaged last-good recovery", smoke.run)]))
        }
        exit(await runSuites())
    }

    @MainActor
    private static func runSuites() async -> Int32 {
        let runner = RecoveryTestRunner()
        guard CommandLine.arguments.count == 1 else {
            print("usage: RecoveryTests [--fixture-install <existing directory> | --last-good-smoke <isolated installation>]")
            return 2
        }
        return runner.runAll([
            ("recovery last-good selection", RecoverySelectionTests().run),
            ("recovery data-home lease", RecoveryLeaseTests().run),
            ("recovery owned controller", RecoveryControllerTests().run),
        ])
    }

    /// Builds a private fixture installation inside the given container
    /// directory and exercises the full recovery path against it. The
    /// container is never cleared; only the uniquely named fixture inside it
    /// is created and removed.
    @MainActor
    private static func runFixtureSmoke(container: URL) async -> Int32 {
        var failures = 0
        let fileManager = FileManager.default
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: container.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            print("--fixture-install needs an existing directory: \(container.path)")
            return 2
        }
        let installationRoot = container
            .appendingPathComponent("recovery-fixture-\(UUID().uuidString)", isDirectory: true)
        defer { TempDir.remove(installationRoot) }
        try! fileManager.createDirectory(at: installationRoot, withIntermediateDirectories: false)
        let bundle = RecoveryFixture.make("smoke", launchable: true, installationRoot: installationRoot)
        RecoveryFixture.seal(bundle)

        switch RecoverySelection.load(recordURL: bundle.recordURL, installationRoot: bundle.installationRoot) {
        case let .failure(error):
            print("FAIL: fixture selection (got \(error))")
            return 1
        case let .success(verified):
            print("ok: selection verified \(verified.appURL.path)")
            let integrity = await RuntimeIntegrityValidator.validate(resourcesDirectory: verified.resourcesDirectory)
            if case .failure(let error) = integrity {
                print("FAIL: full payload validation (got \(error))")
                return 1
            }
            print("ok: full payload integrity validated")
            let controller = BackendController(
                frozen: verified.launch,
                diagnosticLog: nil,
                probe: nil,
                workingDirectory: verified.launch.dshHomeURL,
                terminationGrace: 1.0,
                onPhaseChange: { _ in })
            controller.start()
            let runner = RecoveryTestRunner()
            if runner.waitForPhase(of: controller, .running, timeout: 15) {
                print("ok: owned backend reached the running phase")
            } else {
                print("FAIL: owned backend never reached the running phase (phase \(controller.phase))")
                failures += 1
            }
            let stopped = DispatchSemaphore(value: 0)
            controller.stop { stopped.signal() }
            if runner.drainUntil(stopped, timeout: 30), controller.phase == .idle {
                print("ok: owned backend stopped and teardown settled")
            } else {
                print("FAIL: teardown did not settle (phase \(controller.phase))")
                failures += 1
            }
        }
        return failures == 0 ? 0 : 1
    }
}
