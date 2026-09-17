import CryptoKit
import Darwin
import Foundation

/// Validates the materialized frozen payload against its build-time SHA-256
/// inventory before the launcher starts the bundled Node. The validation
/// walks `Contents/Resources`, requires the exact file set the inventory
/// seals (no tampered, missing, or unsigned extra files), and refuses every
/// symlink, special file, and hardlink (nlink > 1), so no payload path can
/// point at — or share bytes with — a file outside the bundle. Hashing is
/// streamed and the whole validation runs off the main actor, so a large
/// package never blocks the UI; cancellation is checked between files.
public enum RuntimeIntegrityValidator {

    public enum IntegrityError: Error, Equatable {
        /// The bundle has no `runtime-inventory.json`; it is not a sealed
        /// frozen candidate.
        case inventoryMissing
        /// The inventory exists but violates its schema, names a path outside
        /// the bundle, or lists a path twice.
        case inventoryMalformed(String)
        /// A payload path is a symlink.
        case symlink(String)
        /// A payload path is neither a regular file nor a directory.
        case specialFile(String)
        /// A payload file shares its inode (nlink > 1), so its bytes could be
        /// writable from outside the bundle.
        case hardlinked(String, UInt64)
        /// An inventory entry has no file in the bundle.
        case missingFile(String)
        /// The bundle contains a file the inventory does not seal.
        case extraFile(String)
        /// A sealed file's bytes do not match the recorded digest.
        case hashMismatch(String)
        /// A sealed file's size does not match the recorded size.
        case sizeMismatch(String)
        /// A sealed file's permission bits differ from the inventory.
        case modeMismatch(String)
        /// A sealed file could not be read or hashed.
        case unreadable(String)
        /// Validation was cancelled; the result is discarded by the caller.
        case cancelled
    }

    struct InventoryFile: Decodable, Equatable {
        let path: String
        let sha256: String
        let size: Int
        let mode: String
    }

    struct Inventory: Decodable {
        let version: Int
        let algorithm: String
        let files: [InventoryFile]
    }

    /// The same relative-path rules the build tool applied when it wrote the
    /// inventory: `/`-separated, non-empty components, no `..`, no absolute
    /// or backslash paths.
    static func isValidInventoryPath(_ value: String) -> Bool {
        guard !value.isEmpty, !value.hasPrefix("/"), !value.contains("\\"), !value.contains("\0") else {
            return false
        }
        return value.split(separator: "/", omittingEmptySubsequences: false).allSatisfy {
            $0 != "." && $0 != ".." && !$0.isEmpty
        }
    }

