import Foundation
@testable import LauncherCore

/// Readiness-line classification, chunk reassembly, redaction, the capped
/// diagnostic log, and configuration validation.
@MainActor
struct ParsingTests {

    func run(_ t: TestRunner) {
        readinessLine(t)
        outputAssembler(t)
        redaction(t)
        diagnosticLog(t)
        launcherConfig(t)
    }

    private func readinessLine(_ t: TestRunner) {
        let url = ReadinessLine.scan("dsh web: http://127.0.0.1:3080/?token=abc_DEF-123")
        t.check(url == .ready(URL(string: "http://127.0.0.1:3080/?token=abc_DEF-123")!), "valid loopback token URL is ready")

        let lan = ReadinessLine.scan(
            "dsh web: http://127.0.0.1:3080/?token=abc (LAN: http://192.168.1.20:3080/?token=abc)")
        t.check(lan == .ready(URL(string: "http://127.0.0.1:3080/?token=abc")!), "LAN mirror suffix is stripped, loopback URL kept")

        invalid(t, "dsh web: http://127.0.0.1:3080/?token=abc (LAN: http://192.168.1.20:3080",
                "an unterminated LAN suffix is invalid, never ready")
        invalid(t, "dsh web: http://10.0.0.5:3080/?token=abc", "a non-loopback host is invalid")
        invalid(t, "dsh web: http://127.0.0.1:3080/", "a missing token is invalid")
        invalid(t, "dsh web: http://127.0.0.1:3080/?token=a&token=b", "a duplicate token is invalid")
        invalid(t, "dsh web: http://127.0.0.1:3080/?token=a&extra=1", "extra query items are invalid")
        invalid(t, "dsh web: http://user@127.0.0.1:3080/?token=a", "user info in the URL is invalid")
        invalid(t, "dsh web: http://127.0.0.1:3080/ui?token=a", "a non-root path is invalid")
        invalid(t, "dsh web: (LAN: http://127.0.0.1:3080/?token=a)", "a LAN-only dsh web line is never readiness")

        t.check(
            ReadinessLine.scan("dsh web: opening the default browser; pass --no-open to disable")
                == .status("opening the default browser; pass --no-open to disable"),
            "the browser-handoff line is status, never readiness")
        t.check(
            ReadinessLine.scan("listening on http://127.0.0.1:3080/?token=a") == .unrelated,
            "lines without the dsh web prefix are unrelated")
        t.check(
            ReadinessLine.origin(of: URL(string: "http://127.0.0.1:3080/?token=secret")!) == "http://127.0.0.1:3080",
            "the origin form drops the token")
    }

    private func invalid(_ t: TestRunner, _ line: String, _ label: String) {
        if case .invalid = ReadinessLine.scan(line) {
            t.check(true, label)
        } else {
            t.check(false, label)
        }
    }

    private func outputAssembler(_ t: TestRunner) {
        let assembler = OutputAssembler()
        t.check(assembler.ingest(Data("dsh web: http://127.0".utf8)).isEmpty, "no line is emitted before its newline")
        let split = assembler.ingest(Data(".0.1:3080/?token=ab\n".utf8))
        t.check(split == [.text("dsh web: http://127.0.0.1:3080/?token=ab")], "a chunk-split readiness line reassembles intact")

        let crlf = OutputAssembler()
        t.check(
            crlf.ingest(Data("dsh web: opening the default browser\r\nnoise\n".utf8))
                == [.text("dsh web: opening the default browser"), .text("noise")],
            "a CRLF terminator is stripped")

        let multibyte = OutputAssembler()
        let bytes = Array("注意\n".utf8)
        _ = multibyte.ingest(Data(bytes[0..<3]))
        t.check(multibyte.ingest(Data(bytes[3...])) == [.text("注意")], "multibyte characters split across chunks still decode")

        let oversized = OutputAssembler(maxLineBytes: 8)
        var truncated: [OutputAssembler.Line] = oversized.ingest(Data("1234567890ABCDEF\n".utf8))
        truncated += oversized.finish()
        guard case .truncated = truncated.first else {
            t.check(false, "an oversized line is reported truncated and dropped")
            return
        }
        t.check(
            !truncated.contains { if case let .text(text) = $0 { return text.contains("ABCDEF") } else { return false } },
            "truncated content is never emitted as text")
    }

    private func redaction(_ t: TestRunner) {
        let line = "GET http://127.0.0.1:3080/?token=s3cr3t ok"
        t.check(Redaction.redact(line) == "GET http://127.0.0.1:3080/?token=<redacted> ok", "the token query value is replaced")
        t.check(Redaction.redact(Redaction.redact(line)) == Redaction.redact(line), "redaction is idempotent")
        t.check(Redaction.redact("no secrets here") == "no secrets here", "plain lines pass through")
        t.check(
            Redaction.redact("url http://127.0.0.1:1/?token=abc&x=1") == "url http://127.0.0.1:1/?token=<redacted>&x=1",
            "redaction stops at the query separator")
        t.check(
            !Redaction.redact("token=secret token=secret2", secrets: ["secret2"]).contains("secret2"),
            "registered secrets are erased")

        let bounded = Redaction.loggable("token=verylongsecretvalue", maxCharacters: 10)
        t.check(bounded != nil && !bounded!.contains("verylongsecretvalue"), "bounded log lines redact before truncation")
        t.check(bounded?.count == 10, "the truncation marker respects a tiny limit")
        t.check(Redaction.loggable("token=secret", maxCharacters: 0) == nil, "zero limits emit nothing")
        t.check(Redaction.loggable("token=secret", maxCharacters: -1) == nil, "negative limits emit nothing")
        t.check(Redaction.loggable("   ") == nil, "empty loggable content is dropped")
    }

