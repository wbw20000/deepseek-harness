import Foundation
@testable import LauncherCore

/// Selection tests cover the record-only loading rules: valid selection,
/// corrupt/unsupported schema, traversal, symlink and hardlink metadata,
/// digest mismatch, missing bundle parts, and missing data home. No GUI, no
/// backend launch, no fault injection into production code paths.
@MainActor
struct RecoverySelectionTests {

    func run(_ runner: RecoveryTestRunner) {
        validSelection(runner)
        corruptAndUnsupportedRecords(runner)
        boundedAndLinkedRecords(runner)
        traversalAndSymlinkedApp(runner)
        digestMismatch(runner)
        missingBundlePartsAndData(runner)
        sealedInstallation(runner)
        largeInventoryMetadata(runner)
        dataHomeContainment(runner)
    }

    private func load(_ bundle: RecoveryFixture.Bundle) -> Result<RecoverySelection.Verified, RecoverySelection.SelectionError> {
        RecoverySelection.load(recordURL: bundle.recordURL, installationRoot: bundle.installationRoot)
    }

    private func validSelection(_ runner: RecoveryTestRunner) {
        let bundle = RecoveryFixture.make("valid")
        defer { TempDir.remove(bundle.installationRoot) }
        switch load(bundle) {
        case let .failure(error):
            runner.check(false, "valid selection succeeds (got \(error))")
        case let .success(verified):
            runner.check(verified.appURL == bundle.appURL, "verified app is the recorded bundle")
            runner.check(verified.resourcesDirectory == bundle.resourcesDirectory, "resources resolve inside the bundle")
            runner.check(verified.launch.dshHomeURL == bundle.dshHome, "launch is bound to the recorded data home")
            runner.check(verified.launch.dshHomeURL.path.hasPrefix(bundle.installationRoot.path + "/"),
                         "the data home lives inside the managed installation")
            runner.check(verified.launch.config.mode == "frozen", "frozen validator accepted the configuration")
            runner.check(verified.installationRoot == bundle.installationRoot, "installation root is carried through")
        }
    }

    private func corruptAndUnsupportedRecords(_ runner: RecoveryTestRunner) {
        let bundle = RecoveryFixture.make("corrupt")
        defer { TempDir.remove(bundle.installationRoot) }

        try! Data("not json".utf8).write(to: bundle.recordURL)
        if case let .failure(error) = load(bundle), isMalformed(error) {
            runner.check(true, "invalid JSON reports malformed")
        } else {
            runner.check(false, "invalid JSON is rejected")
        }

        RecoveryFixture.writeRecord(for: bundle, schema: "deepseek-harness.recovery.last-good/2")
        if case let .failure(error) = load(bundle), case .unsupportedSchema = error {
            runner.check(true, "newer schema is unsupported")
        } else {
            runner.check(false, "newer schema is rejected")
        }

        RecoveryFixture.writeRecord(for: bundle, schema: "")
        if case let .failure(error) = load(bundle), case .unsupportedSchema = error {
            runner.check(true, "empty schema is unsupported")
        } else {
            runner.check(false, "empty schema is rejected")
        }

        RecoveryFixture.writeRecord(for: bundle, configDigest: String(repeating: "z", count: 64))
        if case let .failure(error) = load(bundle), case .invalid = error {
            runner.check(true, "non-hex digest is invalid")
        } else {
            runner.check(false, "non-hex digest is rejected")
        }
    }

    private func isMalformed(_ error: RecoverySelection.SelectionError) -> Bool {
        if case .malformed = error { return true }
        return false
    }

