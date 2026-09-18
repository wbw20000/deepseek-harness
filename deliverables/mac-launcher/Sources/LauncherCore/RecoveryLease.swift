import Darwin
import Foundation

/// Excludes concurrent frozen writers from the same harness data home with an
/// OS-held `flock` on a descriptor of the data-home directory itself. The
/// kernel releases the lock when the holding process exits, so there is no
/// stale PID file, no lock file inside the data home, and no lock to clean up.
/// `BackendController` acquires it before any frozen backend starts — for the
/// ordinary frozen launcher and the recovery Apps alike — and holds it until
/// the owning launch's teardown has fully settled, so a frozen launcher and a
/// recovery App cannot write the same data home concurrently. `flock` is
/// advisory: it coordinates only processes that use this type.
public final class RecoveryLease {

    public enum LeaseError: Error, Equatable {
        /// Another process holds the lease on this data home.
        case unavailable
        /// The data home is missing, is not a real directory, or the lock
        /// could not be taken for another OS reason; `detail` names it.
        case cannotLock(String)
    }

    /// Directory descriptor the lock is held on; `-1` after release.
    private var descriptor: Int32
    public let dataHome: URL

    private init(descriptor: Int32, dataHome: URL) {
        self.descriptor = descriptor
        self.dataHome = dataHome
    }

    /// Take the exclusive lease on one data home. The final path component is
    /// opened with `O_NOFOLLOW`; a symlinked data home is refused rather than
    /// locked through the link.
    public static func acquire(dataHome: URL) -> Result<RecoveryLease, LeaseError> {
        var stats = stat()
        guard lstat(dataHome.path, &stats) == 0, (stats.st_mode & S_IFMT) == S_IFDIR else {
            return .failure(.cannotLock("the data home is missing or not a real directory: \(dataHome.path)"))
        }
        let descriptor = open(dataHome.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else {
            return .failure(.cannotLock("open failed: \(String(cString: strerror(errno)))"))
        }
        guard fstat(descriptor, &stats) == 0, (stats.st_mode & S_IFMT) == S_IFDIR else {
            close(descriptor)
            return .failure(.cannotLock("the locked path is not a directory: \(dataHome.path)"))
        }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            defer { close(descriptor) }
            if errno == EWOULDBLOCK {
                return .failure(.unavailable)
            }
            return .failure(.cannotLock("flock failed: \(String(cString: strerror(errno)))"))
        }
        return .success(RecoveryLease(descriptor: descriptor, dataHome: dataHome))
    }

    /// Release the lease. Releasing twice is harmless; the descriptor is
    /// closed once. The lease is also released by process exit.
    public func release() {
        if descriptor >= 0 {
            flock(descriptor, LOCK_UN)
            close(descriptor)
            descriptor = -1
        }
    }

    deinit {
        release()
    }
}
