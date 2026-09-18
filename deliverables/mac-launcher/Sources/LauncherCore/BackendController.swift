import Foundation

/// Owns the single backend child process this launcher started. The controller
/// never touches processes it did not create: no port scanning, no
/// command-line matching, no killing by PID. On a collision or an orphan it
/// reports; only its own child is ever signalled.
///
/// All mutable state is confined to the main actor. Pipe reads and the child's
/// termination handler only marshal raw data onto the main queue, so no
/// lifecycle state is touched from a background thread and no wait loop blocks
/// the UI thread.
@MainActor
public final class BackendController {

    /// Which runtime a controller launches. `sourceLinked` runs a configured
    /// checkout's built CLI; `frozen` runs the bundle's materialized runtime
    /// copy after its integrity has been validated.
    public enum LaunchMode {
        case sourceLinked(LauncherConfig)
        case frozen(FrozenLauncherConfig.Resolved)
    }

    /// Integrity validation for a frozen launch; injectable for tests.
    public typealias IntegrityValidator =
        @Sendable (URL) async -> Result<Void, RuntimeIntegrityValidator.IntegrityError>

    /// Lifecycle phase; the UI maps these to status text.
    public enum Phase: Equatable {
        case idle
        case starting
        /// Frozen builds only: the materialized runtime is being validated
        /// before the bundled Node may start.
        case validating
        case running
        case stopping
        case failed(String)
    }

    /// How long teardown waits for the child to exit after SIGTERM before
    /// escalating to SIGKILL. The upstream CLI forces its own exit five seconds
    /// after SIGTERM (`apps/cli` `PROCESS_SHUTDOWN_TIMEOUT_MS`); this bound
    /// stays above that window so the launcher never kills inside the CLI's
    /// own grace. A technical process bound, not a product setting.
    public nonisolated static let defaultTerminationGrace: TimeInterval = 6.0

    /// Diagnostic bound on unconfirmed startup. The child stays alive and
    /// cancellable the whole time; crossing the bound tears the owned child
    /// down and reports. A technical bound, not a product setting.
    public nonisolated static let defaultStartupTimeout: TimeInterval = 60.0

    /// Readiness probe attempts and spacing: the URL line is printed only after
    /// Loader settlement, so a short bounded window covers slow first answers.
    static let probeAttempts = 10
    static let probeRetryInterval: TimeInterval = 0.3

    /// Redacted output lines kept for failure diagnostics.
    static let diagnosticLineHistory = 20

    /// Extra seconds after SIGKILL before teardown completes unconfirmed, so a
    /// wedged child can never strand the user at quit.
    static let killConfirmationBackstop: TimeInterval = 3.0

    public private(set) var phase: Phase = .idle

    /// The validated authenticated URL announced by this launcher's own child,
    /// held in memory only while the child is managed. Never written to disk
    /// and never placed in status text; cleared whenever the child is gone.
    public private(set) var authenticatedURL: URL?

    /// Internal state; `stopping` carries a failure to report after the child
    /// is gone, keeping "child died" and "validation refused" independent.
    private enum State {
        case idle
        case starting
        case running
        case stopping(pendingFailure: String?)
        case failed(String)
    }

    /// What `pollStop` should do next; extracted so the SIGKILL escalation and
    /// the unconfirmed-teardown report are unit-testable without a child that
    /// can survive SIGKILL.
    enum TeardownAction: Equatable {
        case wait
        case kill
        case confirmUnconfirmed
    }

    /// Decision rule for teardown polling. A child that is no longer running
    /// is always `wait`: its termination handler owns the completion, and the
    /// process identifier of an exited (possibly reaped) child is never
    /// signalled again.
    static func teardownAction(
        elapsed: TimeInterval,
        childRunning: Bool,
        didSendKill: Bool,
        grace: TimeInterval,
        backstop: TimeInterval
    ) -> TeardownAction {
        if !childRunning { return .wait }
        if !didSendKill && elapsed >= grace { return .kill }
        if didSendKill && elapsed >= grace + backstop { return .confirmUnconfirmed }
        return .wait
    }

