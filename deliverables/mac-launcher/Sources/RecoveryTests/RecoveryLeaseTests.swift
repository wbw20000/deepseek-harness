import Foundation
@testable import LauncherCore

/// Lease tests prove the OS-held exclusion contract: two in-process acquires
/// conflict, release frees the data home, missing or linked data homes are
/// refused, and an independent process holding the lock blocks a second
/// Recovery process until it exits. The holder is a child of this test
/// executable with a readiness file; the parent observes the real lock state,
/// then awaits the child's exit before the final acquire.
@MainActor
struct RecoveryLeaseTests {

    func run(_ runner: RecoveryTestRunner) {
        inProcessExclusion(runner)
        missingAndLinkedHomes(runner)
        independentProcessExclusion(runner)
    }

    private func inProcessExclusion(_ runner: RecoveryTestRunner) {
        let home = TempDir.make("lease-home")
        defer { TempDir.remove(home) }
        switch RecoveryLease.acquire(dataHome: home) {
        case let .failure(error):
            runner.check(false, "first acquire succeeds (got \(error))")
        case let .success(first):
            if case .failure(.unavailable) = RecoveryLease.acquire(dataHome: home) {
                runner.check(true, "second acquire on the same data home is unavailable")
            } else {
                runner.check(false, "second acquire is refused")
            }
            first.release()
            first.release()
            switch RecoveryLease.acquire(dataHome: home) {
            case .success(let second):
                runner.check(true, "release frees the data home")
                second.release()
            case let .failure(error):
                runner.check(false, "release frees the data home (got \(error))")
            }
        }
    }

    private func missingAndLinkedHomes(_ runner: RecoveryTestRunner) {
        let root = TempDir.make("lease-missing")
        defer { TempDir.remove(root) }
        let missing = root.appendingPathComponent("absent-home", isDirectory: true)
        if case let .failure(error) = RecoveryLease.acquire(dataHome: missing), case .cannotLock = error {
            runner.check(true, "missing data home is refused")
        } else {
            runner.check(false, "missing data home is refused")
        }

        let real = root.appendingPathComponent("real-home", isDirectory: true)
        try! FileManager.default.createDirectory(at: real, withIntermediateDirectories: false)
        let linked = root.appendingPathComponent("linked-home", isDirectory: true)
        try? FileManager.default.createSymbolicLink(at: linked, withDestinationURL: real)
        if case .failure = RecoveryLease.acquire(dataHome: linked) {
            runner.check(true, "symlinked data home is refused, not locked through the link")
        } else {
            runner.check(false, "symlinked data home is refused")
        }
    }

    /// Cross-process exclusion uses a real second process. The child holds
    /// the lease and signals readiness through a private file; the parent
    /// then observes `unavailable`, terminates the child, awaits its exit,
    /// and proves the kernel released the lock.
    private func independentProcessExclusion(_ runner: RecoveryTestRunner) {
        let home = TempDir.make("lease-child-home")
        let workspace = TempDir.make("lease-child-work")
        defer { TempDir.remove(home); TempDir.remove(workspace) }

        let readyFile = workspace.appendingPathComponent("holder-ready")
        let executable = URL(fileURLWithPath: CommandLine.arguments[0])
        let child = Process()
        child.executableURL = executable
        child.arguments = ["--hold-recovery-lease", home.path, readyFile.path]
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        let exited = DispatchSemaphore(value: 0)
        child.terminationHandler = { _ in exited.signal() }
        do {
            try child.run()
        } catch {
            runner.check(false, "holder child starts (got \(error))")
            return
        }
        runner.check(runner.waitUntil(FileManager.default.fileExists(atPath: readyFile.path), timeout: 15),
                     "holder child signals the lease is held")

        if case .failure(.unavailable) = RecoveryLease.acquire(dataHome: home) {
            runner.check(true, "an independent holder makes acquire unavailable")
        } else {
            runner.check(false, "an independent holder blocks acquire")
        }

        // A timeout would leave the child running; report before asserting
        // anything that depends on its exit.
        child.terminate()
        runner.check(runner.drainUntil(exited, timeout: 15), "holder child exits on SIGTERM")
        runner.check(child.terminationReason == .uncaughtSignal,
                     "holder child died from the requested signal, not a timeout kill")
        switch RecoveryLease.acquire(dataHome: home) {
        case .success(let lease):
            runner.check(true, "process exit released the lease")
            lease.release()
        case let .failure(error):
            runner.check(false, "process exit released the lease (got \(error))")
        }
    }
}
