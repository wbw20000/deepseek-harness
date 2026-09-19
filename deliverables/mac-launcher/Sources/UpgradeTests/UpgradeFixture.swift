import CryptoKit
import Foundation
@testable import UpgradeTransaction

/// Builds private fixture installations in temporary directories: a managed
/// candidate trial root shaped like `dsh-managed-trial.<id>/` (frozen trial
/// App, Recovery entry Apps, data home, last-good record) and a production
/// installation (App bundle plus data home). All digests are the real
/// SHA-256 of the written fixture bytes, so the binding checks accept the
/// candidate exactly the way they would accept a built one. Fixtures are
/// clearly test-only: nothing here touches an installed App or a real data
/// directory.
enum UpgradeFixture {

    struct Installation {
        let root: URL
        let candidateRoot: URL
        let candidateApp: URL
        let identityURL: URL
        let trialRecordURL: URL
        let productionApp: URL
        let productionDataHome: URL
        let transactionDirectory: URL
        let sourceRevision: String
    }

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func sha256Hex(at url: URL) -> String? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return sha256Hex(data)
    }

    static func write(_ data: Data, to url: URL, executable: Bool = false) {
        try! FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try! data.write(to: url)
        if executable {
            try! FileManager.default.setAttributes(
                [.posixPermissions: 0o755], ofItemAtPath: url.path)
        }
    }

    static func write(_ json: String, to url: URL, executable: Bool = false) {
        write(Data(json.utf8), to: url, executable: executable)
    }

    /// Builds one complete candidate plus production installation pair inside
    /// `root`. The candidate's digests are computed from the written files, so
    /// identity, last-good record, and trial record agree by construction;
    /// tests then perturb exactly one input per rejection case.
    @discardableResult
    static func make(_ label: String, in root: URL) -> Installation {
        let candidateRoot = root.appendingPathComponent("dsh-managed-trial.fixture", isDirectory: true)
        let candidateApp = candidateRoot.appendingPathComponent(
            "DeepSeek Harness Frozen Trial.app", isDirectory: true)
        let resources = candidateApp.appendingPathComponent("Contents/Resources", isDirectory: true)
        let revision = "feed0001\(label.suffix(4))"
        let configJSON = """
        {
          "mode": "frozen",
          "runtimeDirectory": "runtime",
          "nodePath": "runtime/node",
          "dshEntryPath": "runtime/lib/bin.js",
          "dshHome": "\(candidateRoot.appendingPathComponent("data-home").path)",
          "patchPath": "runtime/overlay.yml",
          "sourceRevision": "\(revision)",
          "lockfileDigest": "0000000000000000000000000000000000000000000000000000000000000000",
          "inventoryFile": "runtime-inventory.json"
        }
        """
        let inventoryJSON = "{ \"fixture\": \"\(label)\", \"files\": [] }"
        write(Data(configJSON.utf8), to: resources.appendingPathComponent("frozen-launcher-config.json"))
        write(Data(inventoryJSON.utf8), to: resources.appendingPathComponent("runtime-inventory.json"))
        write(Data("fixture executable \(label)".utf8),
              to: candidateApp.appendingPathComponent("Contents/MacOS/DeepSeek Harness"),
              executable: true)
        for entry in AppSwitch.recoveryEntryNames {
            let entryApp = candidateRoot.appendingPathComponent(entry, isDirectory: true)
            write(Data("recovery entry \(entry)".utf8),
                  to: entryApp.appendingPathComponent("Contents/MacOS/Recovery"),
                  executable: true)
        }
        let dataHome = candidateRoot.appendingPathComponent("data-home", isDirectory: true)
        let markerJSON = """
        {
          "schema": "deepseek-harness.data-version/1",
          "programVersion": "\(revision)",
          "dataVersion": "data-\(label)",
          "switchedAt": "2026-09-18T00:00:00Z"
        }
        """
        write(Data(markerJSON.utf8), to: dataHome.appendingPathComponent("data-version.json"))
        write(Data("candidate data file".utf8), to: dataHome.appendingPathComponent("session.json"))

        let configDigest = sha256Hex(at: resources.appendingPathComponent("frozen-launcher-config.json"))!
        let inventoryDigest = sha256Hex(at: resources.appendingPathComponent("runtime-inventory.json"))!
        let identityJSON = """
        {
          "trialRoot": "\(candidateRoot.path)",
          "app": "\(candidateApp.path)",
          "sourceRevision": "\(revision)",
          "frozenConfigSHA256": "\(configDigest)",
          "runtimeInventorySHA256": "\(inventoryDigest)",
          "recoveryApps": ["DeepSeek Harness Emergency Recovery.app", "DeepSeek Harness Recovery.app"]
        }
        """
        let identityURL = candidateRoot.appendingPathComponent("candidate-identity.json")
        write(Data(identityJSON.utf8), to: identityURL)

        let lastGoodJSON = """
        {
          "schema": "deepseek-harness.recovery.last-good/1",
          "appPath": "\(candidateApp.path)",
          "frozenConfigSHA256": "\(configDigest)",
          "runtimeInventorySHA256": "\(inventoryDigest)"
        }
        """
        write(Data(lastGoodJSON.utf8), to: candidateRoot.appendingPathComponent("recovery-last-good.json"))

        let resultDigest = sha256Hex(Data("approval result \(label)".utf8))
        let trialRecordJSON = """
        {
          "schema": "self-development-review.trial-record/1",
          "recordedAt": "2026-09-18T13:36:57+08:00",
          "approvedBy": "user (in person)",
          "resultDigest": "\(resultDigest)",
          "candidate": {
            "trialRoot": "\(candidateRoot.path)",
            "app": "\(candidateApp.path)",
            "sourceRevision": "\(revision)",
            "frozenConfigSHA256": "\(configDigest)",
            "runtimeInventorySHA256": "\(inventoryDigest)"
          }
        }
        """
        let trialRecordURL = candidateRoot.appendingPathComponent("trial-record.json")
        write(Data(trialRecordJSON.utf8), to: trialRecordURL)

        // Production installation: an older App and its own data home.
        let productionApp = root.appendingPathComponent("DeepSeek Harness.app", isDirectory: true)
        let productionResources = productionApp.appendingPathComponent("Contents/Resources", isDirectory: true)
        write(Data("production executable before upgrade".utf8),
              to: productionApp.appendingPathComponent("Contents/MacOS/DeepSeek Harness"),
              executable: true)
        write(Data("{ \"mode\": \"frozen\", \"sourceRevision\": \"before\" }".utf8),
              to: productionResources.appendingPathComponent("frozen-launcher-config.json"))
        write(Data("{ \"fixture\": \"production inventory\" }".utf8),
              to: productionResources.appendingPathComponent("runtime-inventory.json"))
        let productionDataHome = root.appendingPathComponent("production-data-home", isDirectory: true)
        let priorMarkerJSON = """
        {
          "schema": "deepseek-harness.data-version/1",
          "programVersion": "before",
          "dataVersion": "data-before",
          "switchedAt": "2026-01-01T00:00:00Z"
        }
        """
        write(Data(priorMarkerJSON.utf8),
              to: productionDataHome.appendingPathComponent("data-version.json"))
        write(Data("production user data".utf8),
              to: productionDataHome.appendingPathComponent("settings.json"))

        return Installation(
            root: root,
            candidateRoot: candidateRoot,
            candidateApp: candidateApp,
            identityURL: identityURL,
            trialRecordURL: trialRecordURL,
            productionApp: productionApp,
            productionDataHome: productionDataHome,
            transactionDirectory: root,
            sourceRevision: revision)
    }

    static let verifyOK = ["/bin/sh", "-c", "exit 0"]
    static let verifyFail = ["/bin/sh", "-c", "exit 3"]

    static func options(
        verify: [String] = UpgradeFixture.verifyOK,
        transactionDirectory: URL? = nil,
        stopAfter: UpgradeTransactionState? = nil
    ) -> UpgradeEngine.Options {
        UpgradeEngine.Options(
            transactionDirectory: transactionDirectory,
            backupsRoot: nil,
            verifyCommand: verify,
            stopAfter: stopAfter)
    }

    /// The production executable's bytes, the value a rollback must preserve.
    static func productionExecutableBytes(_ installation: Installation) -> Data {
        try! Data(contentsOf: installation.productionApp
            .appendingPathComponent("Contents/MacOS/DeepSeek Harness"))
    }

    static func marker(in dataHome: URL) -> DataVersionMarker? {
        guard let data = try? Data(contentsOf: dataHome.appendingPathComponent("data-version.json")) else {
            return nil
        }
        return try? JSONDecoder().decode(DataVersionMarker.self, from: data)
    }
}