    /// The bounded read rules come from `FrozenFileReader`: over-size,
    /// multiple links, and non-regular files are one reported condition, and
    /// nothing is read from them.
    private func boundedAndLinkedRecords(_ runner: RecoveryTestRunner) {
        let bundle = RecoveryFixture.make("bounded")
        defer { TempDir.remove(bundle.installationRoot) }

        let oversized = Data(repeating: 0x61, count: RecoverySelection.maximumRecordBytes + 1)
        try! oversized.write(to: bundle.recordURL)
        if case let .failure(error) = load(bundle), error == .missingRecord {
            runner.check(true, "over-size record is refused")
        } else {
            runner.check(false, "over-size record is refused")
        }

        try! Data("{}".utf8).write(to: bundle.recordURL)
        let hardlink = bundle.installationRoot.appendingPathComponent("hardlinked-record.json")
        try? FileManager.default.linkItem(at: bundle.recordURL, to: hardlink)
        if case let .failure(error) = load(bundle), error == .missingRecord {
            runner.check(true, "hardlinked record (nlink > 1) is refused")
        } else {
            runner.check(false, "hardlinked record is refused")
        }
        try? FileManager.default.removeItem(at: hardlink)

        // A FIFO record would block a naive reader; the nonblocking open
        // refuses it without waiting for a writer.
        try? FileManager.default.removeItem(at: bundle.recordURL)
        let fifoResult = mkfifo(bundle.recordURL.path, 0o600)
        runner.check(fifoResult == 0, "fixture fifo created")
        if case let .failure(error) = load(bundle), error == .missingRecord {
            runner.check(true, "fifo record is refused without blocking")
        } else {
            runner.check(false, "fifo record is refused")
        }
        try? FileManager.default.removeItem(at: bundle.recordURL)
    }

    private func traversalAndSymlinkedApp(_ runner: RecoveryTestRunner) {
        let bundle = RecoveryFixture.make("traversal")
        defer { TempDir.remove(bundle.installationRoot) }

        RecoveryFixture.writeRecord(for: bundle, appPath: bundle.installationRoot.path + "/../outside.app")
        if case let .failure(error) = load(bundle), case .outsideInstallation = error {
            runner.check(true, "`..` traversal is outside the installation")
        } else {
            runner.check(false, "`..` traversal is rejected")
        }

        RecoveryFixture.writeRecord(for: bundle, appPath: bundle.installationRoot.path + "/nested/Linked.app")
        if case let .failure(error) = load(bundle), case .outsideInstallation = error {
            runner.check(true, "nested bundle path is rejected (direct child only)")
        } else {
            runner.check(false, "nested bundle path is rejected")
        }

        // A symlink inside the installation pointing at a bundle outside it
        // must not be accepted as the recorded location.
        let outsideRoot = TempDir.make("outside-root")
        defer { TempDir.remove(outsideRoot) }
        let outsideApp = outsideRoot.appendingPathComponent("Linked.app", isDirectory: true)
        try! FileManager.default.createDirectory(at: outsideApp.appendingPathComponent("Contents/Resources"),
                                                withIntermediateDirectories: true)
        let linked = bundle.installationRoot.appendingPathComponent("Linked.app")
        try? FileManager.default.createSymbolicLink(at: linked, withDestinationURL: outsideApp)
        RecoveryFixture.writeRecord(for: bundle, appPath: linked.path)
        if case let .failure(error) = load(bundle), case .outsideInstallation = error {
            runner.check(true, "symlinked bundle escaping the installation is rejected")
        } else {
            runner.check(false, "symlinked bundle escaping the installation is rejected")
        }
    }

    private func digestMismatch(_ runner: RecoveryTestRunner) {
        let bundle = RecoveryFixture.make("mismatch")
        defer { TempDir.remove(bundle.installationRoot) }

        let configURL = bundle.resourcesDirectory.appendingPathComponent("frozen-launcher-config.json")
        try! Data("{\"mode\":\"frozen\"}".utf8).write(to: configURL)
        if case let .failure(error) = load(bundle), error == .hashMismatch("frozen-launcher-config.json") {
            runner.check(true, "tampered frozen config fails its digest")
        } else {
            runner.check(false, "tampered frozen config is rejected")
        }

        RecoveryFixture.writeRecord(for: bundle)
        let inventoryURL = bundle.resourcesDirectory.appendingPathComponent("runtime-inventory.json")
        try! Data("{\"version\":2}".utf8).write(to: inventoryURL)
        if case let .failure(error) = load(bundle), error == .hashMismatch("runtime-inventory.json") {
            runner.check(true, "tampered inventory fails its digest")
        } else {
            runner.check(false, "tampered inventory is rejected")
        }
    }