    static func isValidDigest(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    /// Validate one bundle resources directory against its inventory.
    /// - Parameter resourcesDirectory: `Contents/Resources` of the bundle.
    /// - Returns: `success` only when the on-disk file set equals the sealed
    ///   set and every file hashes to its recorded digest.
    public static func validate(resourcesDirectory: URL) async -> Result<Void, IntegrityError> {
        var rootStats = stat()
        guard lstat(resourcesDirectory.path, &rootStats) == 0 else {
            return .failure(.unreadable(resourcesDirectory.path))
        }
        if (rootStats.st_mode & S_IFMT) == S_IFLNK { return .failure(.symlink("Resources")) }
        guard (rootStats.st_mode & S_IFMT) == S_IFDIR else { return .failure(.specialFile("Resources")) }
        let inventoryURL = resourcesDirectory.appendingPathComponent("runtime-inventory.json")
        var inventoryStats = stat()
        guard lstat(inventoryURL.path, &inventoryStats) == 0 else { return .failure(.inventoryMissing) }
        if (inventoryStats.st_mode & S_IFMT) == S_IFLNK { return .failure(.symlink("runtime-inventory.json")) }
        if (inventoryStats.st_mode & S_IFMT) != S_IFREG { return .failure(.specialFile("runtime-inventory.json")) }
        if inventoryStats.st_nlink != 1 { return .failure(.hardlinked("runtime-inventory.json", UInt64(inventoryStats.st_nlink))) }
        guard let data = FrozenFileReader.read(inventoryURL, maximumBytes: 32 * 1024 * 1024) else {
            return .failure(.inventoryMalformed("inventory is unreadable or exceeds 32 MiB"))
        }
        let inventory: Inventory
        do {
            inventory = try JSONDecoder().decode(Inventory.self, from: data)
        } catch {
            return .failure(.inventoryMalformed(String(describing: error)))
        }
        guard inventory.version == 1, inventory.algorithm == "sha256", !inventory.files.isEmpty else {
            return .failure(.inventoryMalformed("unsupported version or algorithm"))
        }
        var sealed: [String: InventoryFile] = [:]
        for file in inventory.files {
            guard isValidInventoryPath(file.path), file.path != "runtime-inventory.json",
                  isValidDigest(file.sha256), file.size >= 0,
                  file.mode.count == 3, file.mode.allSatisfy({ ("0"..."7").contains($0) }) else {
                return .failure(.inventoryMalformed("invalid entry \(file.path)"))
            }
            guard sealed[file.path] == nil else {
                return .failure(.inventoryMalformed("duplicate path \(file.path)"))
            }
            sealed[file.path] = file
        }

        var seen: Set<String> = []
        if let error = await walkAndHash(resourcesDirectory, relativeDirectory: "", sealed: sealed, seen: &seen) {
            return .failure(error)
        }
        for path in sealed.keys where !seen.contains(path) {
            return .failure(.missingFile(path))
        }
        return .success(())
    }

    private static func walkAndHash(
        _ directory: URL,
        relativeDirectory: String,
        sealed: [String: InventoryFile],
        seen: inout Set<String>
    ) async -> IntegrityError? {
        let children: [URL]
        do {
            children = try FileManager.default.contentsOfDirectory(
                at: directory, includingPropertiesForKeys: nil, options: [])
        } catch {
            return .unreadable(directory.path)
        }
        for child in children.sorted(by: { $0.path < $1.path }) {
            if Task.isCancelled { return .cancelled }
            let relative = relativeDirectory.isEmpty
                ? child.lastPathComponent : relativeDirectory + "/" + child.lastPathComponent
            var stats = stat()
            guard lstat(child.path, &stats) == 0 else { return .unreadable(child.path) }
            if (stats.st_mode & S_IFMT) == S_IFLNK { return .symlink(String(relative)) }
            if (stats.st_mode & S_IFMT) == S_IFDIR {
                if let error = await walkAndHash(child, relativeDirectory: relative, sealed: sealed, seen: &seen) { return error }
                continue
            }
            if (stats.st_mode & S_IFMT) != S_IFREG { return .specialFile(String(relative)) }
            if stats.st_nlink != 1 { return .hardlinked(String(relative), UInt64(stats.st_nlink)) }
            if relative == "runtime-inventory.json" { continue }
            guard let recorded = sealed[String(relative)] else { return .extraFile(String(relative)) }
            if Int(stats.st_size) != recorded.size { return .sizeMismatch(String(relative)) }
            if UInt16(recorded.mode, radix: 8) != (stats.st_mode & 0o7777) { return .modeMismatch(relative) }
            guard let digest = streamSha256(child.path) else { return .unreadable(String(relative)) }
            if Task.isCancelled { return .cancelled }
            if digest != recorded.sha256 { return .hashMismatch(String(relative)) }
            seen.insert(String(relative))
        }
        return nil
    }

    private static func streamSha256(_ path: String) -> String? {
        let descriptor = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else { return nil }
        defer { close(descriptor) }
        var stats = stat()
        guard fstat(descriptor, &stats) == 0, (stats.st_mode & S_IFMT) == S_IFREG else { return nil }
        var hasher = SHA256()
        let bufferSize = 1 << 20
        let buffer = UnsafeMutableRawPointer.allocate(byteCount: bufferSize, alignment: MemoryLayout<UInt8>.alignment)
        defer { buffer.deallocate() }
        var consumed = 0
        while consumed < Int(stats.st_size) {
            if Task.isCancelled { return nil }
            let read = Darwin.read(descriptor, buffer, bufferSize)
            if read <= 0 {
                if errno == EINTR { continue }
                return nil
            }
            hasher.update(data: Data(bytes: buffer, count: read))
            consumed += read
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
