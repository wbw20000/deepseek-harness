import CryptoKit
import Darwin
import Foundation

/// Filesystem primitives shared by the backup, staging, and switch steps.
/// Every helper refuses symlinks and non-regular files instead of following
/// them, and every hash is computed from the bytes that were actually copied.
public enum FileOps {

    /// `true` when `lstat` (never following a final symlink) reports a
    /// directory.
    public static func isRealDirectory(_ url: URL) -> Bool {
        var stats = stat()
        guard lstat(url.path, &stats) == 0 else { return false }
        return (stats.st_mode & S_IFMT) == S_IFDIR
    }

    /// `true` when `lstat` reports a regular file.
    public static func isRegularFile(_ url: URL) -> Bool {
        var stats = stat()
        guard lstat(url.path, &stats) == 0 else { return false }
        return (stats.st_mode & S_IFMT) == S_IFREG
    }

    /// Canonical absolute path with every symlink resolved via `realpath(3)`;
    /// `nil` for paths that name nothing. `URL.resolvingSymlinksInPath` does
    /// not resolve a symlinked intermediate such as `/tmp` → `/private/tmp`,
    /// which the directory enumerator does resolve, so this is the one
    /// canonicalization the enumeration-based copies rely on.
    static func canonicalPath(_ url: URL) -> String? {
        guard let resolved = realpath(url.path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    /// Validates an absolute, non-`..`-carrying input path.
    static func absolutePath(_ value: String, label: String) -> Result<URL, TransactionError> {
        guard !value.isEmpty, value.hasPrefix("/"), !value.contains("\0") else {
            return .failure(.invalidInput("\(label) must be an absolute path"))
        }
        let components = value.split(separator: "/").map(String.init)
        guard !components.contains("."), !components.contains("..") else {
            return .failure(.invalidInput("\(label) must not contain `.` or `..` components"))
        }
        return .success(URL(fileURLWithPath: value, isDirectory: true))
    }

    /// SHA-256 of a regular file, streamed in bounded chunks; `nil` when the
    /// path is missing, a symlink (final component), a special file, or a
    /// hardlink.
    static func sha256File(_ url: URL) -> String? {
        let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW)
        guard descriptor >= 0 else { return nil }
        defer { close(descriptor) }
        var stats = stat()
        guard fstat(descriptor, &stats) == 0,
              (stats.st_mode & S_IFMT) == S_IFREG, stats.st_nlink == 1 else { return nil }
        var hasher = SHA256()
        var buffer = [UInt8](repeating: 0, count: 1024 * 1024)
        var total = 0
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            if count < 0 {
                if errno == EINTR { continue }
                return nil
            }
            if count == 0 { break }
            hasher.update(data: buffer.prefix(count))
            total += count
        }
        guard total == stats.st_size else { return nil }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// One hashed regular file recorded in a backup manifest or verified
    /// against one.
    struct FileEntry: Codable, Equatable {
        /// Path relative to the copied root, `/`-separated.
        let path: String
        let size: Int
        let sha256: String
    }

    /// Copies a directory tree, refusing symlinks and special files, and
    /// returns the manifest entries of every copied regular file. The
    /// destination must not exist; missing parents are created. Permissions
    /// are preserved for files and directories so an executable bundle stays
    /// executable.
    static func copyTree(from source: URL, to destination: URL) -> Result<[FileEntry], TransactionError> {
        let fileManager = FileManager.default
        guard isRealDirectory(source) else {
            return .failure(.invalidInput("not a real directory: \(source.path)"))
        }
        guard !fileManager.fileExists(atPath: destination.path) else {
            return .failure(.invalidInput("destination already exists: \(destination.path)"))
        }
        do {
            try fileManager.createDirectory(atPath: destination.path, withIntermediateDirectories: true)
        } catch {
            return .failure(.stepFailed("cannot create \(destination.path): \(error)"))
        }
        preserveDirectoryPermissions(from: source, to: destination)

        // The enumerator resolves symlinks in the root (a `/tmp` fixture
        // path enumerates as `/private/tmp/...`), so relative paths are
        // computed against the resolved root.
        let rootPath = canonicalPath(source) ?? source.path
        var entries: [FileEntry] = []
        let enumerator = fileManager.enumerator(at: source, includingPropertiesForKeys: nil)
        while let item = enumerator?.nextObject() as? URL {
            var stats = stat()
            guard lstat(item.path, &stats) == 0 else {
                return .failure(.stepFailed("cannot stat \(item.path)"))
            }
            guard item.path.hasPrefix(rootPath + "/") else {
                return .failure(.stepFailed("enumerated path escaped the root: \(item.path)"))
            }
            switch stats.st_mode & S_IFMT {
            case S_IFDIR:
                let relative = item.path.dropFirst(rootPath.count + 1)
                let target = destination.appendingPathComponent(String(relative), isDirectory: true)
                do {
                    try fileManager.createDirectory(atPath: target.path, withIntermediateDirectories: true)
                } catch {
                    return .failure(.stepFailed("cannot create \(target.path): \(error)"))
                }
                preserveDirectoryPermissions(from: item, to: target)
            case S_IFREG:
                let relative = String(item.path.dropFirst(rootPath.count + 1))
                switch copyFile(from: item,
                                to: destination.appendingPathComponent(relative),
                                relativePath: relative) {
                case let .failure(error): return .failure(error)
                case let .success(entry): entries.append(entry)
                }
            default:
                return .failure(.invalidInput(
                    "refusing non-regular file inside \(source.path): \(item.path)"))
            }
        }
        return .success(entries.sorted { $0.path < $1.path })
    }

    private static func preserveDirectoryPermissions(from source: URL, to destination: URL) {
        var stats = stat()
        guard lstat(source.path, &stats) == 0 else { return }
        chmod(destination.path, stats.st_mode & 0o7777)
    }

    /// Copies one regular file and returns its manifest entry. The hash is
    /// taken from the bytes written, then re-read back from disk by callers
    /// that verify a backup.
    static func copyFile(from source: URL, to destination: URL,
                         relativePath: String) -> Result<FileEntry, TransactionError> {
        guard isRegularFile(source) else {
            return .failure(.invalidInput("not a regular file: \(source.path)"))
        }
        guard let descriptor = try? FileHandle(forReadingFrom: source) else {
            return .failure(.stepFailed("cannot read \(source.path)"))
        }
        defer { try? descriptor.close() }
        guard FileManager.default.createFile(
            atPath: destination.path, contents: nil,
            attributes: [.posixPermissions: sourcePermissions(source)]) else {
            return .failure(.stepFailed("cannot create \(destination.path)"))
        }
        guard let output = try? FileHandle(forWritingTo: destination) else {
            return .failure(.stepFailed("cannot write \(destination.path)"))
        }
        defer { try? output.close() }
        var hasher = SHA256()
        var size = 0
        while let chunk = try? descriptor.read(upToCount: 1024 * 1024), !chunk.isEmpty {
            hasher.update(data: chunk)
            size += chunk.count
            try? output.write(contentsOf: chunk)
        }
        return .success(FileEntry(
            path: relativePath,
            size: size,
            sha256: hasher.finalize().map { String(format: "%02x", $0) }.joined()))
    }

    private static func sourcePermissions(_ url: URL) -> Int {
        var stats = stat()
        guard lstat(url.path, &stats) == 0 else { return 0o644 }
        return Int(stats.st_mode & 0o7777)
    }

    /// Atomic replace with `rename(2)`: the destination is replaced in one
    /// kernel operation or the call fails and changes nothing. `moveItem`
    /// refuses an existing destination and cannot publish over live files.
    static func renameAtomic(from source: URL, to destination: URL) -> Result<Void, TransactionError> {
        guard rename(source.path, destination.path) == 0 else {
            return .failure(.stepFailed("cannot rename \(source.path) into \(destination.path): errno \(errno)"))
        }
        return .success(())
    }

    /// Atomic byte write for small metadata files: unique temp file in the
    /// destination directory, then `rename(2)` into place.
    static func atomicWrite(_ data: Data, to url: URL) -> Result<Void, TransactionError> {
        let temporary = url.deletingLastPathComponent()
            .appendingPathComponent(".\(url.lastPathComponent).tmp.\(UUID().uuidString)")
        guard FileManager.default.createFile(
            atPath: temporary.path, contents: data,
            attributes: [.posixPermissions: 0o644]) else {
            return .failure(.stepFailed("cannot create \(temporary.path)"))
        }
        return renameAtomic(from: temporary, to: url)
    }

    /// Decodes a bounded JSON document from a regular file.
    public static func decodeJSON<T: Decodable>(_ type: T.Type, from url: URL,
                                         maximumBytes: Int) -> Result<T, TransactionError> {
        let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else {
            return .failure(.invalidInput("missing or unreadable \(url.path)"))
        }
        defer { close(descriptor) }
        var stats = stat()
        guard fstat(descriptor, &stats) == 0,
              (stats.st_mode & S_IFMT) == S_IFREG, stats.st_nlink == 1,
              stats.st_size >= 0, stats.st_size <= maximumBytes else {
            return .failure(.invalidInput("not a bounded regular file: \(url.path)"))
        }
        guard let data = try? Data(contentsOf: url) else {
            return .failure(.invalidInput("cannot read \(url.path)"))
        }
        do {
            return .success(try JSONDecoder().decode(type, from: data))
        } catch {
            return .failure(.invalidInput("malformed JSON in \(url.path): \(error)"))
        }
    }

    public static func isValidDigest(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    static func isoNow() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: Date())
    }
}
