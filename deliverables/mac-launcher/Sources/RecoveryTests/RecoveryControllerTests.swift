import Foundation
@testable import LauncherCore

/// Controller-level recovery tests with a real owned `BackendController` and
/// a real fixture child: the frozen launch is gated by the data-home lease
/// and by the full payload validation, exactly as a recovery launch runs.
/// Children are fixture scripts from the private fixture bundle; every
/// controller is stopped and awaited, and the lease holder is an independent
/// child process that the parent terminates and awaits before cleanup.
@MainActor
struct RecoveryControllerTests {

    func run(_ runner: RecoveryTestRunner) {
        verifiedFixtureLaunchesAndStops(runner)
        leaseContentionFailsBeforeSpawn(runner)
        unconfirmedStopKeepsLease(runner)
    }

    private func unconfirmedStopKeepsLease(_ runner: RecoveryTestRunner) {
        let bundle = RecoveryFixture.make("unconfirmed", launchable: true)
        defer { TempDir.remove(bundle.installationRoot) }
        let node = bundle.resourcesDirectory.appendingPathComponent("payload-node")
        // Ignored TERM survives exec. The controller's owned SIGKILL remains
        // the bounded cleanup path, even if an assertion below fails.
        try! Data("#!/bin/sh\ntrap '' TERM\ncat \"$0.url\"\nexec sleep 120\n".utf8).write(to: node)
        RecoveryFixture.seal(bundle)
        guard case let .success(verified) = RecoverySelection.load(
            recordURL: bundle.recordURL, installationRoot: bundle.installationRoot) else {
            runner.check(false, "unconfirmed-stop fixture is selected")
            return
        }
        let controller = BackendController(
            frozen: verified.launch, diagnosticLog: nil, probe: nil,
            workingDirectory: bundle.dshHome, terminationGrace: 0.1,
            onPhaseChange: { _ in })
        controller.start()
        runner.check(runner.waitForPhase(of: controller, .running, timeout: 15),
                     "unconfirmed-stop fixture is ready before stopping")
        let stopped = DispatchSemaphore(value: 0)
        controller.stop { stopped.signal() }
        controller.reportUnconfirmedStop()
        runner.check(controller.requiresTeardown, "an unconfirmed frozen stop still owns teardown")
        runner.check(stopped.wait(timeout: .now()) == .timedOut,
                     "an unconfirmed frozen stop does not complete quit")
        runner.check(controller.authenticatedURL == nil, "an unconfirmed stop clears the login URL")
        if case .failure(.unavailable) = RecoveryLease.acquire(dataHome: bundle.dshHome) {
            runner.check(true, "an unconfirmed stop retains the data-home lease")
        } else {
            runner.check(false, "an unconfirmed stop retains the data-home lease")
        }
        runner.check(runner.drainUntil(stopped, timeout: 15), "late child exit completes owned teardown")
        runner.check(!controller.requiresTeardown, "confirmed exit releases lifecycle ownership")
        switch RecoveryLease.acquire(dataHome: bundle.dshHome) {
        case let .success(lease):
            runner.check(true, "confirmed late exit releases the lease")
            lease.release()
        case .failure:
            runner.check(false, "confirmed late exit releases the lease")
        }
    }