    private var state: State = .idle
    private let mode: LaunchMode
    private let integrityValidator: IntegrityValidator
    private let diagnosticLog: DiagnosticLog?
    private let probe: AuthenticatedProbe?
    private let workingDirectory: URL
    private let dshHomeOverride: URL?
    private let environmentSource: [String: String]?
    private let terminationGrace: TimeInterval
    private let startupTimeout: TimeInterval
    private let onPhaseChange: (Phase) -> Void

    private var child: Process?
    private var lease: RecoveryLease?
    private var stdoutAssembler = OutputAssembler()
    private var stderrAssembler = OutputAssembler()
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?
    private var recentLines: [String] = []
    private var droppedLineCount = 0
    private var probeGeneration = 0
    private var pollTask: Task<Void, Never>?
    private var startupDeadlineTask: Task<Void, Never>?
    private var validationTask: Task<Void, Never>?
    private var launchGeneration = 0
    private var stopCompletions: [() -> Void] = []
    private var stopStartedAt: Date?
    private var didSendKill = false
    private var didReportUnconfirmedStop = false

    /// - Parameters:
    ///   - mode: which runtime to launch; see `LaunchMode`.
    ///   - diagnosticLog: redacted, capped diagnostics; `nil` keeps diagnostics in memory only.
    ///   - probe: HTTP confirmation of the announced server; `nil` skips it (tests).
    ///   - workingDirectory: child working directory for source-linked launches.
    ///     Frozen launches use their recorded trial home to avoid loading a
    ///     `.env` from the user's home or a source checkout.
    ///   - dshHomeOverride: explicit `DSH_HOME` for the child's harness data
    ///     (default `~/.dsh`). Source-linked builds only; test isolation only:
    ///     supplied by the caller, used as-is, and never seeded with the
    ///     user's existing data. `nil` passes the environment through
    ///     untouched. A frozen build always uses the home recorded in its
    ///     configuration instead.
    ///   - integrityValidator: frozen-launch integrity check; injectable for tests.
    ///   - environmentSource: the environment a frozen child is scrubbed from;
    ///     `nil` means this process's current environment. Injectable for tests.
    ///   - terminationGrace: teardown grace before SIGKILL; injectable for tests.
    ///   - startupTimeout: diagnostic bound on unconfirmed startup; injectable for tests.
    ///   - onPhaseChange: called on the main actor after every phase change.
    public init(
        mode: LaunchMode,
        diagnosticLog: DiagnosticLog?,
        probe: AuthenticatedProbe?,
        workingDirectory: URL,
        dshHomeOverride: URL? = nil,
        integrityValidator: @escaping IntegrityValidator = { await RuntimeIntegrityValidator.validate(resourcesDirectory: $0) },
        environmentSource: [String: String]? = nil,
        terminationGrace: TimeInterval = BackendController.defaultTerminationGrace,
        startupTimeout: TimeInterval = BackendController.defaultStartupTimeout,
        onPhaseChange: @escaping (Phase) -> Void
    ) {
        self.mode = mode
        self.integrityValidator = integrityValidator
        self.diagnosticLog = diagnosticLog
        self.probe = probe
        self.workingDirectory = workingDirectory
        self.dshHomeOverride = dshHomeOverride
        self.environmentSource = environmentSource
        self.terminationGrace = terminationGrace
        self.startupTimeout = startupTimeout
        self.onPhaseChange = onPhaseChange
    }

    /// Source-linked controller: runs the configured checkout's built CLI.
    public convenience init(
        config: LauncherConfig,
        diagnosticLog: DiagnosticLog?,
        probe: AuthenticatedProbe?,
        workingDirectory: URL,
        dshHomeOverride: URL? = nil,
        terminationGrace: TimeInterval = BackendController.defaultTerminationGrace,
        startupTimeout: TimeInterval = BackendController.defaultStartupTimeout,
        onPhaseChange: @escaping (Phase) -> Void
    ) {
        self.init(
            mode: .sourceLinked(config),
            diagnosticLog: diagnosticLog,
            probe: probe,
            workingDirectory: workingDirectory,
            dshHomeOverride: dshHomeOverride,
            terminationGrace: terminationGrace,
            startupTimeout: startupTimeout,
            onPhaseChange: onPhaseChange)
    }

