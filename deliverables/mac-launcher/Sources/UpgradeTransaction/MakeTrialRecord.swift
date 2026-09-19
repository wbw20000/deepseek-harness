import Foundation

/// `make-trial-record` — the auditable bridge that formats a manual trial
/// record into the schema the upgrade engine accepts. It does exactly two
/// things and guesses nothing:
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
/// bridge it through this command, and only then run the upgrade.
///
/// The command lives in the library so `swift run UpgradeTests` exercises
/// the exact assertions in-process on a clean `.build`, where the
/// `dsh-upgrade` executable is not built; the executable target only wraps
/// this entry point.
public enum MakeTrialRecordCommand {

    /// Runs `make-trial-record` with the given arguments (everything after
    /// the subcommand). Returns the process exit code (0 success, 1 write or
    /// binding failure, 2 usage error) and the output the CLI would print —
    /// informational lines to stdout, refusal and failure lines prefixed
    /// `dsh-upgrade:` in the caller's stderr. It performs no I/O beyond the
    /// named files and never starts a process.
    public static func run(_ arguments: [String]) -> (code: Int32, output: String) {
        var output = ""
        func append(_ line: String) {
            output += line + "\n"
        }
        func refused(_ message: String) -> (code: Int32, output: String) {
            return (2, output + "dsh-upgrade: \(message)\n")
        }
        func failed(_ message: String) -> (code: Int32, output: String) {
            return (1, output + "dsh-upgrade: \(message)\n")
        }

        let parsed: UpgradeCLI.Parsed
        switch UpgradeCLI.parse(
            arguments,
            flags: ["--candidate-identity", "--approved-by", "--result-digest", "--out"]) {
        case let .failure(error): return refused(error.message)
        case let .success(value): parsed = value
        }
        let identityPath: URL
        switch UpgradeCLI.required(parsed, "--candidate-identity") {
        case let .failure(error): return refused(error.message)
        case let .success(url): identityPath = url
        }
        guard let approvedBy = parsed.values["--approved-by"] else {
            return refused("missing required flag --approved-by")
        }
        guard let resultDigest = parsed.values["--result-digest"] else {
            return refused("missing required flag --result-digest")
        }
        let outPath: URL
        switch UpgradeCLI.required(parsed, "--out") {
        case let .failure(error): return refused(error.message)
        case let .success(url): outPath = url
        }
        guard !approvedBy.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return refused("--approved-by must be a non-empty name")
        }
        guard FileOps.isValidDigest(resultDigest) else {
            return refused("--result-digest must be a lowercase 64-character SHA-256 value; "
                + "never guess it — take it from the approval result or compute the candidate summary by hand")
        }

        /// The identity fields the bridge binds; the real
        /// `candidate-identity.json` carries more build fields, which are
        /// ignored.
        struct CandidateIdentityFile: Decodable {
            let sourceRevision: String
            let frozenConfigSHA256: String
            let runtimeInventorySHA256: String
            let app: String
        }

        let identity: CandidateIdentityFile
        switch FileOps.decodeJSON(CandidateIdentityFile.self, from: identityPath,
                                  maximumBytes: CandidateIdentity.maximumJSONBytes) {
        case let .failure(error): return failed(String(describing: error))
        case let .success(value): identity = value
        }
        guard !identity.sourceRevision.isEmpty else {
            return failed("identity sourceRevision is empty")
        }
        guard FileOps.isValidDigest(identity.frozenConfigSHA256),
              FileOps.isValidDigest(identity.runtimeInventorySHA256) else {
            return failed("identity digests must be lowercase 64-character SHA-256 values")
        }
        guard identity.app.hasSuffix(".app"),
              FileOps.isRealDirectory(URL(fileURLWithPath: identity.app, isDirectory: true)) else {
            return failed("identity app must name an existing .app directory: \(identity.app)")
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
            return failed("cannot encode the trial record")
        }
        guard !FileManager.default.fileExists(atPath: outPath.path) else {
            return refused("refusing to overwrite an existing trial record: \(outPath.path)")
        }
        FileManager.default.createFile(atPath: outPath.path, contents: data,
                                       attributes: [.posixPermissions: 0o600])

        // The binding proof: the artifact on disk must decode, carry the
        // manual-bridge source, and name exactly the identity's candidate.
        switch FileOps.decodeJSON(TrialRecord.self, from: outPath,
                                  maximumBytes: TrialRecord.maximumJSONBytes) {
        case let .failure(error):
            return failed("the written record does not decode: \(error)")
        case let .success(written):
            guard written.candidate == candidate,
                  written.trialRecordSource == TrialRecord.manualBridgeSource else {
                return failed("the written record does not bind the identity's candidate")
            }
        }
        append("wrote \(outPath.path)")
        append("approvedBy: \(approvedBy)")
        append("resultDigest: \(resultDigest)")
        append("candidate: \(candidate.app) @ \(candidate.sourceRevision)")
        append("trialRecordSource: \(TrialRecord.manualBridgeSource)")
        return (0, output)
    }
}
