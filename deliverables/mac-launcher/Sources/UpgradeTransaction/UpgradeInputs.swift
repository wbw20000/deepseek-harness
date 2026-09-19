import Foundation

/// The exact candidate identity an upgrade binds to, as recorded by
/// `candidate-identity.json` at build time. Only the fields the transaction
/// checks are decoded; extra build fields are ignored.
public struct CandidateIdentity: Codable, Equatable {
    public static let maximumJSONBytes = 64 * 1024

    public let sourceRevision: String
    public let frozenConfigSHA256: String
    public let runtimeInventorySHA256: String
}

/// The human trial record that approves one exact candidate. `approvedBy` and
/// `resultDigest` come from the core `recordTrialApproval` flow
/// (`trial/approved`); the `candidate` section must name the same identity as
/// `candidate-identity.json`, otherwise the upgrade refuses before touching
/// any file. `trialRecordSource` is written only by the manual bridge
/// `dsh-upgrade make-trial-record`; its absence marks the core flow.
public struct TrialRecord: Codable, Equatable {
    public static let schema = "self-development-review.trial-record/1"
    public static let maximumJSONBytes = 256 * 1024
    /// The only non-core trial-record source, written by `dsh-upgrade
    /// make-trial-record`; an upgrade copies it into the transaction record.
    public static let manualBridgeSource = "manual-bridge"

    public let schema: String
    public let approvedBy: String
    /// SHA-256 over the approval result the core recorded.
    public let resultDigest: String
    public let candidate: TrialRecordCandidate
    /// `manual-bridge` for a manually bridged record; absent for the core
    /// flow. Any other value is a loud refusal.
    public let trialRecordSource: String?

    public init(schema: String, approvedBy: String, resultDigest: String,
                candidate: TrialRecordCandidate, trialRecordSource: String? = nil) {
        self.schema = schema
        self.approvedBy = approvedBy
        self.resultDigest = resultDigest
        self.candidate = candidate
        self.trialRecordSource = trialRecordSource
    }
}

public struct TrialRecordCandidate: Codable, Equatable {
    public let sourceRevision: String
    public let frozenConfigSHA256: String
    public let runtimeInventorySHA256: String
    public let app: String

    public init(sourceRevision: String, frozenConfigSHA256: String,
                runtimeInventorySHA256: String, app: String) {
        self.sourceRevision = sourceRevision
        self.frozenConfigSHA256 = frozenConfigSHA256
        self.runtimeInventorySHA256 = runtimeInventorySHA256
        self.app = app
    }
}

/// The versioned last-good record a candidate installation carries
/// (`recovery-last-good.json`, schema `deepseek-harness.recovery.last-good/1`).
/// The upgrade re-reads it and cross-checks its digests against the identity.
public struct LastGoodRecord: Codable, Equatable {
    public static let schema = "deepseek-harness.recovery.last-good/1"
    public static let maximumJSONBytes = 16 * 1024

    public let schema: String
    public let appPath: String
    public let frozenConfigSHA256: String
    public let runtimeInventorySHA256: String
}

/// The version marker written into a production data home at the switch step.
/// Program version and data version are always written as a pair.
public struct DataVersionMarker: Codable, Equatable {
    public static let schema = "deepseek-harness.data-version/1"
    public static let fileName = "data-version.json"

    public let schema: String
    public let programVersion: String
    public let dataVersion: String
    public let switchedAt: String
}

/// One fully validated upgrade input bundle. Constructing this value runs
/// every binding check; a constructed value is the only thing the engine
/// accepts, so no upgrade can start from unverified inputs.
public struct BoundUpgradeInputs {