    private func missingBundlePartsAndData(_ runner: RecoveryTestRunner) {
        let bundle = RecoveryFixture.make("missing")
        defer { TempDir.remove(bundle.installationRoot) }

        try? FileManager.default.removeItem(at: bundle.resourcesDirectory.appendingPathComponent("payload-node"))
        if case let .failure(error) = load(bundle), case .invalid = error {
            runner.check(true, "missing bundled Node is reported")
        } else {
            runner.check(false, "missing bundled Node is rejected")
        }

        let fresh = RecoveryFixture.make("missing-data")
        defer { TempDir.remove(fresh.installationRoot) }
        try? FileManager.default.removeItem(at: fresh.dshHome)
        if case let .failure(error) = load(fresh), case .invalid = error {
            runner.check(true, "missing data home is reported")
        } else {
            runner.check(false, "missing data home is rejected")
        }

        let noResources = RecoveryFixture.make("missing-resources")
        defer { TempDir.remove(noResources.installationRoot) }
        try? FileManager.default.removeItem(at: noResources.resourcesDirectory)
        if case let .failure(error) = load(noResources), case .missingPath = error {
            runner.check(true, "missing Resources directory is reported")
        } else {
            runner.check(false, "missing Resources directory is rejected")
        }
    }

    private func sealedInstallation(_ runner: RecoveryTestRunner) {
        let bundle = RecoveryFixture.make("sealed")
        defer { TempDir.remove(bundle.installationRoot) }

        let sealedDir = TempDir.make("sealed-resources")
        defer { TempDir.remove(sealedDir) }
        let sealedURL = sealedDir.appendingPathComponent("recovery-installation.json")
        let sealed = """
        {"schema":"\(RecoverySelection.supportedInstallationSchema)","installationRoot":"\(bundle.installationRoot.path)"}
        """
        try! Data(sealed.utf8).write(to: sealedURL)
        switch RecoverySelection.loadSealedInstallation(from: sealedDir) {
        case let .success(root):
            runner.check(root == bundle.installationRoot, "sealed configuration resolves the installation root")
        case let .failure(error):
            runner.check(false, "sealed configuration loads (got \(error))")
        }

        try! Data(sealed.replacingOccurrences(of: "/1", with: "/2").utf8).write(to: sealedURL)
        if case let .failure(error) = RecoverySelection.loadSealedInstallation(from: sealedDir),
           case .unsupportedSchema = error {
            runner.check(true, "unsupported sealed schema is rejected")
        } else {
            runner.check(false, "unsupported sealed schema is rejected")
        }
    }

    /// The inventory is real payload metadata: a real frozen payload seals
    /// tens of thousands of files, so the selection read bound must exceed
    /// the 64 KiB config bound and match the validator's inventory bound.
    private func largeInventoryMetadata(_ runner: RecoveryTestRunner) {
        let bundle = RecoveryFixture.make("large-inventory")
        defer { TempDir.remove(bundle.installationRoot) }
        let entries = (0..<1500).map { index -> String in
            let digest = String(format: "%064x", index)
            return "{\"path\":\"runtime/lib/file-\(index).js\",\"sha256\":\"\(digest)\",\"size\":\(index),\"mode\":\"644\"}"
        }
        let inventory = "{\"version\":1,\"algorithm\":\"sha256\",\"files\":[\(entries.joined(separator: ","))]}"
        try! Data(inventory.utf8).write(
            to: bundle.resourcesDirectory.appendingPathComponent("runtime-inventory.json"))
        RecoveryFixture.writeRecord(for: bundle)
        switch load(bundle) {
        case .success:
            runner.check(true, "an inventory larger than 64 KiB is selected")
        case let .failure(error):
            runner.check(false, "an inventory larger than 64 KiB is selected (got \(error))")
        }

        let oversize = RecoveryFixture.make("oversize-inventory")
        defer { TempDir.remove(oversize.installationRoot) }
        let oversizeData = Data(repeating: 0x20, count: FrozenFileReader.maximumInventoryBytes + 1)
        try! oversizeData.write(
            to: oversize.resourcesDirectory.appendingPathComponent("runtime-inventory.json"))
        RecoveryFixture.writeRecord(for: oversize, inventoryDigest: String(repeating: "a", count: 64))
        switch load(oversize) {
        case let .failure(.missingPath(path)) where path.hasSuffix("runtime-inventory.json"):
            runner.check(true, "an inventory beyond 32 MiB is refused")
        case let .failure(error):
            runner.check(false, "an inventory beyond 32 MiB is refused (got \(error))")
        case .success:
            runner.check(false, "an inventory beyond 32 MiB is refused")
        }
    }

