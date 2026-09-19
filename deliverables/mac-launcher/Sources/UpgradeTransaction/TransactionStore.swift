import CryptoKit
import Darwin
import Foundation

/// The persisted upgrade/restore transaction. One JSON file
/// (`upgrade-transaction.json`) in a caller-chosen directory records the
/// current state, every state transition, and the exact inputs, so an
/// interrupted process can be reconciled on the next start without repeating
/// any side effect. States advance strictly through
/// `planned → backed-up → staged → switched → verified → committed`; any
/// failing step ends in `rolled-back` (undo succeeded) or `needs-manual`
/// (undo failed; the file carries human-readable guidance).
public enum UpgradeTransactionState: String, Codable, CaseIterable {
    case planned
    case backedUp = "backed-up"
    case staged
    case switched
    case verified
    case committed
    case rolledBack = "rolled-back"
    case needsManual = "needs-manual"

    /// States a crash can leave behind. A record in one of these describes an
    /// unfinished transaction that the next start must reconcile.
    public var isIntermediate: Bool {
        switch self {
        case .planned, .backedUp, .staged, .switched, .verified: return true
        case .committed, .rolledBack, .needsManual: return false
        }
    }

    public var isTerminal: Bool { !isIntermediate }
}

/// One recorded state transition.
public struct UpgradeHistoryEntry: Codable, Equatable {
    public let state: UpgradeTransactionState
    public let at: String
}

/// The per-step side-effect ledger of one transaction run. The engine
/// persists the ledger after every side-effecting step, so the transaction
/// file always answers exactly which steps are done and which are not; the
/// rollback walks the ledger in reverse and undoes only recorded steps. A
/// `nil` ledger (records written before this field existed) falls back to
/// the recorded path fields.
public struct UpgradeSideEffects: Codable, Equatable {
    /// The paired backup of the production App and data home exists.
    public var backup = false
    /// The candidate App was copied into the hidden staging directory.
    public var stage = false
    /// The production App was renamed aside (whether or not the staged copy
    /// was published yet).
    public var swap = false
    /// The paired data-version marker was written.
    public var marker = false
    /// The Recovery entry Apps were installed next to the production App.
    public var recoveryEntries = false

    public init() {}
}

/// The durable transaction record. Field names are the on-disk schema; the
/// schema constant is the only accepted version.
public struct UpgradeTransactionRecord: Codable, Equatable {
    public static let schema = "deepseek-harness.upgrade.transaction/1"

    public let schema: String
    /// `upgrade` installs an approved candidate; `restore` returns the
    /// production installation to a previous version.
    public let kind: String
    public var state: UpgradeTransactionState
    public let createdAt: String
    public var updatedAt: String
    public let sourceRevision: String
    public let dataVersion: String
    public let candidateRoot: String?
    public let candidateAppPath: String
    public let identityPath: String?
    public let trialRecordPath: String?
    public let productionAppPath: String
    public let productionDataHome: String
    public let backupsRoot: String
    public var backupDirectory: String?
    /// Paths of the engine-owned hidden directories the current state has
    /// created, so an interrupted run's residue can be located exactly.
    public var stagedAppPath: String?
    public var replacedAppPath: String?
    /// The data-version marker bytes that were replaced at the switch, so a
    /// rollback restores exactly the prior pairing.
    public var priorDataMarkerBase64: String?
    /// The Recovery entry Apps this run installed, in install order.
    public var recoveryEntriesInstalled: [String]?
    /// Where the trial record came from. `"manual-bridge"` marks a record
    /// produced by `dsh-upgrade make-trial-record` (a manually digested
    /// candidate summary); `nil` marks the core `recordTrialApproval` flow.
    public var trialRecordSource: String?
    /// Which side effects this run actually performed; the rollback undoes
    /// exactly these, in reverse order.
    public var sideEffects: UpgradeSideEffects?
    public let verifyCommand: [String]
    /// Every transition in order, including failures. A committed record
    /// therefore proves each intermediate state was persisted.
    public var history: [UpgradeHistoryEntry]
    /// Human-readable failure detail or reconciliation note; empty on success.
    public var detail: String

    init(kind: String, candidateAppPath: String, productionAppPath: String,
         productionDataHome: String, backupsRoot: String, verifyCommand: [String],
         sourceRevision: String, dataVersion: String, candidateRoot: String?,
         identityPath: String?, trialRecordPath: String?, trialRecordSource: String?,
         now: String) {
        schema = Self.schema
        self.kind = kind
        state = .planned
        createdAt = now
        updatedAt = now
        self.sourceRevision = sourceRevision
        self.dataVersion = dataVersion
        self.candidateRoot = candidateRoot
        self.candidateAppPath = candidateAppPath
        self.identityPath = identityPath
        self.trialRecordPath = trialRecordPath
        self.trialRecordSource = trialRecordSource
        self.productionAppPath = productionAppPath
        self.productionDataHome = productionDataHome
        self.backupsRoot = backupsRoot
        backupDirectory = nil
        stagedAppPath = nil
        replacedAppPath = nil
        priorDataMarkerBase64 = nil
        recoveryEntriesInstalled = nil
        self.trialRecordSource = trialRecordSource
        sideEffects = UpgradeSideEffects()
        self.verifyCommand = verifyCommand
        // The first persisted transition is `planned` itself; the engine
        // records it when it writes the initial record.
        history = []
        detail = ""
    }
}