    /// Every check the engine performs before the first byte is touched:
    ///
    /// 1. `candidate-identity.json` parses and carries well-formed digests.
    /// 2. The candidate installation's `recovery-last-good.json` names the
    ///    candidate App and carries exactly the identity's two digests.
    /// 3. The candidate App bundle's `frozen-launcher-config.json` and
    ///    `runtime-inventory.json` re-hash to exactly those digests.
    /// 4. The trial record's `candidate` section equals the identity, its
    ///    `app` names the candidate App, and it carries a non-empty
    ///    `approvedBy` and a well-formed `resultDigest`.
    /// 5. The production App and data home exist, are real directories, and
    ///    the production App is not the candidate App itself.
    ///
    /// Any failed check returns an error and leaves the filesystem
    /// untouched: these are reads only.
    public static func bind(
        candidateRoot: URL, identityPath: URL, trialRecordPath: URL,
        productionApp: URL, productionDataHome: URL
    ) -> Result<BoundUpgradeInputs, TransactionError> {
        guard FileOps.isRealDirectory(candidateRoot) else {
            return .failure(.bindingRejected("candidate root is not a directory: \(candidateRoot.path)"))
        }
        let identity: CandidateIdentity
        switch FileOps.decodeJSON(CandidateIdentity.self, from: identityPath,
                                  maximumBytes: CandidateIdentity.maximumJSONBytes) {
        case let .failure(error): return .failure(.bindingRejected("\(error)"))
        case let .success(value): identity = value
        }
        guard !identity.sourceRevision.isEmpty else {
            return .failure(.bindingRejected("identity sourceRevision is empty"))
        }
        guard FileOps.isValidDigest(identity.frozenConfigSHA256),
              FileOps.isValidDigest(identity.runtimeInventorySHA256) else {
            return .failure(.bindingRejected("identity digests must be lowercase 64-character SHA-256 values"))
        }

        let candidateApp = candidateRoot.appendingPathComponent(
            "DeepSeek Harness Frozen Trial.app", isDirectory: true)
        guard FileOps.isRealDirectory(candidateApp) else {
            return .failure(.bindingRejected("candidate App bundle missing: \(candidateApp.path)"))
        }
        let candidateResources = candidateApp
            .appendingPathComponent("Contents/Resources", isDirectory: true)
        guard FileOps.isRealDirectory(candidateResources) else {
            return .failure(.bindingRejected("candidate bundle has no Contents/Resources"))
        }

        // The candidate's own last-good record must name exactly this
        // candidate with exactly the identity's digests.
        let lastGoodURL = candidateRoot.appendingPathComponent("recovery-last-good.json")
        let lastGood: LastGoodRecord
        switch FileOps.decodeJSON(LastGoodRecord.self, from: lastGoodURL,
                                  maximumBytes: LastGoodRecord.maximumJSONBytes) {
        case let .failure(error): return .failure(.bindingRejected("\(error)"))
        case let .success(value): lastGood = value
        }
        guard lastGood.schema == LastGoodRecord.schema else {
            return .failure(.bindingRejected("unsupported last-good schema \(lastGood.schema)"))
        }
        guard lastGood.appPath == candidateApp.path else {
            return .failure(.bindingRejected(
                "last-good appPath \(lastGood.appPath) does not name the candidate App \(candidateApp.path)"))
        }
        guard lastGood.frozenConfigSHA256 == identity.frozenConfigSHA256,
              lastGood.runtimeInventorySHA256 == identity.runtimeInventorySHA256 else {
            return .failure(.bindingRejected("candidate last-good digests do not match the identity"))
        }

        // The bundle's frozen metadata must re-hash to the identity.
        for (url, expected, label) in [
            (candidateResources.appendingPathComponent("frozen-launcher-config.json"),
             identity.frozenConfigSHA256, "frozen-launcher-config.json"),
            (candidateResources.appendingPathComponent("runtime-inventory.json"),
             identity.runtimeInventorySHA256, "runtime-inventory.json"),
        ] {
            guard let digest = FileOps.sha256File(url) else {
                return .failure(.bindingRejected("cannot hash candidate \(label) at \(url.path)"))
            }
            guard digest == expected else {
                return .failure(.bindingRejected("candidate \(label) hash mismatch: \(digest) != \(expected)"))
            }
        }

        // The approval must name the same candidate.
        let trialRecord: TrialRecord
        switch FileOps.decodeJSON(TrialRecord.self, from: trialRecordPath,
                                  maximumBytes: TrialRecord.maximumJSONBytes) {
        case let .failure(error): return .failure(.bindingRejected("\(error)"))
        case let .success(value): trialRecord = value
        }
        guard trialRecord.schema == TrialRecord.schema else {
            return .failure(.bindingRejected("unsupported trial-record schema \(trialRecord.schema)"))
        }
        switch trialRecord.trialRecordSource {
        case nil, TrialRecord.manualBridgeSource?:
            break
        case .some(let unknown):
            return .failure(.bindingRejected("unsupported trial-record source \(unknown)"))
        }
        guard trialRecord.candidate == TrialRecordCandidate(
            sourceRevision: identity.sourceRevision,
            frozenConfigSHA256: identity.frozenConfigSHA256,
            runtimeInventorySHA256: identity.runtimeInventorySHA256,
            app: candidateApp.path) else {
            return .failure(.bindingRejected("trial record candidate does not equal the candidate identity"))
        }
        guard !trialRecord.approvedBy.isEmpty else {
            return .failure(.bindingRejected("trial record approvedBy is empty"))
        }
        guard FileOps.isValidDigest(trialRecord.resultDigest) else {
            return .failure(.bindingRejected("trial record resultDigest is not a SHA-256 digest"))
        }

        guard FileOps.isRealDirectory(productionApp), productionApp.path.hasSuffix(".app") else {
            return .failure(.bindingRejected("production App is not an existing .app directory: \(productionApp.path)"))
        }
        guard FileOps.isRealDirectory(productionDataHome) else {
            return .failure(.bindingRejected("production data home is not a directory: \(productionDataHome.path)"))
        }
        guard productionApp.standardizedFileURL.path != candidateApp.standardizedFileURL.path else {
            return .failure(.bindingRejected("production App and candidate App are the same bundle"))
        }
        let dataVersion: String
        switch Self.recordedDataVersion(in: candidateRoot.appendingPathComponent("data-home")) {
        case let .failure(error): return .failure(.bindingRejected("\(error)"))
        case let .success(value): dataVersion = value
        }

        return .success(BoundUpgradeInputs(
            identity: identity,
            candidateRoot: candidateRoot,
            candidateApp: candidateApp,
            trialRecordPath: trialRecordPath,
            trialRecordSource: trialRecord.trialRecordSource,
            identityPath: identityPath,
            productionApp: productionApp,
            productionDataHome: productionDataHome,
            dataVersion: dataVersion))
    }

