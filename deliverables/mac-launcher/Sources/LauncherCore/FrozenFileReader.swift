import Darwin
import Foundation

/// Reads bounded regular metadata files without following a final symlink or
/// waiting for a FIFO writer. Callers own the JSON schema and error message.
enum FrozenFileReader {

    /// Largest `frozen-launcher-config.json` accepted: small build metadata.
    public static let maximumConfigBytes = 64 * 1024

    /// Largest `runtime-inventory.json` accepted. A real frozen payload seals
    /// tens of thousands of files, which exceeds the config bound, so the
    /// inventory read bound matches the validator's 32 MiB inventory limit.
    public static let maximumInventoryBytes = 32 * 1024 * 1024

    static func read(_ url: URL, maximumBytes: Int) -> Data? {
        let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else { return nil }
        defer { close(descriptor) }
        var stats = stat()
        guard fstat(descriptor, &stats) == 0,
              (stats.st_mode & S_IFMT) == S_IFREG, stats.st_nlink == 1,
              stats.st_size >= 0, stats.st_size <= maximumBytes else { return nil }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            if count == 0 { return data }
            if count < 0 {
                if errno == EINTR { continue }
                return nil
            }
            guard data.count + count <= maximumBytes else { return nil }
            data.append(contentsOf: buffer.prefix(count))
        }
    }
}
