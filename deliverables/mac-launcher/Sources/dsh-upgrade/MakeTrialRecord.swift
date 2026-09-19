import Foundation
import UpgradeTransaction

/// `dsh-upgrade make-trial-record` — the thin CLI wrapper around
/// `MakeTrialRecordCommand` (the formatting and identity-binding contract is
/// documented there). It exits with the command's code and prints the
/// command's output: to stdout on success, to stderr on a refusal or
/// failure.
enum MakeTrialRecord {

    static func run(_ arguments: [String]) -> Int32 {
        let result = MakeTrialRecordCommand.run(arguments)
        if result.code == 0 {
            print(result.output, terminator: "")
        } else {
            FileHandle.standardError.write(Data(result.output.utf8))
        }
        return result.code
    }
}