    /// The selected data home must be a real directory strictly inside the
    /// chosen managed installation, reached through checked components, and
    /// must never overlap the selected App. Nested release paths are valid
    /// only as explicit recorded paths with every component checked.
    private func dataHomeContainment(_ runner: RecoveryTestRunner) {
        let outside = RecoveryFixture.make("home-outside")
        defer { TempDir.remove(outside.installationRoot) }
        let strayHome = TempDir.make("home-outside-stray")
        defer { TempDir.remove(strayHome) }
        RecoveryFixture.setDshHome(outside, to: strayHome)
        if case let .failure(error) = load(outside), case .outsideInstallation = error {
            runner.check(true, "a data home outside the installation is refused")
        } else {
            runner.check(false, "a data home outside the installation is refused")
        }

        let ancestor = RecoveryFixture.make("home-ancestor")
        defer { TempDir.remove(ancestor.installationRoot) }
        RecoveryFixture.setDshHome(ancestor, to: ancestor.installationRoot)
        if case .failure = load(ancestor) {
            runner.check(true, "the installation root itself (an App ancestor) is refused")
        } else {
            runner.check(false, "the installation root itself (an App ancestor) is refused")
        }

        let insideApp = RecoveryFixture.make("home-inside-app")
        defer { TempDir.remove(insideApp.installationRoot) }
        let appData = insideApp.appURL.appendingPathComponent("Contents/data-home", isDirectory: true)
        try! FileManager.default.createDirectory(at: appData, withIntermediateDirectories: true)
        RecoveryFixture.setDshHome(insideApp, to: appData)
        if case let .failure(error) = load(insideApp), case .invalid = error {
            runner.check(true, "a data home inside the selected App is refused")
        } else {
            runner.check(false, "a data home inside the selected App is refused")
        }

        let traversal = RecoveryFixture.make("home-traversal")
        defer { TempDir.remove(traversal.installationRoot) }
        RecoveryFixture.setDshHome(traversal, to: URL(fileURLWithPath: traversal.dshHome.path + "/../elsewhere"))
        if case let .failure(error) = load(traversal), case .invalid = error {
            runner.check(true, "a `..` component in the recorded home is refused")
        } else {
            runner.check(false, "a `..` component in the recorded home is refused")
        }

        let linked = RecoveryFixture.make("home-link")
        defer { TempDir.remove(linked.installationRoot) }
        let linkDirectory = linked.installationRoot.appendingPathComponent("link")
        try! FileManager.default.createSymbolicLink(at: linkDirectory, withDestinationURL: linked.installationRoot)
        RecoveryFixture.setDshHome(linked, to: linkDirectory.appendingPathComponent("data-home", isDirectory: true))
        if case let .failure(error) = load(linked), case .unsafePath = error {
            runner.check(true, "a symlinked intermediate component is refused")
        } else {
            runner.check(false, "a symlinked intermediate component is refused")
        }

        let nested = RecoveryFixture.make("home-nested")
        defer { TempDir.remove(nested.installationRoot) }
        let releaseHome = nested.installationRoot.appendingPathComponent("releases/r7/data-home", isDirectory: true)
        try! FileManager.default.createDirectory(at: releaseHome, withIntermediateDirectories: true)
        RecoveryFixture.setDshHome(nested, to: releaseHome)
        switch load(nested) {
        case let .success(verified):
            runner.check(verified.launch.dshHomeURL == releaseHome,
                         "an explicit nested release path with checked components is accepted")
        case let .failure(error):
            runner.check(false, "an explicit nested release path with checked components is accepted (got \(error))")
        }
    }
}
