import AppKit
import LauncherCore

/// AppKit shell for the opt-in recovery path. Diagnosis is read-only and runs
/// first; only a deliberate human click starts the verified last-good backend
/// through an owned `BackendController`. The recovery launch never rewrites
/// the active or last-good records, never migrates data, and never upgrades a
/// release. The window owns no lifecycle logic; teardown completes before the
/// process dies, exactly as in the launcher App.
@MainActor
final class RecoveryAppDelegate: NSObject, NSApplicationDelegate {

    private var window: NSWindow!
    private var installationLabel: NSTextField!
    private var statusLabel: NSTextField!
    private var diagnoseButton: NSButton!
    private var startButton: NSButton!
    private var openButton: NSButton!

    private var controller: BackendController?
    private var verified: RecoverySelection.Verified?
    private var lastShownBackendFailure: String?
    /// The full-payload diagnosis running off the main actor; cancelled and
    /// re-created by every new diagnosis.
    private var diagnosisTask: Task<Void, Never>?
    /// Discards results from a superseded diagnosis: a stale success can
    /// never reenable start or show "verified" after a quit or re-diagnosis.
    private var diagnosisGeneration = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMainMenu()
        buildWindow()
        NSApp.activate(ignoringOtherApps: true)
        diagnose(nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        diagnosisGeneration += 1
        diagnosisTask?.cancel()
        diagnosisTask = nil
        guard let controller, controller.requiresTeardown else { return .terminateNow }
        controller.stop { NSApp.terminate(nil) }
        return .terminateCancel
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.terminate(nil)
    }

    private static func installationRoot() -> URL? {
        let arguments = CommandLine.arguments
        if let index = arguments.firstIndex(of: "--installation"), arguments.count > index + 1 {
            guard case let .success(root) = RecoverySelection.installationRoot(fromPath: arguments[index + 1]) else {
                return nil
            }
            return root
        }
        let resources = Bundle.main.resourceURL ?? Bundle.main.bundleURL
        guard case let .success(root) = RecoverySelection.loadSealedInstallation(from: resources) else {
            return nil
        }
        return root
    }

    /// Read-only diagnosis. The record load, the digest checks, and the full
    /// payload integrity validation all run off the main actor; only the
    /// settle hop touches UI state, and a superseded generation is discarded.
    /// No process starts here and nothing is written.
    @objc private func diagnose(_ sender: Any?) {
        diagnosisGeneration += 1
        diagnosisTask?.cancel()
        diagnosisTask = nil
        verified = nil
        diagnoseButton.isEnabled = false
        startButton.title = RecoveryCopy.startButtonDisabledTitle
        startButton.isEnabled = false
        guard let root = Self.installationRoot() else {
            renderFailure(LauncherCopy.frozenConfigMissing, RecoveryCopy.recordNotSelected)
            return
        }
        installationLabel.stringValue = RecoveryCopy.installationLine(root.path)
        statusLabel.stringValue = RecoveryCopy.statusDiagnosing
        statusLabel.textColor = .secondaryLabelColor
        // A live controller is never discarded before its owned teardown: the
        // stop completion re-enters diagnosis once the backend is gone.
        if let controller, controller.requiresTeardown {
            statusLabel.stringValue = RecoveryCopy.statusStopping
            controller.stop { [weak self] in self?.diagnose(nil) }
            return
        }
        controller = nil
        let generation = diagnosisGeneration
        diagnosisTask = Task.detached { [weak self] in
            let selection = RecoverySelection.load(
                recordURL: root.appendingPathComponent("recovery-last-good.json"),
                installationRoot: root)
            guard !Task.isCancelled, let self else { return }
            switch selection {
            case let .failure(error):
                await self.settleSelectionFailure(error, generation: generation)
            case let .success(verifiedLaunch):
                let integrity = await RuntimeIntegrityValidator.validate(
                    resourcesDirectory: verifiedLaunch.resourcesDirectory)
                await self.settleDiagnosis(verifiedLaunch, integrity: integrity, generation: generation)
            }
        }
    }

    private func settleSelectionFailure(
        _ error: RecoverySelection.SelectionError, generation: Int
    ) {
        guard generation == diagnosisGeneration else { return }
        renderFailure(RecoveryCopy.diagnoseTitle, RecoveryCopy.selectionFailed(Self.describe(error)))
    }