/// Reads and atomically writes the transaction record. Every write lands in a
/// uniquely named temporary file in the same directory and is moved into place
/// with `rename(2)`, so a reader never observes a torn record and a crash
/// never destroys the previous state.
public struct TransactionStore {
    /// Bounded metadata, not a document.
    public static let maximumRecordBytes = 256 * 1024

    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    public var fileURL: URL {
        directory.appendingPathComponent("upgrade-transaction.json", isDirectory: false)
    }

    /// The record at this store's path, or `nil` when no transaction exists.
    /// A malformed, oversized, or hardlinked record is a loud error, never a
    /// silent "no transaction".
    public func load() -> Result<UpgradeTransactionRecord?, TransactionError> {
        guard let data = boundedRead(fileURL) else {
            return .success(nil)
        }
        do {
            return .success(try JSONDecoder().decode(UpgradeTransactionRecord.self, from: data))
        } catch {
            return .failure(.malformedRecord(String(describing: error)))
        }
    }

    /// Atomic persist: unique temp file, fsync, rename over the destination,
    /// then fsync of the directory so the rename itself survives a crash.
    public func write(_ record: UpgradeTransactionRecord) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(record)
        let temporary = directory.appendingPathComponent(
            ".upgrade-transaction.json.tmp.\(UUID().uuidString)", isDirectory: false)
        FileManager.default.createFile(
            atPath: temporary.path, contents: data,
            attributes: [.posixPermissions: 0o600])
        let descriptor = open(temporary.path, O_RDONLY)
        if descriptor >= 0 {
            fsync(descriptor)
            close(descriptor)
        }
        switch FileOps.renameAtomic(from: temporary, to: fileURL) {
        case .success:
            break
        case let .failure(error):
            try? FileManager.default.removeItem(at: temporary)
            throw error
        }
        let directoryDescriptor = open(directory.path, O_RDONLY | O_DIRECTORY)
        if directoryDescriptor >= 0 {
            fsync(directoryDescriptor)
            close(directoryDescriptor)
        }
    }

    /// Bounded regular-file read that refuses a missing file, a final
    /// symlink, a FIFO, a hardlink, and an over-size file.
    func boundedRead(_ url: URL) -> Data? {
        let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else { return nil }
        defer { close(descriptor) }
        var stats = stat()
        guard fstat(descriptor, &stats) == 0,
              (stats.st_mode & S_IFMT) == S_IFREG, stats.st_nlink == 1,
              stats.st_size >= 0, stats.st_size <= Self.maximumRecordBytes else { return nil }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            if count == 0 { return data }
            if count < 0 {
                if errno == EINTR { continue }
                return nil
            }
            guard data.count + count <= Self.maximumRecordBytes else { return nil }
            data.append(contentsOf: buffer.prefix(count))
        }
    }
}

/// An exclusive advisory lock (`flock(2)`, non-blocking) over one
/// transaction directory. A second concurrent transaction is refused instead
/// of queued: two simultaneous rewrites of the same installation are a
/// caller error, not a work queue.
public final class TransactionLock {
    public enum LockError: Error, Equatable {
        case locked(String)
        case unavailable(String)
    }

    private let fileDescriptor: Int32
    public let fileURL: URL
    /// True while this process still owns the lock.
    public private(set) var isHeld = true

    private init(fileDescriptor: Int32, fileURL: URL) {
        self.fileDescriptor = fileDescriptor
        self.fileURL = fileURL
    }

    /// Acquire the exclusive lock or fail immediately. The lock file is
    /// created next to the transaction file and never removed, so competing
    /// openers always lock the same inode.
    public static func acquire(directory: URL) -> Result<TransactionLock, LockError> {
        let url = directory.appendingPathComponent("upgrade-transaction.lock", isDirectory: false)
        let descriptor = Int32(open(url.path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600))
        guard descriptor >= 0 else {
            return .failure(.unavailable("cannot open lock file \(url.path): errno \(errno)"))
        }
        guard flock(Int32(descriptor), Int32(LOCK_EX | LOCK_NB)) == 0 else {
            let denied = errno == EWOULDBLOCK
            close(descriptor)
            return .failure(denied
                ? .locked("another upgrade transaction holds \(url.path)")
                : .unavailable("cannot lock \(url.path): errno \(errno)"))
        }
        return .success(TransactionLock(fileDescriptor: descriptor, fileURL: url))
    }

    public func release() {
        guard isHeld else { return }
        isHeld = false
        flock(Int32(fileDescriptor), Int32(LOCK_UN))
        close(fileDescriptor)
    }

    deinit {
        if isHeld {
            flock(Int32(fileDescriptor), Int32(LOCK_UN))
            close(fileDescriptor)
        }
    }
}

/// Every refusal and failure the transaction layer reports.
public enum TransactionError: Error, Equatable {
    /// An input path is relative, missing, or otherwise unusable; nothing was
    /// modified.
    case invalidInput(String)
    /// A binding check between candidate identity, trial record, last-good
    /// record, and on-bundle digests failed; nothing was modified.
    case bindingRejected(String)
    /// The transaction directory holds a record this build cannot parse.
    case malformedRecord(String)
    /// Persisting the transaction record failed.
    case persistFailed(String)
    /// The lock is held by another transaction.
    case lockBusy(String)
    /// The lock file could not be created or locked for another reason.
    case lockUnavailable(String)
    /// A copy, rename, hash, or verify step failed; the record carries the
    /// failing path and the engine rolled back (or reports needs-manual).
    case stepFailed(String)
}
