import Foundation

/// Confirms that the server behind the announced authenticated URL is the
/// announced server itself, before the launcher opens a browser. The probe
/// follows the upstream `BrowserAuth` contract exactly
/// (`packages/client/connection/src/browser-auth.ts`):
///
/// - `GET /` without a token and without a session cookie answers 401.
/// - `GET /?token=<launch token>` answers 303 and mints the session cookie.
///
/// Any other behavior — an unrelated 200, a 401 on both requests, a missing
/// token redirect — fails the probe, so a stranger's service on the same port
/// can never establish readiness on its own.
public struct AuthenticatedProbe {

    /// One probe attempt outcome, reported independently per defensive-patterns
    /// so a caller can name which half failed.
    public enum Outcome: Equatable {
        case confirmed
        case tokenRequestRejected(Int)
        case bareRequestAccepted(Int)
        case transportError(String)
    }

    private let session: URLSession

    /// - Parameter session: session used for both requests; defaults to a
    ///   cookie-free session (see `makeSession`). Pass a custom session in
    ///   tests; redirects are the session's responsibility.
    public init(session: URLSession? = nil) {
        self.session = session ?? AuthenticatedProbe.makeSession()
    }

    /// Builds the probe's session: redirects cancelled so the documented 303 is
    /// observable, and cookies disabled so the tokenized request's `set-cookie`
    /// can never leak into the parallel or retried bare request — a bare
    /// request carrying the minted cookie would answer like the browser and
    /// wrongly fail the 401 half of the contract.
    static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 2
        configuration.timeoutIntervalForResource = 4
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpCookieStorage = nil
        return URLSession(configuration: configuration, delegate: noRedirect, delegateQueue: nil)
    }

    /// Shared redirect-cancelled delegate for `makeSession` and test sessions.
    static let noRedirect: URLSessionTaskDelegate & NSObject = NoRedirect()

    /// Run one probe attempt.
    /// - Parameter url: the authenticated URL parsed from the readiness line.
    /// - Returns: the outcome; `confirmed` only when both requests match the contract.
    public func attempt(url: URL) async -> Outcome {
        var bareComponents = URLComponents(url: url, resolvingAgainstBaseURL: false)
        bareComponents?.query = nil
        guard let bareURL = bareComponents?.url else {
            return .transportError("authenticated URL has no valid origin")
        }

        async let bare = status(of: bareURL)
        async let tokenized = status(of: url)
        let bareStatus = await bare
        let tokenStatus = await tokenized

        switch (bareStatus, tokenStatus) {
        case let (.code(bare), .code(token)):
            if token != 303 { return .tokenRequestRejected(token) }
            if bare != 401 { return .bareRequestAccepted(bare) }
            return .confirmed
        case let (.failed(bareMessage), _):
            return .transportError("bare origin: \(bareMessage)")
        case let (_, .failed(tokenMessage)):
            return .transportError("tokenized URL: \(tokenMessage)")
        }
    }

    /// Request failures surface to the user through diagnostics, so the URL
    /// (which carries the token) is redacted before it leaves this type.
    private func status(of url: URL) async -> ResponseStatus {
        do {
            let (_, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse else {
                return .failed("non-HTTP response")
            }
            return .code(http.statusCode)
        } catch {
            return .failed(Redaction.redact(error.localizedDescription))
        }
    }

    private enum ResponseStatus {
        case code(Int)
        case failed(String)
    }

    private final class NoRedirect: NSObject, URLSessionTaskDelegate {
        func urlSession(
            _ session: URLSession,
            task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest,
            completionHandler: @escaping (URLRequest?) -> Void
        ) {
            completionHandler(nil)
        }
    }
}