    /// The candidate data home may carry its own `data-version.json`; when it
    /// does, its data version becomes the paired data version of the upgrade.
    /// A present but malformed marker is a loud refusal, never a fallback.
    static func recordedDataVersion(in candidateDataHome: URL) -> Result<String, TransactionError> {
        let url = candidateDataHome.appendingPathComponent(DataVersionMarker.fileName)
        guard FileOps.isRegularFile(url) else { return .success("") }
        switch FileOps.decodeJSON(DataVersionMarker.self, from: url,
                                  maximumBytes: 64 * 1024) {
        case let .failure(error):
            return .failure(error)
        case let .success(marker):
            return .success(marker.dataVersion)
        }
    }

    public let identity: CandidateIdentity
    public let candidateRoot: URL
    public let candidateApp: URL
    public let trialRecordPath: URL
    /// The bound trial record's source marker (`manual-bridge` or `nil`).
    public let trialRecordSource: String?
    public let identityPath: URL
    public let productionApp: URL
    public let productionDataHome: URL
    /// The paired data version: the candidate marker's value when present,
    /// otherwise the candidate's source revision.
    public let dataVersion: String

    init(identity: CandidateIdentity, candidateRoot: URL, candidateApp: URL,
         trialRecordPath: URL, trialRecordSource: String?, identityPath: URL,
         productionApp: URL, productionDataHome: URL, dataVersion: String) {
        self.identity = identity
        self.candidateRoot = candidateRoot
        self.candidateApp = candidateApp
        self.trialRecordPath = trialRecordPath
        self.trialRecordSource = trialRecordSource
        self.identityPath = identityPath
        self.productionApp = productionApp
        self.productionDataHome = productionDataHome
        self.dataVersion = dataVersion.isEmpty ? identity.sourceRevision : dataVersion
    }
}
