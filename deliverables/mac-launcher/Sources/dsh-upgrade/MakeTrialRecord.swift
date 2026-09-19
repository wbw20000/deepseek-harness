import Foundation
import UpgradeTransaction

/// `dsh-upgrade make-trial-record` — the auditable bridge that formats a
/// manual trial record into the schema the upgrade engine accepts. It does
/// exactly two things and guesses nothing:
///
/// 1. Format: it assembles a `self-development-review.trial-record/1`
///    document with the given approver, the given `resultDigest` (checked
///    to be a SHA-256 hex digest, never computed here), and the candidate
///    identity fields copied verbatim from `candidate-identity.json`.
/// 2. Identity binding: it re-reads the written record and rejects unless
///    its `candidate` section equals the identity file's `sourceRevision`,
///    two digests, and `app`.
///
/// The normal source of `resultDigest` is the core `recordTrialApproval`
/// flow (`trial/approved`), exported by the stable-side facade. A record
/// produced here is marked `"trialRecordSource": "manual-bridge"` and is
/// copied into the transaction record by the upgrade engine, so a manually
/// bridged approval is always distinguishable from a core-recorded one. An
/// M1-era trial record without a `resultDigest` cannot upgrade directly:
/// digest the candidate summary by hand (the values are human-checkable:
/// `frozen-launcher-config.json`, `runtime-inventory.json`, the executable),
/// bridge it through this subcommand, and only then run the upgrade.
struct MakeTrialRecord {

    /// The identity fields the bridge binds; the real
    /// `candidate-identity.json` carries more build fields, which are
    /// ignored.
    struct CandidateIdentityFile: Decodable {
        let sourceRevision: String
        let frozenConfigSHA256: String
        let runtimeInventorySHA256: String
        let app: String
    }

    static func run(_ arguments: [String]) -> Int32 {
        let parsed: DSHUpgrade.Parsed
        switch DSHUpgrade.parse(
            arguments,
            flags: ["--candidate-identity", "--approved-by", "--result-digest", "--out"]) {
        case let .failure(error): DSHUpgrade.printUsageError(error); return 2
        case let .success(value): parsed = value
        }
        let identityPath: URL
        switch DSHUpgrade.required(parsed, "--candidate-identity") {
        case let .failure(error): DSHUpgrade.printUsageError(error); return 2
        case let .success(url): identityPath = url
        }
        guard let approvedBy = parsed.values["--approved-by"] else {
            DSHUpgrade.printUsageError(UsageFailure(message: "missing required flag --approved-by"))
            return 2
        }
        guard let resultDigest = parsed.values["--result-digest"] else {
            DSHUpgrade.printUsageError(UsageFailure(message: "missing required flag --result-digest"))
            return 2
        }
        let outPath: URL
        switch DSHUpgrade.required(parsed, "--out") {
        case let .failure(error): DSHUpgrade.printUsageError(error); return 2
        case let .success(url): outPath = url
        }
        guard !approvedBy.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            DSHUpgrade.printUsageError(UsageFailure(message: "--approved-by must be a non-empty name"))
            return 2
        }
        guard FileOps.isValidDigest(resultDigest) else {
            DSHUpgrade.printUsageError(UsageFailure(
                message: "--result-digest must be a lowercase 64-character SHA-256 value; "
                    + "never guess it — take it from the approval result or compute the candidate summary by hand"))
            return 2
        }

        let identity: CandidateIdentityFile
        switch FileOps.decodeJSON(CandidateIdentityFile.self, from: identityPath,
                                  maximumBytes: CandidateIdentity.maximumJSONBytes) {
        case let .failure(error):
            DSHUpgrade.printUsageError(UsageFailure(message: String(describing: error)))
            return 2
        case let .success(value): identity = value
        }
        guard !identity.sourceRevision.isEmpty else {
            DSHUpgrade.printUsageError(UsageFailure(message: "identity sourceRevision is empty"))
            return 2
        }
        guard FileOps.isValidDigest(identity.frozenConfigSHA256),
              FileOps.isValidDigest(identity.runtimeInventorySHA256) else {
            DSHUpgrade.printUsageError(UsageFailure(
                message: "identity digests must be lowercase 64-character SHA-256 values"))
            return 2
        }
        guard identity.app.hasSuffix(".app"),
              FileOps.isRealDirectory(URL(fileURLWithPath: identity.app, isDirectory: true)) else {
            DSHUpgrade.printUsageError(UsageFailure(
                message: "identity app must name an existing .app directory: \(identity.app)"))
            return 2
        }

        let candidate = TrialRecordCandidate(
            sourceRevision: identity.sourceRevision,
            frozenConfigSHA256: identity.frozenConfigSHA256,
            runtimeInventorySHA256: identity.runtimeInventorySHA256,
            app: identity.app)
        let record = TrialRecord(
            schema: TrialRecord.schema,
            approvedBy: approvedBy,
            resultDigest: resultDigest,
            candidate: candidate,
            trialRecordSource: TrialRecord.manualBridgeSource)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(record) else {
            DSHUpgrade.errorLine("cannot encode the trial record")
            return 1
        }
        guard !FileManager.default.fileExists(atPath: outPath.path) else {
            DSHUpgrade.printUsageError(UsageFailure(
                message: "refusing to overwrite an existing trial record: \(outPath.path)"))
            return 2
        }
        FileManager.default.createFile(atPath: outPath.path, contents: data,
                                       attributes: [.posixPermissions: 0o600])

        // The binding proof: the artifact on disk must decode, carry the
        // manual-bridge source, and name exactly the identity's candidate.
        switch FileOps.decodeJSON(TrialRecord.self, from: outPath,
                                  maximumBytes: TrialRecord.maximumJSONBytes) {
        case let .failure(error):
            DSHUpgrade.errorLine("the written record does not decode: \(error)")
            return 1
        case let .success(written):
            guard written.candidate == candidate,
                  written.trialRecordSource == TrialRecord.manualBridgeSource else {
                DSHUpgrade.errorLine("the written record does not bind the identity's candidate")
                return 1
            }
        }
        print("wrote \(outPath.path)")
        print("approvedBy: \(approvedBy)")
        print("resultDigest: \(resultDigest)")
        print("candidate: \(candidate.app) @ \(candidate.sourceRevision)")
        print("trialRecordSource: \(TrialRecord.manualBridgeSource)")
        return 0
    }
}
