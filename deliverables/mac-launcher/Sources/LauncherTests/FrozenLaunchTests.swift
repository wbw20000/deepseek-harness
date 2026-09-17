import CryptoKit
import Foundation
@testable import LauncherCore

/// Frozen-candidate behavior tests: configuration loading and resolution,
/// child environment selection, launch arguments, the Swift integrity
/// validator, and the controller's validation gating. No test launches the
/// user's backend: children run fixture scripts from private directories, and
/// every controller is stopped and awaited before its fixture is removed.
@MainActor
struct FrozenLaunchTests {

    func run(_ t: TestRunner) {
        configLoading(t)
        configValidation(t)
        environmentSelection(t)
        launchArguments(t)
        integrityAcceptsSealedPayload(t)
        integrityRejectsTamperedPayload(t)
        integrityRejectsMissingAndExtraFiles(t)
        integrityRejectsLinkShapedAndSpecialPayload(t)
        integrityRejectsInvalidInventory(t)
        integrityRejectsMetadataAndPermissionChanges(t)
        controllerGatesSpawnOnIntegrity(t)
        controllerDiscardsStaleValidationAndStopsCleanly(t)
        frozenChildUsesRecordedHomeAndScrubbedEnvironment(t)
    }

    // MARK: Fixture

    /// Builds a private bundle Resources directory with a small materialized
    /// payload and seals it with an inventory hashed the same way the build
    /// tool seals it. The validator is the subject; the inventory builder is
    /// fixture scaffolding.
    private final class Fixture {
        let root: URL
        let resources: URL
        let recordedHome: URL

