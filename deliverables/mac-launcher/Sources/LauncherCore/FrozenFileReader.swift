import Darwin
import Foundation

/// Reads bounded regular metadata files without following a final symlink or
/// waiting for a FIFO writer. Callers own the JSON schema and error message.
enum FrozenFileReader {
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