    /// Frozen controller: runs the bundle's materialized runtime after
    /// validating its integrity.
    public convenience init(
        frozen: FrozenLauncherConfig.Resolved,
        diagnosticLog: DiagnosticLog?,
        probe: AuthenticatedProbe?,
        workingDirectory: URL,
        integrityValidator: @escaping IntegrityValidator = { await RuntimeIntegrityValidator.validate(resourcesDirectory: $0) },
        environmentSource: [String: String]? = nil,
        terminationGrace: TimeInterval = BackendController.defaultTerminationGrace,
        startupTimeout: TimeInterval = BackendController.defaultStartupTimeout,
        onPhaseChange: @escaping (Phase) -> Void
    ) {
        self.init(
            mode: .frozen(frozen),
            diagnosticLog: diagnosticLog,
            probe: probe,
            workingDirectory: workingDirectory,
            dshHomeOverride: nil,
            integrityValidator: integrityValidator,
            environmentSource: environmentSource,
            terminationGrace: terminationGrace,
            startupTimeout: startupTimeout,
            onPhaseChange: onPhaseChange)
    }

    /// Spawn the backend child. Reports a failure phase when the configuration
    /// no longer validates or the child cannot start.
    public func start() {
        guard case .idle = state, child == nil else {
            log("ignoring start: teardown in flight, unconfirmed, or a child is already managed")
            return
        }
        state = .starting
        launchGeneration += 1
        droppedLineCount = 0
        recentLines = []

        switch mode {
        case let .sourceLinked(config):
            switch config.validate() {
            case let .failure(error):
                reportFailure(describe(error), exitCode: nil)
                return
            case .success:
                break
            }
            // HOME stays the current user's home. DSH_HOME is the harness data
            // home (upstream default ~/.dsh), not UNIX HOME: it is overridden
            // only when an explicit test-isolation value was supplied. The
            // launcher passes --no-open (packages/bundle/web-app startup flag)
            // so only the launcher opens the browser, from the validated
            // in-memory URL.
            var environment = ProcessInfo.processInfo.environment
            if let dshHomeOverride {
                environment["DSH_HOME"] = dshHomeOverride.path
            }
            spawn(
                executablePath: config.nodeExecutable,
                arguments: [config.dshEntry, "web", "--no-open"],
                environment: environment)
        case let .frozen(launch):
            switch launch.config.validate(resolved: launch) {
            case let .failure(error):
                reportFailure(LauncherCopy.frozenConfigInvalid(describeFrozenConfig(error)), exitCode: nil)
                return
            case .success:
                break
            }
            // Both frozen launchers and recovery Apps exclude each other from
            // the same data home before payload validation or spawn: the
            // OS lease fails here, before a child can exist. It is held until
            // teardown has fully settled so a stale validation can never
            // reopen the data home after a quit.
            switch RecoveryLease.acquire(dataHome: launch.dshHomeURL) {
            case let .failure(error):
                reportFailure(Self.describeLease(error), exitCode: nil)
                return
            case let .success(acquired):
                lease = acquired
            }
            // The bundled Node must never start before its payload validated.
            // The integrity scan runs off the main actor; only the settle hop
            // touches lifecycle state, and a stale result is discarded.
            setPhase(.validating)
            let generation = launchGeneration
            let validator = integrityValidator
            let resources = launch.resourcesDirectory
            validationTask = Task { [weak self] in
                let result = await validator(resources)
                self?.validationSettled(result, generation: generation)
            }
        }
    }

