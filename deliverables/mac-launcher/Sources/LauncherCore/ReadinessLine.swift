import Foundation

/// Parser for the readiness lines the `dsh web` backend prints on stdout after
/// its Loader tree settles (`packages/bundle/web-app/src/index.ts`):
/// `dsh web: <authenticatedUrl>` optionally followed by ` (LAN: <url>)`.
/// A separate stdout line announces the browser handoff and is never readiness.
///
/// A parsed URL grants browser-open rights only when it is the announced
/// loopback server carrying the launch token as its sole query item; anything
/// else must not reach `NSWorkspace.open`.
public enum ReadinessLine {

    /// Classification of one decoded output line.
    public enum Scan: Equatable {
        /// A validated loopback authenticated URL. Safe to open and to hold in memory.
        case ready(URL)
        /// A `dsh web:` line that carries status text, not a URL (for example the
        /// `opening the default browser` notice). Never establishes readiness.
        case status(String)
        /// A `dsh web:` line that announced a URL which failed validation
        /// (non-loopback host, missing/duplicate token, unexpected query or path).
        case invalid(String)
        /// A line from another source; ignored for readiness.
        case unrelated
    }

    /// Exact prefix the backend prints before the URL and status lines.
    public static let prefix = "dsh web: "

    /// Marker that separates the LAN mirror URL from the loopback URL.
    static let lanSeparator = " (LAN: "

    /// Hosts that resolve to this machine. The announced server binds loopback
    /// (`--host 0.0.0.0` is rejected upstream), so any other host fails validation.
    static let loopbackHosts: Set<String> = ["127.0.0.1", "::1", "localhost"]

    /// Classify one complete output line.
    /// - Parameter line: one decoded line without its terminator.
    /// - Returns: the scan result; `invalid` carries the failed URL text.
    public static func scan(_ line: String) -> Scan {
        guard line.hasPrefix(prefix) else { return .unrelated }
        let remainder = String(line.dropFirst(prefix.count))
        guard !remainder.hasPrefix("(LAN:") else { return .invalid(remainder) }

        // Strip the optional LAN mirror. The mirror URL carries the same token and
        // is never opened by the launcher; only its presence is validated.
        var urlText = remainder
        if let lanRange = remainder.range(of: lanSeparator) {
            let afterSeparator = remainder[lanRange.upperBound...]
            guard afterSeparator.hasSuffix(")"), afterSeparator.count > 1 else {
                return .invalid(remainder)
            }
            urlText = String(remainder[..<lanRange.lowerBound])
        }

        guard urlText.hasPrefix("http://") || urlText.hasPrefix("https://") else {
            return .status(remainder)
        }
        guard let url = validatedURL(urlText) else { return .invalid(urlText) }
        return .ready(url)
    }

    /// Validate the announced URL against the upstream `authenticatedUrl` contract:
    /// http scheme, loopback host, root path, and the launch token as the only
    /// query item. Credentials in the URL are rejected.
    static func validatedURL(_ text: String) -> URL? {
        guard let components = URLComponents(string: text),
              components.scheme == "http",
              let host = components.host?.lowercased(),
              loopbackHosts.contains(host),
              components.path == "/",
              components.user == nil,
              components.password == nil
        else { return nil }

        let items = components.queryItems ?? []
        guard items.count == 1,
              let token = items.first,
              token.name == "token",
              let value = token.value,
              !value.isEmpty
        else { return nil }
        return components.url
    }

    /// The scheme/host/port of an authenticated URL, without its query: the UI
    /// shows the origin only, never the token.
    public static func origin(of url: URL) -> String {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        components?.query = nil
        components?.fragment = nil
        components?.path = ""
        return components?.url?.absoluteString ?? ""
    }
}
