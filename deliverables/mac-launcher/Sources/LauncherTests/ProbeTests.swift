import Foundation
import Network
@testable import LauncherCore

/// Minimal loopback HTTP server for probe tests. Binds 127.0.0.1 on an
/// OS-assigned port (never a scanned or fixed one), serves one request per
/// connection from a scripted handler, and cancels every connection on stop.
final class HTTPTestServer {

    /// Default behavior mirroring the upstream `BrowserAuth` contract: bare
    /// requests without a cookie get 401, bare requests carrying a session
    /// cookie get 200 (the browser's authenticated index), and the tokenized
    /// root gets 303 plus a `set-cookie` header.
    static func browserAuthHandler(token: String) -> (String, String?) -> (Int, [String: String], Data) {
        { target, cookie in
            if target.contains("token=\(token)") {
                return (303, ["set-cookie": "dsh-session=fake", "location": "/"], Data())
            }
            if cookie != nil {
                return (200, [:], Data("index".utf8))
            }
            return (401, [:], Data("dsh web authentication required\n".utf8))
        }
    }

    private let listener: NWListener
    private let queue = DispatchQueue(label: "launcher-tests.http")
    private let ready = DispatchSemaphore(value: 0)
    private var connections: [NWConnection] = []
    private(set) var port = 0
    var handler: ((String, String?) -> (Int, [String: String], Data))!

    init() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        parameters.allowLocalEndpointReuse = true
        listener = try NWListener(using: parameters, on: .any)
    }

    func start() throws {
        let readySemaphore = ready
        listener.stateUpdateHandler = { [weak self] state in
            guard let self, case .ready = state else { return }
            self.port = Int(self.listener.port?.rawValue ?? 0)
            readySemaphore.signal()
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 10) == .success, port > 0 else {
            listener.cancel()
            throw NSError(domain: "launcher-tests", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "test server did not become ready"])
        }
    }

    func stop() {
        listener.cancel()
        queue.sync {
            connections.forEach { $0.cancel() }
            connections.removeAll()
        }
    }

    private func accept(_ connection: NWConnection) {
        connections.append(connection)
        connection.stateUpdateHandler = { state in
            if case .failed = state { connection.cancel() }
        }
        connection.start(queue: queue)
        receiveRequest(connection, accumulated: Data())
    }

    private func receiveRequest(_ connection: NWConnection, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, complete, error in
            guard let self, error == nil else {
                connection.cancel()
                return
            }
            var buffer = accumulated
            if let data { buffer.append(data) }
            guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else {
                guard !complete, buffer.count < 64 * 1024 else { connection.cancel(); return }
                self.receiveRequest(connection, accumulated: buffer)
                return
            }
            let headerText = String(decoding: buffer[..<headerEnd.lowerBound], as: UTF8.self)
            let lines = headerText.components(separatedBy: "\r\n")
            let requestLine = lines.first?.split(separator: " ") ?? []
            let target = requestLine.count > 1 ? String(requestLine[1]) : "/"
            let cookie = lines.first(where: { $0.lowercased().hasPrefix("cookie:") })?
                .dropFirst("cookie:".count)
                .trimmingCharacters(in: .whitespaces)
            let (status, headers, body) = self.handler(target, cookie?.isEmpty == false ? cookie : nil)
            let reason = status == 200 ? "OK" : status == 303 ? "See Other" : "Unauthorized"
            var response = "HTTP/1.1 \(status) \(reason)\r\ncontent-length: \(body.count)\r\n"
            for (name, value) in headers { response += "\(name): \(value)\r\n" }
            response += "\r\n"
            var payload = Data(response.utf8)
            payload.append(body)
            connection.send(content: payload, completion: .contentProcessed { _ in
                connection.cancel()
            })
        }
    }
}

/// The probe contract against a scripted upstream: bare 401, tokenized 303,
/// cookie-free retries, and redacted transport failures.
@MainActor
struct ProbeTests {

    func run(_ t: TestRunner) {
        contract(t)
        cookieRegression(t)
        transportFailureRedaction(t)
    }

    private func startServer(t: TestRunner) -> (HTTPTestServer, String)? {
        guard let server = try? HTTPTestServer() else {
            t.check(false, "the loopback test server starts on an OS-assigned port")
            return nil
        }
        let token = "tok-\(UUID().uuidString)"
        server.handler = HTTPTestServer.browserAuthHandler(token: token)
        do {
            try server.start()
        } catch {
            t.check(false, "the loopback test server starts on an OS-assigned port")
            server.stop()
            return nil
        }
        t.check(server.port > 0, "the loopback test server starts on an OS-assigned port")
        return (server, token)
    }

    private func contract(_ t: TestRunner) {
        guard let (server, token) = startServer(t: t) else { return }
        defer { server.stop() }
        let probe = AuthenticatedProbe()
        let url = URL(string: "http://127.0.0.1:\(server.port)/?token=\(token)")!
        t.check(attempt(probe, url, t) == .confirmed, "bare 401 plus tokenized 303 confirms the announced server")
    }

    /// Regression control: with a cookie-storing session the tokenized
    /// request's `set-cookie` leaks into the retried bare request, the bare
    /// request answers like the browser, and the probe wrongly fails. The
    /// shipped cookie-free session must survive repeated attempts.
    private func cookieRegression(_ t: TestRunner) {
        guard let (server, token) = startServer(t: t) else { return }
        defer { server.stop() }
        let url = URL(string: "http://127.0.0.1:\(server.port)/?token=\(token)")!

        let leakingProbe = AuthenticatedProbe(
            session: URLSession(configuration: URLSessionConfiguration.ephemeral,
                                delegate: AuthenticatedProbe.noRedirect,
                                delegateQueue: nil))
        _ = attempt(leakingProbe, url, t)
        t.check(attempt(leakingProbe, url, t) == .bareRequestAccepted(200),
                "control: a cookie-storing session turns the retried bare request into 200")

        let probe = AuthenticatedProbe()
        t.check(attempt(probe, url, t) == .confirmed, "the shipped probe confirms again after the first attempt")
        t.check(attempt(probe, url, t) == .confirmed, "the shipped probe confirms on a later retry")
        t.check(attempt(probe, url, t) == .confirmed, "the shipped probe never accumulates cookie state")
    }

    private func transportFailureRedaction(_ t: TestRunner) {
        let token = "tok-\(UUID().uuidString)"
        let url = URL(string: "http://127.0.0.1:1/?token=\(token)")!
        let probe = AuthenticatedProbe()
        guard case let .transportError(message) = attempt(probe, url, t) else {
            t.check(false, "a closed port reports a transport error")
            return
        }
        t.check(!message.contains(token), "transport failures never carry the token")
    }

    /// Parks the main actor on the run loop until the async attempt settles.
    private func attempt(_ probe: AuthenticatedProbe, _ url: URL, _ t: TestRunner) -> AuthenticatedProbe.Outcome {
        let box = OutcomeBox()
        let semaphore = DispatchSemaphore(value: 0)
        Task.detached {
            box.value = await probe.attempt(url: url)
            semaphore.signal()
        }
        if !t.drainUntil(semaphore, timeout: 15) {
            return .transportError("probe attempt timed out")
        }
        return box.value ?? .transportError("probe attempt produced no outcome")
    }

    private final class OutcomeBox: @unchecked Sendable {
        var value: AuthenticatedProbe.Outcome?
    }
}