    /// Create and own the backend child process. Runs only after the mode's
    /// configuration (and, for frozen builds, the integrity validation) passed.
    private func spawn(executablePath: String, arguments: [String], environment: [String: String]) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executablePath)
        if case let .frozen(launch) = mode {
            process.currentDirectoryURL = launch.dshHomeURL
        } else {
            process.currentDirectoryURL = workingDirectory
        }
        process.arguments = arguments
        process.environment = environment
        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        // Handlers run off the main actor; only the main-queue hop touches
        // lifecycle state.
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async { self?.childDidExit(process) }
        }
        outPipe.fileHandleForReading.readabilityHandler = Self.readabilityHandler { [weak self, weak process] data in
            DispatchQueue.main.async {
                guard let process, self?.child === process else { return }
                self?.ingest(data, isStdout: true)
            }
        }
        errPipe.fileHandleForReading.readabilityHandler = Self.readabilityHandler { [weak self, weak process] data in
            DispatchQueue.main.async {
                guard let process, self?.child === process else { return }
                self?.ingest(data, isStdout: false)
            }
        }

        do {
            try process.run()
        } catch {
            outPipe.fileHandleForReading.readabilityHandler = nil
            errPipe.fileHandleForReading.readabilityHandler = nil
            reportFailure(LauncherCopy.spawnFailed(error.localizedDescription), exitCode: nil)
            return
        }

        child = process
        stdoutPipe = outPipe
        stderrPipe = errPipe
        armStartupDeadline()
        log("backend child started: pid \(process.processIdentifier)")
        setPhase(.starting)
    }

    /// Settle one integrity validation. A result is applied only when it is
    /// still the current launch: a stop, restart, or teardown that happened
    /// while the scan ran discards it.
    private func validationSettled(
        _ result: Result<Void, RuntimeIntegrityValidator.IntegrityError>,
        generation: Int
    ) {
        validationTask = nil
        guard generation == launchGeneration, case .starting = state, child == nil else {
            log("discarding a stale integrity result (generation \(generation))")
            return
        }
        switch result {
        case let .failure(error):
            reportFailure(LauncherCopy.integrityFailed(describe(error)), exitCode: nil)
        case .success:
            guard case let .frozen(launch) = mode else { return }
            if case let .failure(error) = launch.config.validate(resolved: launch) {
                reportFailure(LauncherCopy.frozenConfigInvalid(describeFrozenConfig(error)), exitCode: nil)
                return
            }
            log("runtime integrity validated; starting the bundled backend")
            spawn(
                executablePath: launch.nodeURL.path,
                arguments: Self.frozenLaunchArguments(
                    dshEntryPath: launch.dshEntryURL.path,
                    patchPath: launch.patchURL.path),
                environment: FrozenEnvironment.childEnvironment(
                    dshHome: launch.config.dshHome,
                    source: environmentSource ?? ProcessInfo.processInfo.environment))
        }
    }

    /// Arguments for a frozen launch: the normal `dsh web --no-open` startup
    /// plus the bundled immutable overlay, passed through the ordinary dsh
    /// launch arguments (never by editing the user's configuration).
    static func frozenLaunchArguments(dshEntryPath: String, patchPath: String) -> [String] {
        [dshEntryPath, "web", "--patch", patchPath, "--no-open"]
    }

    private static func describeLease(_ error: RecoveryLease.LeaseError) -> String {
        switch error {
        case .unavailable: return LauncherCopy.backendLeaseBusy
        case let .cannotLock(detail): return LauncherCopy.backendLeaseCannotLock(Redaction.redact(detail))
        }
    }

    private func cancelValidation() {
        validationTask?.cancel()
        validationTask = nil
    }

    /// Whether the launcher still owes teardown of its owned child (the child
    /// is starting, running, or a stop is in flight). The App quits only after
    /// a `stop` completion runs.
    public var requiresTeardown: Bool {
        switch state {
        case .starting, .running, .stopping: return true
        case .idle, .failed: return false
        }
    }

    /// Stop the child and wait for its exit without blocking the caller.
    /// Idempotent and coalescing: repeated calls join the in-flight teardown.
    /// SIGTERM first; SIGKILL only after the declared grace bound, and only
    /// for the direct child this launcher created.
    /// - Parameter completion: runs on the main actor once the child has exited
    ///   — or, for source-linked launches, when the backstop reports teardown
    ///   unconfirmed. Frozen launches keep their data lease and wait for exit.
    public func stop(completion: @escaping () -> Void = {}) {
        stopCompletions.append(completion)
        switch state {
        case .idle, .failed:
            // Nothing owned is running; complete immediately.
            runStopCompletions()
        case .stopping:
            break
        case .starting, .running:
            beginTeardown(pendingFailure: nil)
        }
    }

    // MARK: - Child output

    private static func readabilityHandler(
        _ deliver: @escaping @Sendable (Data) -> Void
    ) -> @Sendable (FileHandle) -> Void {
        { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            deliver(data)
        }
    }

    private func ingest(_ data: Data, isStdout: Bool) {
        let lines = isStdout ? stdoutAssembler.ingest(data) : stderrAssembler.ingest(data)
        for line in lines {
            handle(line, isStdout: isStdout)
        }
    }

    private func handle(_ line: OutputAssembler.Line, isStdout: Bool) {
        switch line {
        case let .text(text):
            record(text)
            guard isStdout, case .starting = state else { return }
            switch ReadinessLine.scan(text) {
            case .unrelated:
                break
            case let .status(text):
                log("backend status: \(text)")
            case let .invalid(text):
                // The child is alive but announced something the launcher
                // refuses to open; tear the owned child down, then report.
                beginTeardown(pendingFailure: LauncherCopy.readinessInvalid(Redaction.redact(text)))
            case let .ready(url):
                readinessAnnounced(url)
            }
        case .truncated:
            droppedLineCount += 1
            log("dropped an oversized output line")
        }
    }

    private func record(_ text: String) {
        let redacted = Redaction.redact(text)
        log(redacted)
        recentLines.append(redacted)
        if recentLines.count > Self.diagnosticLineHistory {
            recentLines.removeFirst(recentLines.count - Self.diagnosticLineHistory)
        }
    }

    private func readinessAnnounced(_ url: URL) {
        guard case .starting = state, authenticatedURL == nil, let child, child.isRunning else { return }
        authenticatedURL = url
        if let token = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "token" })?.value {
            diagnosticLog?.addSecret(token)
        }
        log("readiness line accepted; confirming the announced server")
        guard probe != nil else {
            becomeRunning()
            return
        }
        confirmWithProbe(url, generation: probeGeneration, remainingAttempts: Self.probeAttempts)
    }

    private func becomeRunning() {
        startupDeadlineTask?.cancel()
        startupDeadlineTask = nil
        state = .running
        setPhase(.running)
    }

    private func confirmWithProbe(_ url: URL, generation: Int, remainingAttempts: Int) {
        guard case .starting = state, generation == probeGeneration, let probe else { return }
        Task { [weak self] in
            let outcome = await probe.attempt(url: url)
            self?.probeAttemptSettled(outcome, url: url, generation: generation, remainingAttempts: remainingAttempts)
        }
    }

    private func probeAttemptSettled(
        _ outcome: AuthenticatedProbe.Outcome, url: URL, generation: Int, remainingAttempts: Int
    ) {
        guard case .starting = state, generation == probeGeneration else { return }
        if outcome == .confirmed {
            becomeRunning()
            return
        }
        guard remainingAttempts > 0 else {
            beginTeardown(pendingFailure: LauncherCopy.probeRejected(describe(outcome)))
            return
        }
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.probeRetryInterval * 1_000_000_000))
            self?.confirmWithProbe(url, generation: generation, remainingAttempts: remainingAttempts - 1)
        }
    }

    private func armStartupDeadline() {
        startupDeadlineTask?.cancel()
        let timeout = startupTimeout
        startupDeadlineTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.startupDeadlineReached()
        }
    }

    private func startupDeadlineReached() {
        guard case .starting = state else { return }
        log("startup deadline of \(Int(startupTimeout))s reached without readiness; tearing own child down")
        beginTeardown(pendingFailure: LauncherCopy.startupTimedOut(seconds: Int(startupTimeout)))
    }

    // MARK: - Exit and teardown

    private func childDidExit(_ process: Process) {
        guard child === process else { return }
        let statusText = LauncherCopy.exitDescription(
            reason: process.terminationReason, code: process.terminationStatus)
        child = nil
        closeStreams()

        switch state {
        case let .stopping(pendingFailure):
            let elapsed = stopStartedAt.map { Date().timeIntervalSince($0) } ?? 0
            log(String(format: "own child exited %.1fs after SIGTERM (kill escalated: %@)",
                       elapsed, didSendKill ? "yes" : "no"))
            finishTeardown(pendingFailure: pendingFailure)
        case .starting:
            reportFailure(LauncherCopy.exitedBeforeReadiness(statusText), exitCode: Int(process.terminationStatus))
        case .running:
            // A crash after readiness must never leave the green status or a
            // stale authenticated URL on screen.
            reportFailure(LauncherCopy.exitedWhileRunning(statusText), exitCode: Int(process.terminationStatus))
        case .idle, .failed:
            // An exit after a reported failure or outside a managed run is
            // already accounted for.
            break
        }
    }

    private func beginTeardown(pendingFailure: String?) {
        probeGeneration += 1
        startupDeadlineTask?.cancel()
        startupDeadlineTask = nil
        cancelValidation()
        state = .stopping(pendingFailure: pendingFailure)
        setPhase(.stopping)
        stopStartedAt = Date()
        didSendKill = false
        didReportUnconfirmedStop = false
        if let child, child.isRunning {
            log("sending SIGTERM to own child pid \(child.processIdentifier)")
            child.terminate()
            startPolling()
        } else {
            // Nothing owned is running (a frozen validation was still in
            // flight); the cancelled scan owns no process, so teardown is
            // already complete.
            finishTeardown(pendingFailure: pendingFailure)
        }
    }

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while let self, case .stopping = self.state {
                try? await Task.sleep(nanoseconds: 50_000_000)
                self.pollStop()
            }
        }
    }

    private func pollStop() {
        guard let child, let stopStartedAt else { return }
        let elapsed = Date().timeIntervalSince(stopStartedAt)
        switch Self.teardownAction(
            elapsed: elapsed,
            childRunning: child.isRunning,
            didSendKill: didSendKill,
            grace: terminationGrace,
            backstop: Self.killConfirmationBackstop
        ) {
        case .wait:
            return
        case .kill:
            didSendKill = true
            log("teardown grace of \(Int(terminationGrace))s elapsed; sending SIGKILL to own child")
            kill(child.processIdentifier, SIGKILL)
        case .confirmUnconfirmed:
            reportUnconfirmedStop()
        }
    }

    /// Report the stop backstop without releasing a frozen data-home lease.
    /// The termination handler still owns completion if exit arrives later.
    func reportUnconfirmedStop() {
        guard case .stopping = state, !didReportUnconfirmedStop else { return }
        didReportUnconfirmedStop = true
        log("no exit observed after SIGKILL; teardown remains unconfirmed")
        if case .frozen = mode {
            authenticatedURL = nil
            state = .stopping(pendingFailure: currentPendingFailure() ?? LauncherCopy.frozenTeardownUnconfirmed)
            setPhase(.failed(LauncherCopy.frozenTeardownUnconfirmed))
        } else {
            finishTeardown(pendingFailure: currentPendingFailure() ?? LauncherCopy.teardownUnconfirmed)
        }
    }

    private func finishTeardown(pendingFailure: String?) {
        pollTask?.cancel()
        pollTask = nil
        startupDeadlineTask?.cancel()
        startupDeadlineTask = nil
        cancelValidation()
        // Teardown is fully settled here: no child, no in-flight validation.
        // The data home is released only now, so a stale validation result
        // can never reopen it.
        lease?.release()
        lease = nil
        child = nil
        authenticatedURL = nil
        closeStreams()
        let completions = stopCompletions
        stopCompletions = []
        if let pendingFailure {
            state = .failed(pendingFailure)
            setPhase(.failed(pendingFailure))
        } else {
            state = .idle
            setPhase(.idle)
        }
        for completion in completions { completion() }
    }

    private func runStopCompletions() {
        let completions = stopCompletions
        stopCompletions = []
        for completion in completions { completion() }
    }

    private func reportFailure(_ message: String, exitCode: Int?) {
        probeGeneration += 1
        startupDeadlineTask?.cancel()
        startupDeadlineTask = nil
        cancelValidation()
        // A failed launch owns neither a child nor the data-home lease.
        lease?.release()
        lease = nil
        child = nil
        authenticatedURL = nil
        closeStreams()
        var diagnostic = message
        if !recentLines.isEmpty {
            diagnostic += " 最近输出：\(recentLines.suffix(5).joined(separator: " / "))"
        }
        if droppedLineCount > 0 {
            diagnostic += "（另有 \(droppedLineCount) 行超长输出被丢弃）"
        }
        if exitCode != nil {
            diagnostic += " 日志：\(diagnosticLog?.url.path ?? "（未启用磁盘日志）")"
        }
        state = .failed(diagnostic)
        log("launch failed: \(diagnostic)")
        setPhase(.failed(diagnostic))
    }

    private func currentPendingFailure() -> String? {
        if case let .stopping(pendingFailure) = state { return pendingFailure }
        return nil
    }

    private func closeStreams() {
        stdoutPipe?.fileHandleForReading.readabilityHandler = nil
        stderrPipe?.fileHandleForReading.readabilityHandler = nil
        try? stdoutPipe?.fileHandleForReading.close()
        try? stderrPipe?.fileHandleForReading.close()
        stdoutPipe = nil
        stderrPipe = nil
        stdoutAssembler = OutputAssembler()
        stderrAssembler = OutputAssembler()
    }

    private func setPhase(_ phase: Phase) {
        self.phase = phase
        onPhaseChange(phase)
    }

    private func log(_ line: String) {
        diagnosticLog?.write(line)
    }

    private func describe(_ error: LauncherConfig.ConfigError) -> String {
        switch error {
        case .missingResource: return LauncherCopy.configMissingResource
        case .malformed: return LauncherCopy.configMalformed
        case let .notAbsolute(path): return LauncherCopy.configNotAbsolute(Redaction.redact(path))
        case let .nodeNotExecutable(path): return LauncherCopy.configNodeNotExecutable(path)
        case let .entryNotReadable(path): return LauncherCopy.configEntryNotReadable(path)
        }
    }

    private func describeFrozenConfig(_ error: FrozenLauncherConfig.ConfigError) -> String {
        switch error {
        case .missingResource: return LauncherCopy.frozenConfigMissing
        case .malformed: return LauncherCopy.frozenConfigMalformed
        case let .invalid(detail): return Redaction.redact(detail)
        case let .pathEscapes(path): return LauncherCopy.frozenConfigPathEscapes(Redaction.redact(path))
        }
    }

    private func describe(_ error: RuntimeIntegrityValidator.IntegrityError) -> String {
        switch error {
        case .inventoryMissing: return LauncherCopy.integrityInventoryMissing
        case let .inventoryMalformed(detail): return LauncherCopy.integrityInventoryMalformed(Redaction.redact(detail))
        case let .symlink(path): return LauncherCopy.integritySymlink(Redaction.redact(path))
        case let .specialFile(path): return LauncherCopy.integritySpecialFile(Redaction.redact(path))
        case let .hardlinked(path, nlink): return LauncherCopy.integrityHardlinked(Redaction.redact(path), Int(nlink))
        case let .missingFile(path): return LauncherCopy.integrityMissingFile(Redaction.redact(path))
        case let .extraFile(path): return LauncherCopy.integrityExtraFile(Redaction.redact(path))
        case let .hashMismatch(path): return LauncherCopy.integrityHashMismatch(Redaction.redact(path))
        case let .sizeMismatch(path): return LauncherCopy.integritySizeMismatch(Redaction.redact(path))
        case let .modeMismatch(path): return LauncherCopy.integrityModeMismatch(Redaction.redact(path))
        case let .unreadable(path): return LauncherCopy.integrityUnreadable(Redaction.redact(path))
        case .cancelled: return LauncherCopy.integrityCancelled
        }
    }

    private func describe(_ outcome: AuthenticatedProbe.Outcome) -> String {
        switch outcome {
        case .confirmed:
            return "已确认"
        case let .tokenRequestRejected(status):
            return "带 token 的请求返回 \(status)，预期 303"
        case let .bareRequestAccepted(status):
            return "无 token 的请求返回 \(status)，预期 401"
        case let .transportError(message):
            return Redaction.redact(message)
        }
    }
}