        init(_ label: String) {
            root = TempDir.make(label)
            resources = root.appendingPathComponent("Resources", isDirectory: true)
            recordedHome = root.appendingPathComponent("trial-home", isDirectory: true)
            try! FileManager.default.createDirectory(at: recordedHome, withIntermediateDirectories: true)
            write("runtime/lib/bin.js", "#!/bin/sh\nexit 0\n")
            write("node/node", "#!/bin/sh\nexit 0\n", mode: 0o755)
            write("frozen-loopback.patch.yml", "- id: webserver\n")
            let config: [String: String] = [
                "mode": "frozen",
                "runtimeDirectory": "runtime",
                "nodePath": "node/node",
                "dshEntryPath": "lib/bin.js",
                "dshHome": recordedHome.path,
                "patchPath": "frozen-loopback.patch.yml",
                "sourceRevision": "test-source-rev",
                "lockfileDigest": String(repeating: "ab", count: 32),
                "inventoryFile": "runtime-inventory.json",
            ]
            let data = try! JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys])
            try! (data + Data("\n".utf8)).write(to: resources.appendingPathComponent("frozen-launcher-config.json"))
            seal()
        }

        var resolved: FrozenLauncherConfig.Resolved {
            guard case let .success(resolved) = FrozenLauncherConfig.load(from: resources) else {
                fatalError("fixture configuration must load")
            }
            return resolved
        }

        func write(_ relative: String, _ content: String, mode: Int = 0o644) {
            let url = resources.appendingPathComponent(relative)
            try! FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try! content.data(using: .utf8)!.write(to: url)
            try! FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: url.path)
        }

        func remove(_ relative: String) {
            try! FileManager.default.removeItem(at: resources.appendingPathComponent(relative))
        }

        /// Re-seals the current file set (used by the valid-payload case).
        func seal() {
            var files: [[String: Any]] = []
            collect("", &files)
            files.sort { ($0["path"] as! String) < ($1["path"] as! String) }
            let inventory: [String: Any] = ["version": 1, "algorithm": "sha256", "files": files]
            let data = try! JSONSerialization.data(withJSONObject: inventory, options: [.prettyPrinted, .sortedKeys])
            try! (data + Data("\n".utf8)).write(to: resources.appendingPathComponent("runtime-inventory.json"))
        }

        private func collect(_ directory: String, _ files: inout [[String: Any]]) {
            let directoryURL = directory.isEmpty
                ? resources
                : resources.appendingPathComponent(directory, isDirectory: true)
            for child in (try! FileManager.default.contentsOfDirectory(atPath: directoryURL.path)).sorted() {
                let relative = directory.isEmpty ? child : "\(directory)/\(child)"
                if relative == "runtime-inventory.json" { continue }
                let url = resources.appendingPathComponent(relative)
                var isDirectory: ObjCBool = false
                FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)
                if isDirectory.boolValue {
                    collect(relative, &files)
                    continue
                }
                // The sealer only seals regular files; special files (the
                // fifo fixture) are left out, and the validator refuses them.
                let type = (try? FileManager.default.attributesOfItem(atPath: url.path)[.type]) as? FileAttributeType
                guard type == .typeRegular else { continue }
                let data = try! Data(contentsOf: url)
                let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                let permissions = (try! FileManager.default.attributesOfItem(atPath: url.path))[.posixPermissions] as! Int
                files.append([
                    "path": relative,
                    "sha256": digest,
                    "size": data.count,
                    "mode": String(permissions, radix: 8),
                ])
            }
        }

        func cleanup() {
            TempDir.remove(root)
        }

        /// Writes one inventory entry by hand (schema-rejection fixtures).
        func writeInventoryEntry(path: String, sha256: String, size: Int) {
            writeInventoryEntries([[
                "path": path,
                "sha256": sha256,
                "size": size,
                "mode": "644",
            ]])
        }

        /// Replaces the inventory with the given raw entries.
        func writeInventoryEntries(_ files: [[String: Any]]) {
            let inventory: [String: Any] = ["version": 1, "algorithm": "sha256", "files": files]
            let data = try! JSONSerialization.data(withJSONObject: inventory)
            try! (data + Data("\n".utf8)).write(to: resources.appendingPathComponent("runtime-inventory.json"))
        }
    }

    // MARK: Controller gating

    /// Gates an injected validator so a test can hold a validation open,
    /// stop the controller underneath it, and then deliver the late result.
    private final class ValidationGate: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<Result<Void, RuntimeIntegrityValidator.IntegrityError>, Never>?
        let entered = DispatchSemaphore(value: 0)

        var validator: BackendController.IntegrityValidator {
            { [entered] _ in
                entered.signal()
                return await withCheckedContinuation { continuation in
                    self.lock.lock()
                    self.continuation = continuation
                    self.lock.unlock()
                }
            }
        }

        func resume(_ result: Result<Void, RuntimeIntegrityValidator.IntegrityError>) {
            lock.lock()
            let pending = continuation
            continuation = nil
            lock.unlock()
            pending?.resume(returning: result)
        }
    }

    /// Builds a frozen launch whose node/entry/patch all point at fixture
    /// files; the recorded home must exist because the controller still runs
    /// its cheap configuration checks.
    private func makeFrozenResolved(
        fixtureRoot: URL, entry: URL, patch: URL, home: URL
    ) -> FrozenLauncherConfig.Resolved {
        let resources = fixtureRoot.appendingPathComponent("Resources", isDirectory: true)
        try! FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        let config = FrozenLauncherConfig(
            mode: "frozen",
            runtimeDirectory: "runtime",
            nodePath: "node/node",
            dshEntryPath: entry.path,
            dshHome: home.path,
            patchPath: patch.path,
            sourceRevision: "test-source-rev",
            lockfileDigest: String(repeating: "ab", count: 32),
            inventoryFile: "runtime-inventory.json")
        return FrozenLauncherConfig.Resolved(
            config: config,
            resourcesDirectory: resources,
            runtimeDirectory: fixtureRoot.appendingPathComponent("runtime", isDirectory: true),
            nodeURL: entry,
            dshEntryURL: entry,
            patchURL: patch,
            inventoryURL: resources.appendingPathComponent("runtime-inventory.json"),
            dshHomeURL: home)
    }

    private func controllerGatesSpawnOnIntegrity(_ t: TestRunner) {
        let root = TempDir.make("frozen-gate")
        defer { TempDir.remove(root) }
        let home = root.appendingPathComponent("trial-home", isDirectory: true)
        try! FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let entry = Fixtures.fixtureEntry(in: root, mode: "ready")
        Fixtures.readinessLine(for: entry, Fixtures.authenticatedURL(port: 0, token: "tok-gate"))
        let patch = root.appendingPathComponent("patch.yml")
        try! Data("- id: webserver\n".utf8).write(to: patch)
        let log = try! DiagnosticLog(url: root.appendingPathComponent("launcher.log"))
        let resolved = makeFrozenResolved(fixtureRoot: root, entry: entry, patch: patch, home: home)

        let controller = BackendController(
            frozen: resolved,
            diagnosticLog: log,
            probe: nil,
            workingDirectory: home,
            integrityValidator: { _ in .failure(.hashMismatch("runtime/lib/bin.js")) },
            onPhaseChange: { _ in })
        controller.start()
        waitFor(controller, { if case .failed = $0 { return true } else { return false } },
                timeout: 10, t, "the failed integrity validation reaches the failed phase")
        if case let .failed(message) = controller.phase {
            t.check(message.contains("runtime/lib/bin.js"), "the failure names the rejected file")
        } else {
            t.check(false, "the failure names the rejected file")
        }
        t.check(controller.authenticatedURL == nil, "a rejected payload never opens a URL")
        let stopped = DispatchSemaphore(value: 0)
        controller.stop { stopped.signal() }
        t.check(t.drainUntil(stopped, timeout: 10), "stop after a failed validation completes")
    }

    private func controllerDiscardsStaleValidationAndStopsCleanly(_ t: TestRunner) {
        let root = TempDir.make("frozen-stale")
        defer { TempDir.remove(root) }
        let home = root.appendingPathComponent("trial-home", isDirectory: true)
        try! FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let entry = Fixtures.fixtureEntry(in: root, mode: "ready")
        Fixtures.readinessLine(for: entry, Fixtures.authenticatedURL(port: 0, token: "tok-stale"))
        let patch = root.appendingPathComponent("patch.yml")
        try! Data("- id: webserver\n".utf8).write(to: patch)
        let log = try! DiagnosticLog(url: root.appendingPathComponent("launcher.log"))
        let resolved = makeFrozenResolved(fixtureRoot: root, entry: entry, patch: patch, home: home)
        let gate = ValidationGate()

        let controller = BackendController(
            frozen: resolved,
            diagnosticLog: log,
            probe: nil,
            workingDirectory: home,
            integrityValidator: gate.validator,
            onPhaseChange: { _ in })
        controller.start()
        t.check(t.drainUntil(gate.entered, timeout: 10), "the injected validator runs")
        t.check(controller.phase == .validating, "the UI shows the validating phase while the scan runs")

        let stopped = DispatchSemaphore(value: 0)
        controller.stop { stopped.signal() }
        t.check(t.drainUntil(stopped, timeout: 10), "stopping during a validation completes teardown without a child")
        t.check(controller.phase == .idle, "the stopped controller is idle")

        // The late success belongs to a torn-down launch: it must never spawn.
        gate.resume(.success(()))
        let settled = DispatchSemaphore(value: 0)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { settled.signal() }
        t.check(t.drainUntil(settled, timeout: 5), "the late result settles")
        t.check(controller.phase == .idle, "a stale validation success never spawns")
        t.check(controller.authenticatedURL == nil, "a stale validation success never opens a URL")
    }

    private func frozenChildUsesRecordedHomeAndScrubbedEnvironment(_ t: TestRunner) {
        let root = TempDir.make("frozen-child")
        defer { TempDir.remove(root) }
        let home = root.appendingPathComponent("trial-home", isDirectory: true)
        try! FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let entry = Fixtures.fixtureEntry(in: root, mode: "frozen-env-dump")
        Fixtures.readinessLine(for: entry, Fixtures.authenticatedURL(port: 0, token: "tok-frozen-env"))
        let patch = root.appendingPathComponent("patch.yml")
        try! Data("- id: webserver\n".utf8).write(to: patch)
        let log = try! DiagnosticLog(url: root.appendingPathComponent("launcher.log"))
        let resolved = makeFrozenResolved(fixtureRoot: root, entry: entry, patch: patch, home: home)
        let hostile: [String: String] = [
            "HOME": "/Users/tester",
            "DSH_HOME": "/Users/tester/.dsh",
            "NODE_OPTIONS": "--require /tmp/evil.js",
            "DYLD_FALLBACK_LIBRARY_PATH": "/tmp/injected",
            "DEEPSEEK_API_KEY": "sk-test",
            "PATH": "/usr/bin:/bin",
        ]

        let controller = BackendController(
            frozen: resolved,
            diagnosticLog: log,
            probe: nil,
            workingDirectory: home,
            integrityValidator: { _ in .success(()) },
            environmentSource: hostile,
            onPhaseChange: { _ in })
        controller.start()
        waitFor(controller, { $0 == .running }, timeout: 15, t, "the frozen fixture child reaches running")

        let envFile = URL(fileURLWithPath: entry.path + ".env")
        let envData = (try? String(contentsOf: envFile, encoding: .utf8)) ?? ""
        let lines = Dictionary(uniqueKeysWithValues: envData.split(separator: "\n").map { line -> (String, String) in
            let parts = line.split(separator: "=", maxSplits: 1)
            return (String(parts[0]), parts.count > 1 ? String(parts[1]) : "")
        })
        t.check(lines["DSH_HOME"] == home.path, "the child uses the recorded data home, not an inherited one")
        t.check(lines["HOME"] == "/Users/tester", "the child keeps UNIX HOME from the source environment")
        let cwdIdentity = try? FileManager.default.attributesOfItem(atPath: lines["PWD"] ?? "")[.systemFileNumber] as? NSNumber
        let homeIdentity = try! FileManager.default.attributesOfItem(atPath: home.path)[.systemFileNumber] as! NSNumber
        t.check(cwdIdentity == homeIdentity,
                "the frozen child starts in the trial home, not the ambient working directory")
        t.check(lines["NODE_OPTIONS"] == "", "the child sees no NODE_OPTIONS")
        t.check(lines["DYLD_FALLBACK"] == "", "the child sees no DYLD_* variables")
        t.check(lines["DEEPSEEK_API_KEY"] == "", "the child sees no secret-like variables")

        let stopped = DispatchSemaphore(value: 0)
        controller.stop { stopped.signal() }
        t.check(t.drainUntil(stopped, timeout: 30), "the frozen fixture child is torn down")
    }

    private func validateAndWait(
        _ fixture: Fixture, _ t: TestRunner
    ) -> Result<Void, RuntimeIntegrityValidator.IntegrityError> {
        let done = DispatchSemaphore(value: 0)
        var outcome: Result<Void, RuntimeIntegrityValidator.IntegrityError>!
        let resources = fixture.resources
        Task.detached {
            outcome = await RuntimeIntegrityValidator.validate(resourcesDirectory: resources)
            done.signal()
        }
        t.check(t.drainUntil(done, timeout: 30), "the integrity validation completes")
        return outcome
    }

    /// Bounded wait on the run loop; the phase check itself is instantaneous.
    @discardableResult
    private func waitFor(
        _ controller: BackendController,
        _ predicate: (BackendController.Phase) -> Bool,
        timeout: TimeInterval,
        _ t: TestRunner,
        _ label: String
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            if predicate(controller.phase) { return true }
            if Date() >= deadline {
                t.check(false, label)
                return false
            }
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }
    }

    // MARK: Configuration

    private func configLoading(_ t: TestRunner) {
        let fixture = Fixture("frozen-config")
        defer { fixture.cleanup() }
        let resolved = fixture.resolved
        t.check(resolved.nodeURL == fixture.resources.appendingPathComponent("node/node"),
                "the Node path resolves inside the bundle")
        t.check(resolved.dshEntryURL == fixture.resources.appendingPathComponent("runtime/lib/bin.js"),
                "the entry path resolves under the runtime directory")
        t.check(resolved.dshHomeURL.path == fixture.recordedHome.path,
                "the recorded data home is kept verbatim")
        t.check(resolved.config.sourceRevision == "test-source-rev", "the source revision is recorded verbatim")
    }

    private func configValidation(_ t: TestRunner) {
        let fixture = Fixture("frozen-config-validation")
        defer { fixture.cleanup() }
        if case .success = fixture.resolved.config.validate(resolved: fixture.resolved) {
            t.check(true, "a valid fixture configuration validates")
        } else {
            t.check(false, "a valid fixture configuration validates")
        }

        // The recorded data home must exist as a real directory; the launcher
        // never creates it and never follows a symlink to another location.
        let missingHome = resolved(withHome: fixture, fixture.root.appendingPathComponent("absent-home"))
        if case .failure = missingHome.config.validate(resolved: missingHome) {
            t.check(true, "a missing recorded home is refused")
        } else {
            t.check(false, "a missing recorded home is refused")
        }

        let linkTarget = fixture.root.appendingPathComponent("link-target", isDirectory: true)
        try! FileManager.default.createDirectory(at: linkTarget, withIntermediateDirectories: true)
        let link = fixture.root.appendingPathComponent("home-link")
        try! FileManager.default.createSymbolicLink(at: link, withDestinationURL: linkTarget)
        let linked = resolved(withHome: fixture, link)
        if case .failure = linked.config.validate(resolved: linked) {
            t.check(true, "a symlinked recorded home is refused")
        } else {
            t.check(false, "a symlinked recorded home is refused")
        }
    }

    private func resolved(withHome fixture: Fixture, _ home: URL) -> FrozenLauncherConfig.Resolved {
        var config = fixture.resolved.config
        config = FrozenLauncherConfig(
            mode: config.mode,
            runtimeDirectory: config.runtimeDirectory,
            nodePath: config.nodePath,
            dshEntryPath: config.dshEntryPath,
            dshHome: home.path,
            patchPath: config.patchPath,
            sourceRevision: config.sourceRevision,
            lockfileDigest: config.lockfileDigest,
            inventoryFile: config.inventoryFile)
        return FrozenLauncherConfig.Resolved(
            config: config,
            resourcesDirectory: fixture.resolved.resourcesDirectory,
            runtimeDirectory: fixture.resolved.runtimeDirectory,
            nodeURL: fixture.resolved.nodeURL,
            dshEntryURL: fixture.resolved.dshEntryURL,
            patchURL: fixture.resolved.patchURL,
            inventoryURL: fixture.resolved.inventoryURL,
            dshHomeURL: home)
    }

    // MARK: Environment and arguments

    private func environmentSelection(_ t: TestRunner) {
        let recorded = "/tmp/frozen-launch-tests-trial-home"
        let environment = FrozenEnvironment.childEnvironment(
            dshHome: recorded,
            source: [
                "HOME": "/Users/tester",
                "PATH": "/usr/bin:/bin",
                "TMPDIR": "/tmp/x",
                "USER": "tester",
                "LANG": "en_US.UTF-8",
                "DSH_HOME": "/Users/tester/.dsh",
                "NODE_OPTIONS": "--require /tmp/evil.js",
                "NODE_PATH": "/tmp/injected",
                "DYLD_LIBRARY_PATH": "/tmp/injected",
                "DYLD_FALLBACK_LIBRARY_PATH": "/tmp/injected2",
                "DEEPSEEK_API_KEY": "sk-test",
                "AWS_SECRET_ACCESS_KEY": "s",
                "SESSION_TOKEN": "t",
                "DB_PASSWORD": "p",
            ])
        t.check(environment["DSH_HOME"] == recorded, "the recorded data home wins over an inherited DSH_HOME")
        t.check(environment["HOME"] == "/Users/tester", "UNIX HOME is preserved")
        t.check(environment["PATH"] == "/usr/bin:/bin", "PATH is preserved")
        t.check(environment["TMPDIR"] == "/tmp/x", "TMPDIR is preserved")
        t.check(environment["USER"] == "tester", "USER is preserved")
        t.check(environment["LANG"] == "en_US.UTF-8", "locale context is preserved")
        t.check(environment["NODE_OPTIONS"] == nil, "NODE_OPTIONS is removed")
        t.check(environment["NODE_PATH"] == nil, "NODE_PATH is removed")
        t.check(environment["DYLD_LIBRARY_PATH"] == nil, "DYLD_LIBRARY_PATH is removed")
        t.check(environment["DYLD_FALLBACK_LIBRARY_PATH"] == nil, "all DYLD_* variables are removed")
        t.check(environment["DEEPSEEK_API_KEY"] == nil, "secret-like names are removed (KEY)")
        t.check(environment["AWS_SECRET_ACCESS_KEY"] == nil, "secret-like names are removed (SECRET)")
        t.check(environment["SESSION_TOKEN"] == nil, "secret-like names are removed (TOKEN)")
        t.check(environment["DB_PASSWORD"] == nil, "secret-like names are removed (PASSWORD)")
    }

    private func launchArguments(_ t: TestRunner) {
        let arguments = BackendController.frozenLaunchArguments(
            dshEntryPath: "/bundle/Contents/Resources/runtime/lib/bin.js",
            patchPath: "/bundle/Contents/Resources/frozen-loopback.patch.yml")
        t.check(arguments == [
            "/bundle/Contents/Resources/runtime/lib/bin.js",
            "web",
            "--patch",
            "/bundle/Contents/Resources/frozen-loopback.patch.yml",
            "--no-open",
        ], "the bundled overlay travels through the normal dsh web arguments")
    }

    // MARK: Integrity validation

    private func integrityAcceptsSealedPayload(_ t: TestRunner) {
        let fixture = Fixture("integrity-ok")
        defer { fixture.cleanup() }
        let result = validateAndWait(fixture, t)
        if case .success = result {
            t.check(true, "a sealed payload validates")
        } else {
            t.check(false, "a sealed payload validates; observed \(result)")
        }
    }

    private func integrityRejectsTamperedPayload(_ t: TestRunner) {
        let tampered = Fixture("integrity-tampered")
        defer { tampered.cleanup() }
        tampered.write("runtime/lib/bin.js", "#!/bin/sh\nexit 1\n")
        if case let .failure(error) = validateAndWait(tampered, t), case .hashMismatch = error {
            t.check(true, "a tampered file fails its digest")
        } else {
            t.check(false, "a tampered file fails its digest")
        }

        let resized = Fixture("integrity-size")
        defer { resized.cleanup() }
        // A size-only mismatch is tested by corrupting the recorded size: with
        // real hashing, any byte change also changes the digest.
        let inventoryURL = resized.resources.appendingPathComponent("runtime-inventory.json")
        var inventory = try! JSONSerialization.jsonObject(with: Data(contentsOf: inventoryURL)) as! [String: Any]
        var files = inventory["files"] as! [[String: Any]]
        files[0]["size"] = (files[0]["size"] as! Int) + 1
        inventory["files"] = files
        try! JSONSerialization.data(withJSONObject: inventory).write(to: inventoryURL)
        if case let .failure(error) = validateAndWait(resized, t), case .sizeMismatch = error {
            t.check(true, "a size mismatch is reported independently of the digest")
        } else {
            t.check(false, "a size mismatch is reported independently of the digest")
        }
    }

    private func integrityRejectsMissingAndExtraFiles(_ t: TestRunner) {
        let missing = Fixture("integrity-missing")
        defer { missing.cleanup() }
        missing.remove("runtime/lib/bin.js")
        if case let .failure(error) = validateAndWait(missing, t), case let .missingFile(path) = error,
           path == "runtime/lib/bin.js" {
            t.check(true, "a missing payload file is reported by path")
        } else {
            t.check(false, "a missing payload file is reported by path")
        }

        let extra = Fixture("integrity-extra")
        defer { extra.cleanup() }
        extra.write("runtime/extra.txt", "unsigned")
        if case let .failure(error) = validateAndWait(extra, t), case let .extraFile(path) = error,
           path == "runtime/extra.txt" {
            t.check(true, "an unsigned extra file is reported by path")
        } else {
            t.check(false, "an unsigned extra file is reported by path")
        }
    }

    private func integrityRejectsLinkShapedAndSpecialPayload(_ t: TestRunner) {
        let linked = Fixture("integrity-links")
        defer { linked.cleanup() }
        linked.remove("runtime/lib/bin.js")
        try! FileManager.default.createSymbolicLink(
            at: linked.resources.appendingPathComponent("runtime/lib/bin.js"),
            withDestinationURL: linked.resources.appendingPathComponent("node/node"))
        if case let .failure(error) = validateAndWait(linked, t), case .symlink = error {
            t.check(true, "an in-bundle symlink payload is refused")
        } else {
            t.check(false, "an in-bundle symlink payload is refused")
        }

        let escaping = Fixture("integrity-escaping-link")
        defer { escaping.cleanup() }
        escaping.remove("runtime/lib/bin.js")
        try! FileManager.default.createSymbolicLink(
            at: escaping.resources.appendingPathComponent("runtime/lib/bin.js"),
            withDestinationURL: escaping.recordedHome)
        if case let .failure(error) = validateAndWait(escaping, t), case .symlink = error {
            t.check(true, "an escaping symlink payload is refused")
        } else {
            t.check(false, "an escaping symlink payload is refused")
        }

        let hardlinked = Fixture("integrity-hardlink")
        defer { hardlinked.cleanup() }
        let outside = hardlinked.root.appendingPathComponent("outside.txt")
        try! "outside".data(using: .utf8)!.write(to: outside)
        hardlinked.remove("runtime/lib/bin.js")
        let linkedPath = hardlinked.resources.appendingPathComponent("runtime/lib/bin.js").path
        t.check(link(outside.path, linkedPath) == 0, "the test creates the hardlink fixture")
        if case let .failure(error) = validateAndWait(hardlinked, t), case let .hardlinked(_, nlink) = error, nlink == 2 {
            t.check(true, "a hardlinked payload file (nlink 2) is refused")
        } else {
            t.check(false, "a hardlinked payload file (nlink 2) is refused")
        }

        let special = Fixture("integrity-special")
        defer { special.cleanup() }
        let fifoPath = special.resources.appendingPathComponent("runtime/fifo").path
        t.check(mkfifo(fifoPath, 0o644) == 0, "the test creates the fifo fixture")
        special.seal()
        if case let .failure(error) = validateAndWait(special, t), case .specialFile = error {
            t.check(true, "a special file in the payload is refused")
        } else {
            t.check(false, "a special file in the payload is refused")
        }
    }

    private func integrityRejectsInvalidInventory(_ t: TestRunner) {
        let none = Fixture("integrity-no-inventory")
        defer { none.cleanup() }
        none.remove("runtime-inventory.json")
        if case let .failure(error) = validateAndWait(none, t), case .inventoryMissing = error {
            t.check(true, "a bundle without an inventory is refused")
        } else {
            t.check(false, "a bundle without an inventory is refused")
        }

        let malformed = Fixture("integrity-bad-inventory")
        defer { malformed.cleanup() }
        try! Data("not json".utf8).write(to: malformed.resources.appendingPathComponent("runtime-inventory.json"))
        if case let .failure(error) = validateAndWait(malformed, t), case .inventoryMalformed = error {
            t.check(true, "a malformed inventory is refused")
        } else {
            t.check(false, "a malformed inventory is refused")
        }

        let escaping = Fixture("integrity-escaping-path")
        defer { escaping.cleanup() }
        escaping.writeInventoryEntry(path: "../escape", sha256: String(repeating: "0", count: 64), size: 0)
        if case let .failure(error) = validateAndWait(escaping, t), case .inventoryMalformed = error {
            t.check(true, "an escaping inventory path is refused")
        } else {
            t.check(false, "an escaping inventory path is refused")
        }

        let absolute = Fixture("integrity-absolute-path")
        defer { absolute.cleanup() }
        absolute.writeInventoryEntry(path: "/etc/passwd", sha256: String(repeating: "0", count: 64), size: 0)
        if case let .failure(error) = validateAndWait(absolute, t), case .inventoryMalformed = error {
            t.check(true, "an absolute inventory path is refused")
        } else {
            t.check(false, "an absolute inventory path is refused")
        }

        let duplicate = Fixture("integrity-duplicate")
        defer { duplicate.cleanup() }
        let entry: [String: Any] = [
            "path": "runtime/lib/bin.js",
            "sha256": String(repeating: "0", count: 64),
            "size": 0,
            "mode": "644",
        ]
        duplicate.writeInventoryEntries([entry, entry])
        if case let .failure(error) = validateAndWait(duplicate, t), case .inventoryMalformed = error {
            t.check(true, "a duplicate inventory path is refused")
        } else {
            t.check(false, "a duplicate inventory path is refused")
        }
    }

    private func integrityRejectsMetadataAndPermissionChanges(_ t: TestRunner) {
        let mode = Fixture("integrity-mode")
        defer { mode.cleanup() }
        try! FileManager.default.setAttributes([.posixPermissions: 0o600],
            ofItemAtPath: mode.resources.appendingPathComponent("runtime/lib/bin.js").path)
        if case .failure(.modeMismatch) = validateAndWait(mode, t) {
            t.check(true, "changed payload permission bits are refused")
        } else { t.check(false, "changed payload permission bits are refused") }

        let fifo = Fixture("inventory-fifo")
        defer { fifo.cleanup() }
        fifo.remove("runtime-inventory.json")
        t.check(mkfifo(fifo.resources.appendingPathComponent("runtime-inventory.json").path, 0o600) == 0,
                "the inventory FIFO fixture exists")
        if case .failure(.specialFile) = validateAndWait(fifo, t) {
            t.check(true, "an inventory FIFO is refused without waiting for a writer")
        } else { t.check(false, "an inventory FIFO is refused without waiting for a writer") }

        let rootLink = Fixture("resources-link")
        defer { rootLink.cleanup() }
        let moved = rootLink.root.appendingPathComponent("actual-resources")
        try! FileManager.default.moveItem(at: rootLink.resources, to: moved)
        try! FileManager.default.createSymbolicLink(at: rootLink.resources, withDestinationURL: moved)
        if case .failure(.symlink) = validateAndWait(rootLink, t) {
            t.check(true, "a symlink Resources root is refused")
        } else { t.check(false, "a symlink Resources root is refused") }

        let config = Fixture("config-fifo")
        defer { config.cleanup() }
        config.remove("frozen-launcher-config.json")
        t.check(mkfifo(config.resources.appendingPathComponent("frozen-launcher-config.json").path, 0o600) == 0,
                "the configuration FIFO fixture exists")
        if case .failure = FrozenLauncherConfig.load(from: config.resources) {
            t.check(true, "a configuration FIFO is refused without blocking the UI")
        } else { t.check(false, "a configuration FIFO is refused without blocking the UI") }

        let bounded = Fixture("bounded-config")
        defer { bounded.cleanup() }
        bounded.write("frozen-launcher-config.json", String(repeating: " ", count: 64 * 1024 + 1))
        if case .failure = FrozenLauncherConfig.load(from: bounded.resources) {
            t.check(true, "oversized configuration is refused")
        } else { t.check(false, "oversized configuration is refused") }

        let readerFile = bounded.root.appendingPathComponent("reader.txt")
        try! Data("1234".utf8).write(to: readerFile)
        t.check(FrozenFileReader.read(readerFile, maximumBytes: 4) == Data("1234".utf8),
                "bounded metadata reads accept the exact size limit")
        t.check(FrozenFileReader.read(readerFile, maximumBytes: 3) == nil,
                "bounded metadata reads refuse larger regular files")
    }
}
