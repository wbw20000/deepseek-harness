import CryptoKit
import Foundation
@testable import LauncherCore

/// Builds a minimal but structurally complete frozen bundle fixture. The
/// payloads are inert fixtures (a shell script as "Node", text entries); the
/// digests are the real SHA-256 of the written files, so selection accepts
/// the bundle exactly the way it would accept a built candidate. The data
/// home lives inside the managed installation, as real recorded homes must.
/// Fixtures are clearly test-only: they are never installed and never seed a
/// real last-good approval.
enum RecoveryFixture {

    struct Bundle {
        let installationRoot: URL
        let appURL: URL
        let resourcesDirectory: URL
        let dshHome: URL
        let recordURL: URL
    }

    static func sha256Hex(_ url: URL) -> String {
        let data = try! Data(contentsOf: url)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// - Parameters:
    ///   - launchable: when `true`, the fixture "Node" emits a valid
    ///     readiness line on stdout and then sleeps, so an owned
    ///     `BackendController` can reach the running phase against it.
    ///   - installationRoot: when given, the fixture is built inside this
    ///     already-existing directory instead of a fresh temp directory; the
    ///     caller owns creating and removing it.
    @discardableResult
    static func make(_ label: String, launchable: Bool = false,
                     installationRoot overrideRoot: URL? = nil) -> Bundle {
        let fileManager = FileManager.default
        let installationRoot = overrideRoot ?? TempDir.make("install-\(label)")
        let appURL = installationRoot.appendingPathComponent("DeepSeek Harness (Recovery Fixture).app", isDirectory: true)
        let resources = appURL.appendingPathComponent("Contents/Resources", isDirectory: true)
        try! fileManager.createDirectory(at: resources, withIntermediateDirectories: true)

        let dshHome = installationRoot.appendingPathComponent("data-home", isDirectory: true)
        try! fileManager.createDirectory(at: dshHome, withIntermediateDirectories: false)
        let runtimeDir = resources.appendingPathComponent("payload-runtime", isDirectory: true)
        try! fileManager.createDirectory(at: runtimeDir, withIntermediateDirectories: false)

        let nodeURL = resources.appendingPathComponent("payload-node")
        let nodeScript = launchable
            ? "#!/bin/sh\ncat \"$0.url\"\nexec sleep 120\n"
            : "#!/bin/sh\nexit 3\n"
        try! nodeScript.data(using: .utf8)!.write(to: nodeURL)
        try! fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: nodeURL.path)

        let entryURL = runtimeDir.appendingPathComponent("bin/dsh.js")
        try! fileManager.createDirectory(at: entryURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try! Data("export {}\n".utf8).write(to: entryURL)

        let patchURL = resources.appendingPathComponent("loopback.patch.yml")
        try! Data("listeners: []\n".utf8).write(to: patchURL)

        let inventoryURL = resources.appendingPathComponent("runtime-inventory.json")
        try! Data("{\"version\":1,\"algorithm\":\"sha256\",\"files\":[]}".utf8).write(to: inventoryURL)

        let config = """
        {"mode":"frozen","runtimeDirectory":"payload-runtime","nodePath":"payload-node",\
        "dshEntryPath":"bin/dsh.js","dshHome":"\(dshHome.path)","patchPath":"loopback.patch.yml",\
        "sourceRevision":"recovery-fixture","lockfileDigest":"\(String(repeating: "a", count: 64))",\
        "inventoryFile":"runtime-inventory.json"}
        """
        let configURL = resources.appendingPathComponent("frozen-launcher-config.json")
        try! Data(config.utf8).write(to: configURL)

        let bundle = Bundle(
            installationRoot: installationRoot,
            appURL: appURL,
            resourcesDirectory: resources,
            dshHome: dshHome,
            recordURL: installationRoot.appendingPathComponent("recovery-last-good.json"))
        if launchable {
            try! ("dsh web: http://127.0.0.1:0/?token=fixture-\(label)\n")
                .data(using: .utf8)!.write(to: URL(fileURLWithPath: nodeURL.path + ".url"))
        }
        writeRecord(for: bundle)
        return bundle
    }

    /// Rewrites the recorded data home in the sealed configuration and
    /// refreshes the record digests, so a test can point the selection at a
    /// different home without rebuilding the bundle.
    static func setDshHome(_ bundle: Bundle, to home: URL) {
        let configURL = bundle.resourcesDirectory.appendingPathComponent("frozen-launcher-config.json")
        var object = try! JSONSerialization.jsonObject(with: Data(contentsOf: configURL)) as! [String: Any]
        object["dshHome"] = home.path
        let data = try! JSONSerialization.data(withJSONObject: object)
        try! data.write(to: configURL)
        writeRecord(for: bundle)
    }

    /// Replaces the fixture inventory with a real seal of every regular file
    /// under Resources (the way the build tool writes it) and refreshes the
    /// record, so the full `RuntimeIntegrityValidator` pass can succeed.
    static func seal(_ bundle: Bundle) {
        var files: [[String: Any]] = []
        collect("", in: bundle, into: &files)
        files.sort { ($0["path"] as! String) < ($1["path"] as! String) }
        let inventory: [String: Any] = ["version": 1, "algorithm": "sha256", "files": files]
        let data = try! JSONSerialization.data(withJSONObject: inventory)
        try! (data + Data("\n".utf8)).write(
            to: bundle.resourcesDirectory.appendingPathComponent("runtime-inventory.json"))
        writeRecord(for: bundle)
    }

    private static func collect(_ directory: String, in bundle: Bundle, into files: inout [[String: Any]]) {
        let directoryURL = directory.isEmpty
            ? bundle.resourcesDirectory
            : bundle.resourcesDirectory.appendingPathComponent(directory, isDirectory: true)
        for child in (try! FileManager.default.contentsOfDirectory(atPath: directoryURL.path)).sorted() {
            let relative = directory.isEmpty ? child : "\(directory)/\(child)"
            if relative == "runtime-inventory.json" { continue }
            let url = directoryURL.appendingPathComponent(child)
            var isDirectory: ObjCBool = false
            FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)
            if isDirectory.boolValue {
                collect(relative, in: bundle, into: &files)
                continue
            }
            let attributes = try! FileManager.default.attributesOfItem(atPath: url.path)
            guard (attributes[.type] as? FileAttributeType) == .typeRegular else { continue }
            let data = try! Data(contentsOf: url)
            let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            files.append([
                "path": relative,
                "sha256": digest,
                "size": data.count,
                "mode": String(attributes[.posixPermissions] as! Int, radix: 8),
            ])
        }
    }

    static func writeRecord(for bundle: Bundle, schema: String = RecoverySelection.supportedSchema,
                            appPath: String? = nil, configDigest: String? = nil,
                            inventoryDigest: String? = nil) {
        let record = """
        {"schema":"\(schema)","appPath":"\(appPath ?? bundle.appURL.path)",\
        "frozenConfigSHA256":"\(configDigest ?? sha256Hex(bundle.resourcesDirectory.appendingPathComponent("frozen-launcher-config.json")))",\
        "runtimeInventorySHA256":"\(inventoryDigest ?? sha256Hex(bundle.resourcesDirectory.appendingPathComponent("runtime-inventory.json")))"}
        """
        try! Data(record.utf8).write(to: bundle.recordURL)
    }
}
