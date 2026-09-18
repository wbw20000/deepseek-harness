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

    /// Explains the quit contract and the frozen mode the candidate runs in.
    public static let frozenFooterNote = "关闭这个 App（关闭窗口或按 ⌘Q）会先等待本 App 启动的后台服务退出。服务从 App 内置的运行时副本启动（frozen 模式），数据目录固定为构建时记录的目录；数据目录分离不是进程或网络隔离，服务仍以当前用户权限访问文件和网络。关闭浏览器标签页不会停止服务。"

    // MARK: Status lines

    public static let statusStarting = "正在启动后台服务…"
    public static let statusValidating = "正在校验内置运行时…"
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

    public static let frozenTeardownUnconfirmed =
        "尚未确认后台进程已退出；数据目录仍被锁定，本 App 继续等待，不会启动第二个后端。请勿强制退出后立即重启，请先检查残留进程。"

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

    // MARK: Frozen configuration and integrity

    public static let frozenConfigMissing =
        "缺少 frozen-launcher-config.json：请使用 build.sh --frozen 构建冻结候选 App。"
    public static let frozenConfigMalformed =
        "frozen-launcher-config.json 无法解析，请重新构建冻结候选 App。"
    public static func frozenConfigInvalid(_ detail: String) -> String {
        "冻结候选包配置无效：\(detail)"
    }
    public static func frozenConfigPathEscapes(_ path: String) -> String {
        "冻结候选包配置中的路径越出了 bundle：\(path)"
    }
    public static func integrityFailed(_ detail: String) -> String {
        "内置运行时校验未通过，已拒绝启动（\(detail)）。请重新构建冻结候选 App。"
    }
    public static let integrityInventoryMissing =
        "缺少 runtime-inventory.json（该 App 不是通过 build.sh --frozen 构建的密封候选包）。"
    public static func integrityInventoryMalformed(_ detail: String) -> String {
        "runtime-inventory.json 不符合清单格式：\(detail)"
    }
    public static func integritySymlink(_ path: String) -> String {
        "运行时负载包含符号链接：\(path)"
    }
    public static func integritySpecialFile(_ path: String) -> String {
        "运行时负载包含特殊文件：\(path)"
    }
    public static func integrityHardlinked(_ path: String, _ nlink: Int) -> String {
        "运行时负载文件与其他 inode 共享（nlink=\(nlink)）：\(path)"
    }
    public static func integrityMissingFile(_ path: String) -> String {
        "清单中的文件缺失：\(path)"
    }
    public static func integrityExtraFile(_ path: String) -> String {
        "存在清单之外的未签名文件：\(path)"
    }
    public static func integrityHashMismatch(_ path: String) -> String {
        "文件内容与清单摘要不一致：\(path)"
    }
    public static func integritySizeMismatch(_ path: String) -> String {
        "文件大小与清单不一致：\(path)"
    }
    public static func integrityModeMismatch(_ path: String) -> String {
        "文件权限与清单不一致：\(path)"
    }
    public static func integrityUnreadable(_ path: String) -> String {
        "无法读取或计算摘要：\(path)"
    }
    public static let integrityCancelled = "运行时校验已取消。"

    // MARK: Data-home lease

    /// Another frozen launcher or recovery App holds the OS lease on this
    /// data home; the launch fails before any process starts.
    public static let backendLeaseBusy =
        "另一个 DeepSeek Harness 启动器或恢复 App 正在使用该数据目录；为避免并发写入，本次未启动任何进程。请先退出占用该数据目录的 App。"

    public static func backendLeaseCannotLock(_ detail: String) -> String {
        "无法锁定该数据目录，已拒绝启动：\(detail)"
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
