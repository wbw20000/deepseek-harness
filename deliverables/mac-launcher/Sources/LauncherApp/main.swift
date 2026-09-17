import AppKit
import Foundation
import LauncherCore

/// AppKit shell for the launcher. The window owns no lifecycle logic: it
/// renders the `BackendController` phases, opens the in-memory authenticated
/// URL, and forwards quit requests so teardown completes before termination.
/// Nothing here sleeps, polls with curl, or blocks the main thread.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {

    private var window: NSWindow!
    private var statusLabel: NSTextField!
    private var addressLabel: NSTextField!
    private var openButton: NSButton!
    private var controller: BackendController?
    private var openedBrowserOnce = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMainMenu()
        buildWindow()
        NSApp.activate(ignoringOtherApps: true)
        startController()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    /// Quit waits for the owned child to exit before the process dies. AppKit
    /// gets `terminateCancel` for the first pass; the stop completion re-enters
    /// `terminate` once teardown finished, and the second pass terminates now.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let controller, controller.requiresTeardown else { return .terminateNow }
        controller.stop { NSApp.terminate(nil) }
        return .terminateCancel
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.terminate(nil)
    }

    /// Dock icon click or second launch attempt: bring the window back and
    /// reopen the authenticated URL when the owned child is confirmed running.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        if controller?.phase == .running {
            openHarness(nil)
        }
        return true
    }

    @objc private func openHarness(_ sender: Any?) {
        guard let url = controller?.authenticatedURL else { return }
        NSWorkspace.shared.open(url)
    }

    private func startController() {
        let diagnosticLog: DiagnosticLog?
        do {
            diagnosticLog = try DiagnosticLog(
                url: FileManager.default.homeDirectoryForCurrentUser
                    .appendingPathComponent("Library/Logs/\(Bundle.main.bundleIdentifier ?? "com.local.deepseek-harness-launcher.candidate").log"))
        } catch {
            diagnosticLog = nil
        }

        let resourcesURL = Bundle.main.resourceURL ?? Bundle.main.bundleURL
        // Identity selects frozen mode even when its configuration is missing
        // or unreadable; a damaged frozen bundle never falls back to source.
        let frozenConfigPresent = Bundle.main.bundleIdentifier ==
            "com.local.deepseek-harness-launcher.candidate.frozen"
        let controller: BackendController
        if frozenConfigPresent {
            let launch: FrozenLauncherConfig.Resolved
            switch FrozenLauncherConfig.load(from: resourcesURL) {
            case let .success(resolved): launch = resolved
            case let .failure(error):
                showFailure(Self.frozenConfigFailureText(error))
                return
            }
            controller = BackendController(
                frozen: launch,
                diagnosticLog: diagnosticLog,
                probe: AuthenticatedProbe(),
                workingDirectory: launch.dshHomeURL,
                onPhaseChange: { [weak self] phase in self?.render(phase) })
        } else {
            let config: LauncherConfig
            switch LauncherConfig.load(from: resourcesURL) {
            case let .success(loaded): config = loaded
            case let .failure(error):
                showFailure(error == .missingResource ? LauncherCopy.missingConfig : LauncherCopy.configMalformed)
                return
            }
            // The child keeps the current user's real HOME and inherits this
            // environment untouched. A test-isolation DSH_HOME (the harness
            // data home, never UNIX HOME) is supplied directly to
            // BackendController by its owner; the shell never derives one and
            // never copies existing harness data into it.
            controller = BackendController(
                config: config,
                diagnosticLog: diagnosticLog,
                probe: AuthenticatedProbe(),
                workingDirectory: FileManager.default.homeDirectoryForCurrentUser,
                onPhaseChange: { [weak self] phase in self?.render(phase) })
        }

        self.controller = controller
        controller.start()
    }

    private static func frozenConfigFailureText(_ error: FrozenLauncherConfig.ConfigError) -> String {
        switch error {
        case .missingResource: return LauncherCopy.frozenConfigMissing
        case .malformed: return LauncherCopy.frozenConfigMalformed
        case let .invalid(detail): return LauncherCopy.frozenConfigInvalid(Redaction.redact(detail))
        case let .pathEscapes(path): return LauncherCopy.frozenConfigPathEscapes(Redaction.redact(path))
        }
    }

    private func render(_ phase: BackendController.Phase) {
        switch phase {
        case .starting:
            setStatus(LauncherCopy.statusStarting, color: .secondaryLabelColor)
            openButton.isEnabled = false
        case .validating:
            setStatus(LauncherCopy.statusValidating, color: .secondaryLabelColor)
            openButton.isEnabled = false
        case .running:
            setStatus(LauncherCopy.statusRunning, color: .systemGreen)
            if let url = controller?.authenticatedURL {
                // Origin only: the token stays in memory and out of the UI.
                addressLabel.stringValue = ReadinessLine.origin(of: url)
            }
            openButton.isEnabled = controller?.authenticatedURL != nil
            if !openedBrowserOnce, let url = controller?.authenticatedURL {
                openedBrowserOnce = true
                NSWorkspace.shared.open(url)
            }
        case .stopping:
            setStatus(LauncherCopy.statusStopping, color: .secondaryLabelColor)
            openButton.isEnabled = false
        case .idle:
            setStatus(LauncherCopy.statusIdle, color: .secondaryLabelColor)
            openButton.isEnabled = false
        case let .failed(message):
            setStatus(LauncherCopy.statusFailed, color: .systemRed)
            openButton.isEnabled = false
            showFailure(message)
        }
    }

    private func setStatus(_ text: String, color: NSColor) {
        statusLabel.stringValue = text
        statusLabel.textColor = color
    }

    private func showFailure(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = LauncherCopy.failureTitle
        alert.informativeText = message
        alert.addButton(withTitle: LauncherCopy.failureDismiss)
        if let window {
            alert.beginSheetModal(for: window)
        } else {
            alert.runModal()
        }
    }

    private func installMainMenu() {
        let mainMenu = NSMenu()
        let applicationMenuItem = NSMenuItem()
        mainMenu.addItem(applicationMenuItem)

        let applicationMenu = NSMenu()
        let quitItem = NSMenuItem(
            title: LauncherCopy.quitItemTitle,
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        quitItem.target = NSApp
        applicationMenu.addItem(quitItem)
        applicationMenuItem.submenu = applicationMenu

        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let windowMenu = NSMenu(title: LauncherCopy.windowMenuTitle)
        let closeItem = NSMenuItem(
            title: LauncherCopy.closeItemTitle,
            action: #selector(NSWindow.performClose(_:)),
            keyEquivalent: "w"
        )
        windowMenu.addItem(closeItem)
        windowMenuItem.submenu = windowMenu
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    private func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 210),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = LauncherCopy.windowTitle
        window.center()
        window.isReleasedWhenClosed = false
        window.delegate = self

        let title = NSTextField(labelWithString: LauncherCopy.headerTitle)
        title.font = .systemFont(ofSize: 20, weight: .semibold)

        statusLabel = NSTextField(labelWithString: LauncherCopy.statusStarting)
        statusLabel.font = .systemFont(ofSize: 14)
        statusLabel.textColor = .secondaryLabelColor

        // Shows the origin only; the launch token never appears in the UI.
        addressLabel = NSTextField(labelWithString: "")
        addressLabel.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        addressLabel.textColor = .secondaryLabelColor

        openButton = NSButton(
            title: LauncherCopy.openButtonTitle,
            target: self,
            action: #selector(openHarness(_:)))
        openButton.bezelStyle = .rounded
        openButton.keyEquivalent = "\r"
        openButton.isEnabled = false

        // The frozen candidate describes its own mode; the source-linked
        // candidate keeps its note.
        let frozenCandidate = (try? Data(contentsOf: (Bundle.main.resourceURL ?? Bundle.main.bundleURL)
            .appendingPathComponent("frozen-launcher-config.json"))) != nil
        let note = NSTextField(wrappingLabelWithString: frozenCandidate ? LauncherCopy.frozenFooterNote : LauncherCopy.footerNote)
        note.font = .systemFont(ofSize: 12)
        note.textColor = .tertiaryLabelColor

        let stack = NSStackView(views: [title, statusLabel, addressLabel, openButton, note])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 13
        stack.translatesAutoresizingMaskIntoConstraints = false

        let content = NSView()
        content.addSubview(stack)
        window.contentView = content
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 26),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -26),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -22),
        ])
        window.makeKeyAndOrderFront(nil)
    }
}

MainActor.assumeIsolated {
    let application = NSApplication.shared
    let delegate = AppDelegate()
    application.delegate = delegate
    application.setActivationPolicy(.regular)
    application.run()
}
