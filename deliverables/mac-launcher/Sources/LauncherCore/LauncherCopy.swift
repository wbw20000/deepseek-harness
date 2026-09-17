import Foundation

/// User-visible launcher copy (zh_CN) as a typed local dictionary.
///
/// The launcher is a Swift AppKit deliverable, outside the repository's
/// `packages/*` client TS sources that `verify-client-ui-i18n` covers, so it
/// owns its strings here instead of wiring the app framework's locale
/// machinery. Call sites never embed product copy directly.
public enum LauncherCopy {

    // MARK: Window and controls

    public static let windowTitle = "DeepSeek Harness"
    public static let headerTitle = "DeepSeek Harness 本地服务"
    public static let openButtonTitle = "打开 DeepSeek Harness"
    public static let quitItemTitle = "退出 DeepSeek Harness"
    public static let closeItemTitle = "关闭窗口"
    public static let windowMenuTitle = "窗口"

    /// Explains the quit contract and the source-linked mode the candidate runs in.
    public static let footerNote = "关闭这个 App（关闭窗口或按 ⌘Q）会先等待本 App 启动的后台服务退出。服务从构建时配置的项目目录启动（source-linked 模式）；关闭浏览器标签页不会停止服务。"

    // MARK: Status lines

    public static let statusStarting = "正在启动后台服务…"
    public static let statusRunning = "● 后台服务运行中"
    public static let statusStopping = "正在停止后台服务…"
    public static let statusIdle = "服务已停止"
    public static let statusFailed = "● 服务未运行"

    // MARK: Alerts

    public static let failureTitle = "DeepSeek Harness 启动失败"
    public static let failureDismiss = "知道了"
    public static let missingConfig = "缺少 launcher-config.json：请通过 build.sh 构建并签名候选 App 后再启动。"

    /// The launch token stays out of every user-visible string: callers pass
    /// already-redacted text.
    public static func spawnFailed(_ detail: String) -> String {
        "无法启动后台进程：\(detail)"
    }

    public static func readinessInvalid(_ redactedText: String) -> String {
        "后台输出了未通过校验的地址（已拒绝打开）：\(redactedText)"
    }

    public static func probeRejected(_ detail: String) -> String {
        "已收到就绪行，但地址校验未通过（\(detail)）。未打开浏览器。"
    }

    public static func exitedBeforeReadiness(_ statusText: String) -> String {
        "后台服务在就绪前退出（\(statusText)）。"
    }

    /// The authenticated URL dies with the child; the message says so instead
    /// of leaving a stale link on screen.
    public static func exitedWhileRunning(_ statusText: String) -> String {
        "后台服务已退出（\(statusText)），登录链接已失效。"
    }

    /// Technical startup bound, not a product setting.
    public static func startupTimedOut(seconds: Int) -> String {
        "后台服务在 \(seconds) 秒内未报告就绪；已停止本 App 启动的进程。"
    }

    /// Teardown that even SIGKILL could not confirm never reports clean: the
    /// launcher refuses to restart until a human has looked at the machine.
    public static let teardownUnconfirmed =
        "未能确认本 App 启动的后台进程已退出；未继续重启，请检查是否有残留进程后重新打开 App。"

    // MARK: Configuration errors

    public static let configMissingResource =
        "缺少 launcher-config.json：请使用 build.sh 构建的候选 App。"
    public static let configMalformed =
        "launcher-config.json 无法解析，请重新构建候选 App。"
    public static func configNotAbsolute(_ path: String) -> String {
        "launcher-config.json 中的路径不是绝对路径：\(path)"
    }
    public static func configNodeNotExecutable(_ path: String) -> String {
        "找不到可执行的 Node.js：\(path)。构建时请用 --node 指定绝对路径。"
    }
    public static func configEntryNotReadable(_ path: String) -> String {
        "无法读取 Harness 项目文件：\(path)。请在 系统设置 > 隐私与安全性 > 文件与文件夹 中允许本 App 访问（或在系统询问时允许访问“文稿”文件夹），然后重试。"
    }

    // MARK: Exit description

    /// Distinguishes a signal death from a normal exit so the user can tell a
    /// crash from a clean stop.
    public static func exitDescription(reason: Process.TerminationReason, code: Int32) -> String {
        switch reason {
        case .uncaughtSignal: return "信号 \(code)"
        case .exit: return "退出码 \(code)"
        @unknown default: return "退出状态 \(code)"
        }
    }
}