    private func diagnosticLog(_ t: TestRunner) {
        let root = TempDir.make("diag")
        defer { TempDir.remove(root) }
        let url = root.appendingPathComponent("launcher.log")
        let log = try! DiagnosticLog(url: url)
        log.write("dsh web: http://127.0.0.1:3080/?token=leaky-token")
        log.addSecret("leaky-token")
        log.write("after readiness token=leaky-token again")
        log.write("plain diagnostic")
        let content = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        t.check(!content.contains("leaky-token"), "the launch token never reaches disk")
        t.check(content.contains("plain diagnostic"), "diagnostics survive redaction")
        t.check(content.contains("token=<redacted>"), "token-bearing lines are redacted in place")
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        t.check((attributes?[.posixPermissions] as? NSNumber) == 0o600, "the log file is owner-only")

        let tinyURL = root.appendingPathComponent("tiny.log")
        let tiny = try! DiagnosticLog(url: tinyURL, maxBytes: 10)
        tiny.write("a line longer than the complete file budget")
        t.check((try! Data(contentsOf: tinyURL)).count <= 10, "the byte cap includes the overflow notice")

        let victim = root.appendingPathComponent("victim")
        try! Data("keep".utf8).write(to: victim)
        let alias = root.appendingPathComponent("alias.log")
        try! FileManager.default.createSymbolicLink(at: alias, withDestinationURL: victim)
        t.check((try? DiagnosticLog(url: alias)) == nil, "a symlink log destination is refused")
        t.check((try! String(contentsOf: victim)) == "keep", "a refused log leaves the target intact")
    }

    private func launcherConfig(_ t: TestRunner) {
        let root = TempDir.make("config")
        defer { TempDir.remove(root) }

        if case .failure(.missingResource) = LauncherConfig.load(from: root) {
            t.check(true, "a missing config file is reported, not guessed")
        } else {
            t.check(false, "a missing config file is reported, not guessed")
        }

        let malformedURL = root.appendingPathComponent("launcher-config.json")
        try! Data("{not json".utf8).write(to: malformedURL)
        if case .failure(.malformed) = LauncherConfig.load(from: root) {
            t.check(true, "a malformed config file is reported")
        } else {
            t.check(false, "a malformed config file is reported")
        }
        try? FileManager.default.removeItem(at: malformedURL)

        let node = root.appendingPathComponent("node")
        try! Data("#!/bin/sh\n".utf8).write(to: node)
        try! FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        let entry = root.appendingPathComponent("entry.sh")
        try! Data("#!/bin/sh\n".utf8).write(to: entry)
        try! FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: entry.path)

        let relative = LauncherConfig(projectDirectory: "rel", nodeExecutable: node.path, dshEntry: entry.path)
        checkValidation(t, relative.validate(), .notAbsolute("rel"), "non-absolute paths are rejected")

        let badNode = LauncherConfig(projectDirectory: root.path, nodeExecutable: root.path, dshEntry: entry.path)
        checkValidation(t, badNode.validate(), .nodeNotExecutable(root.path), "a non-executable node path is rejected")

        let missingEntry = root.appendingPathComponent("missing.sh").path
        let badEntry = LauncherConfig(projectDirectory: root.path, nodeExecutable: node.path, dshEntry: missingEntry)
        checkValidation(t, badEntry.validate(), .entryNotReadable(missingEntry), "a missing CLI entry is rejected")

        let valid = LauncherConfig(projectDirectory: root.path, nodeExecutable: node.path, dshEntry: entry.path)
        checkValidation(t, valid.validate(), nil, "a valid configuration validates")
        let nodeLink = root.appendingPathComponent("node-link")
        try! FileManager.default.createSymbolicLink(at: nodeLink, withDestinationURL: node)
        let linked = LauncherConfig(projectDirectory: root.path, nodeExecutable: nodeLink.path, dshEntry: entry.path)
        checkValidation(t, linked.validate(), nil, "a Homebrew-style symlink to a regular executable validates")
    }

    private func checkValidation(
        _ t: TestRunner,
        _ result: Result<Void, LauncherConfig.ConfigError>,
        _ expected: LauncherConfig.ConfigError?,
        _ label: String
    ) {
        if case .failure(let error) = result {
            t.check(error == expected, label)
        } else {
            t.check(expected == nil, label)
        }
    }
}