    /// Full payload integrity runs before anything is called verified: only
    /// then is start enabled.
    private func settleDiagnosis(
        _ verifiedLaunch: RecoverySelection.Verified,
        integrity: Result<Void, RuntimeIntegrityValidator.IntegrityError>,
        generation: Int
    ) {
        guard generation == diagnosisGeneration else { return }
        switch integrity {
        case let .failure(error):
            renderFailure(RecoveryCopy.diagnoseTitle, RecoveryCopy.integrityFailed(Self.describeIntegrity(error)))
        case .success:
            verified = verifiedLaunch
            statusLabel.stringValue = RecoveryCopy.statusVerified
            statusLabel.textColor = .systemGreen
            diagnoseButton.isEnabled = true
            startButton.title = RecoveryCopy.startButtonTitle
            startButton.isEnabled = true
        }
    }

    /// The deliberate human action. A fully verified diagnosis is the
    /// prerequisite; the controller owns the data-home lease, validation,
    /// spawn, readiness, and teardown. Recovery never writes active/last-good
    /// state and never acquires the lease itself: the controller holds it.
    @objc private func startLastGood(_ sender: Any?) {
        guard let verified, controller == nil else { return }
        lastShownBackendFailure = nil
        startButton.isEnabled = false
        diagnoseButton.isEnabled = false
        openButton.isHidden = true
        let diagnosticLog: DiagnosticLog?
        do {
            diagnosticLog = try DiagnosticLog(
                url: FileManager.default.homeDirectoryForCurrentUser
                    .appendingPathComponent("Library/Logs/\(Bundle.main.bundleIdentifier ?? "com.local.deepseek-harness-launcher.recovery").log"))
        } catch {
            diagnosticLog = nil
        }
        // The verified data home and config bind the launch: the controller
        // re-validates the frozen bundle and starts with the recorded home.
        let started = BackendController(
            frozen: verified.launch,
            diagnosticLog: diagnosticLog,
            probe: AuthenticatedProbe(),
            workingDirectory: verified.launch.dshHomeURL,
            onPhaseChange: { [weak self] phase in self?.render(phase) })
        controller = started
        started.start()
    }

    @objc private func openHarness(_ sender: Any?) {
        guard let url = controller?.authenticatedURL else { return }
        NSWorkspace.shared.open(url)
    }

    private static func describe(_ error: RecoverySelection.SelectionError) -> String {
        switch error {
        case .missingRecord:
            return RecoveryCopy.recordNotSelected
        case let .malformed(detail):
            return Redaction.redact("记录无法解析：\(detail)")
        case let .unsupportedSchema(schema):
            return Redaction.redact("记录 schema 不受支持：\(schema)。本构建只接受 \(RecoverySelection.supportedSchema)。")
        case let .invalid(detail):
            return Redaction.redact(detail)
        case let .outsideInstallation(path):
            return Redaction.redact("路径越出了受管安装：\(path)")
        case let .hashMismatch(name):
            return Redaction.redact("摘要与 last-good 记录不一致：\(name)")
        case let .missingPath(path):
            return Redaction.redact("缺少必需的文件或目录：\(path)")
        case let .unsafePath(path):
            return Redaction.redact("路径不安全（缺失、符号链接或其他文件类型）：\(path)")
        }
    }

    private static func describeIntegrity(_ error: RuntimeIntegrityValidator.IntegrityError) -> String {
        switch error {
        case .inventoryMissing:
            return LauncherCopy.integrityInventoryMissing
        case let .inventoryMalformed(detail):
            return Redaction.redact(LauncherCopy.integrityInventoryMalformed(detail))
        case let .symlink(path):
            return Redaction.redact(LauncherCopy.integritySymlink(path))
        case let .specialFile(path):
            return Redaction.redact(LauncherCopy.integritySpecialFile(path))
        case let .hardlinked(path, nlink):
            return Redaction.redact(LauncherCopy.integrityHardlinked(path, Int(nlink)))
        case let .missingFile(path):
            return Redaction.redact(LauncherCopy.integrityMissingFile(path))
        case let .extraFile(path):
            return Redaction.redact(LauncherCopy.integrityExtraFile(path))
        case let .hashMismatch(path):
            return Redaction.redact(LauncherCopy.integrityHashMismatch(path))
        case let .sizeMismatch(path):
            return Redaction.redact(LauncherCopy.integritySizeMismatch(path))
        case let .modeMismatch(path):
            return Redaction.redact(LauncherCopy.integrityModeMismatch(path))
        case let .unreadable(path):
            return Redaction.redact(LauncherCopy.integrityUnreadable(path))
        case .cancelled:
            return LauncherCopy.integrityCancelled
        }
    }

    private func renderFailure(_ title: String, _ detail: String) {
        statusLabel.stringValue = RecoveryCopy.statusFailed
        statusLabel.textColor = .systemRed
        diagnoseButton.isEnabled = true
        startButton.title = RecoveryCopy.startButtonDisabledTitle
        startButton.isEnabled = false
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.addButton(withTitle: RecoveryCopy.leaseDismiss)
        alert.runModal()
    }