    /// A launchable, sealed fixture bundle: selection verifies it, the real
    /// integrity validator passes it, and the owned controller reaches the
    /// running phase against the fixture child, then stops and releases the
    /// data-home lease.
    private func verifiedFixtureLaunchesAndStops(_ runner: RecoveryTestRunner) {
        let bundle = RecoveryFixture.make("controller-launch", launchable: true)
        defer { TempDir.remove(bundle.installationRoot) }
        RecoveryFixture.seal(bundle)
        guard case let .success(verified) = RecoverySelection.load(
            recordURL: bundle.recordURL, installationRoot: bundle.installationRoot) else {
            runner.check(false, "the sealed launchable fixture is selected")
            return
        }
        runner.check(verified.launch.dshHomeURL == bundle.dshHome, "the controller binds the recorded data home")

        let controller = BackendController(
            frozen: verified.launch,
            diagnosticLog: nil,
            probe: nil,
            workingDirectory: bundle.dshHome,
            terminationGrace: 1.0,
            onPhaseChange: { _ in })
        controller.start()
        runner.check(runner.waitForPhase(of: controller, .running, timeout: 15),
                     "the verified fixture backend reaches the running phase")
        runner.check(controller.authenticatedURL?.query?.hasPrefix("token=") == true,
                     "the readiness URL is held in memory")

        let stopped = DispatchSemaphore(value: 0)
        controller.stop { stopped.signal() }
        runner.check(runner.drainUntil(stopped, timeout: 30), "stop completes within the test bound")
        runner.check(controller.phase == .idle, "the stopped controller is idle")
        switch RecoveryLease.acquire(dataHome: bundle.dshHome) {
        case .success(let lease):
            runner.check(true, "the controller released the data-home lease on stop")
            lease.release()
        case let .failure(error):
            runner.check(false, "the controller released the data-home lease on stop (got \(error))")
        }
    }

    /// An independent process holding the data-home lease models the ordinary
    /// frozen launcher: the recovery launch must fail with the lease copy
    /// before any process is spawned, and the same launch must reach running
    /// once the holder is gone. The holder is terminated and awaited, so the
    /// kernel — not this test — releases the lock.
    private func leaseContentionFailsBeforeSpawn(_ runner: RecoveryTestRunner) {
        let bundle = RecoveryFixture.make("controller-lease", launchable: true)
        let workspace = TempDir.make("controller-lease-work")
        defer { TempDir.remove(bundle.installationRoot); TempDir.remove(workspace) }
        RecoveryFixture.seal(bundle)
        guard case let .success(verified) = RecoverySelection.load(
            recordURL: bundle.recordURL, installationRoot: bundle.installationRoot) else {
            runner.check(false, "the contended fixture is selected")
            return
        }

        let readyFile = workspace.appendingPathComponent("holder-ready")
        let holder = Process()
        holder.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        holder.arguments = ["--hold-recovery-lease", bundle.dshHome.path, readyFile.path]
        holder.standardOutput = FileHandle.nullDevice
        holder.standardError = FileHandle.nullDevice
        let exited = DispatchSemaphore(value: 0)
        holder.terminationHandler = { _ in exited.signal() }
        do {
            try holder.run()
        } catch {
            runner.check(false, "the lease holder starts (got \(error))")
            return
        }
        runner.check(runner.waitUntil(FileManager.default.fileExists(atPath: readyFile.path), timeout: 15),
                     "the independent holder signals the lease is held")

        let controller = BackendController(
            frozen: verified.launch,
            diagnosticLog: nil,
            probe: nil,
            workingDirectory: bundle.dshHome,
            terminationGrace: 1.0,
            onPhaseChange: { _ in })
        controller.start()
        let phase = runner.waitForFailure(of: controller, timeout: 15)
        let message = phase.map { message in
            if case let .failed(text) = message { return text }
            return ""
        }
        runner.check(message == LauncherCopy.backendLeaseBusy,
                     "lease contention fails with the busy copy before any spawn")
        runner.check(!controller.requiresTeardown, "the contended launch owes no teardown")
        runner.check(controller.authenticatedURL == nil, "the contended launch never announced a URL")

        holder.terminate()
        runner.check(runner.drainUntil(exited, timeout: 15), "the holder child exits on SIGTERM")

        let freeController = BackendController(
            frozen: verified.launch,
            diagnosticLog: nil,
            probe: nil,
            workingDirectory: bundle.dshHome,
            terminationGrace: 1.0,
            onPhaseChange: { _ in })
        freeController.start()
        runner.check(runner.waitForPhase(of: freeController, .running, timeout: 15),
                     "the same launch reaches running once the holder released the data home")
        let stopped = DispatchSemaphore(value: 0)
        freeController.stop { stopped.signal() }
        runner.check(runner.drainUntil(stopped, timeout: 30), "the free launch is stopped and awaited")
    }
}