    // MARK: Phase rendering

    private func render(_ phase: BackendController.Phase) {
        switch phase {
        case .idle:
            // The controller reached quiescence; its reference is released so
            // a new diagnosis or launch starts from a clean slate.
            controller = nil
            statusLabel.stringValue = RecoveryCopy.statusIdle
            statusLabel.textColor = .disabledControlTextColor
            diagnoseButton.isEnabled = true
            openButton.isHidden = true
        case .validating:
            statusLabel.stringValue = RecoveryCopy.statusValidating
            statusLabel.textColor = .disabledControlTextColor
        case .starting:
            statusLabel.stringValue = RecoveryCopy.statusStarting
            statusLabel.textColor = .disabledControlTextColor
        case .running:
            statusLabel.stringValue = RecoveryCopy.statusRunning
            statusLabel.textColor = .systemGreen
            openButton.isHidden = false
        case .stopping:
            statusLabel.stringValue = RecoveryCopy.statusStopping
            statusLabel.textColor = .disabledControlTextColor
        case let .failed(message):
            let stillOwned = controller?.requiresTeardown == true
            if !stillOwned { controller = nil }
            statusLabel.stringValue = RecoveryCopy.statusFailed
            statusLabel.textColor = .systemRed
            diagnoseButton.isEnabled = !stillOwned
            openButton.isHidden = true
            guard lastShownBackendFailure != message else { return }
            lastShownBackendFailure = message
            let alert = NSAlert()
            alert.messageText = LauncherCopy.failureTitle
            alert.informativeText = message
            alert.addButton(withTitle: RecoveryCopy.leaseDismiss)
            alert.runModal()
        }
    }

    // MARK: UI construction (mirrors the launcher App layout)

    private func installMainMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: RecoveryCopy.quitItemTitle,
                                   action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appMenuItem.submenu = appMenu
        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let windowMenu = NSMenu()
        windowMenu.addItem(NSMenuItem(title: LauncherCopy.windowMenuTitle,
                                      action: #selector(NSWindow.performZoom(_:)), keyEquivalent: ""))
        windowMenuItem.submenu = windowMenu
        NSApp.mainMenu = mainMenu
    }

    private func buildWindow() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 240),
            styleMask: [.titled, .closable],
            backing: .buffered, defer: false)
        window.title = RecoveryCopy.windowTitle
        window.delegate = self

        let content = NSStackView()
        content.orientation = .vertical
        content.spacing = 12
        content.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)

        installationLabel = NSTextField(wrappingLabelWithString: "")
        installationLabel.font = .systemFont(ofSize: 11)

        statusLabel = NSTextField(wrappingLabelWithString: "")
        statusLabel.font = .systemFont(ofSize: 13, weight: .medium)

        let buttons = NSStackView()
        buttons.orientation = .horizontal
        diagnoseButton = NSButton(title: RecoveryCopy.diagnoseButtonTitle, target: self, action: #selector(diagnose(_:)))
        diagnoseButton.bezelStyle = .rounded
        startButton = NSButton(title: RecoveryCopy.startButtonDisabledTitle, target: self, action: #selector(startLastGood(_:)))
        startButton.bezelStyle = .rounded
        startButton.isEnabled = false
        openButton = NSButton(title: RecoveryCopy.openButtonTitle, target: self, action: #selector(openHarness(_:)))
        openButton.bezelStyle = .rounded
        openButton.isHidden = true
        buttons.addArrangedSubview(diagnoseButton)
        buttons.addArrangedSubview(startButton)
        buttons.addArrangedSubview(openButton)

        let footer = NSTextField(wrappingLabelWithString: RecoveryCopy.footerNote)
        footer.font = .systemFont(ofSize: 11)
        footer.textColor = .secondaryLabelColor

        content.addArrangedSubview(installationLabel)
        content.addArrangedSubview(statusLabel)
        content.addArrangedSubview(buttons)
        content.addArrangedSubview(footer)
        content.translatesAutoresizingMaskIntoConstraints = false
        window.contentView?.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor),
            content.topAnchor.constraint(equalTo: window.contentView!.topAnchor),
        ])
        window.center()
        self.window = window
        window.makeKeyAndOrderFront(nil)
    }
}

extension RecoveryAppDelegate: NSWindowDelegate {}

MainActor.assumeIsolated {
    let application = NSApplication.shared
    let delegate = RecoveryAppDelegate()
    application.delegate = delegate
    application.setActivationPolicy(.regular)
    application.run()
}
