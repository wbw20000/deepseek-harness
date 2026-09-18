import Foundation

/// User-visible recovery copy (zh_CN) as a typed locale dictionary, following
/// the `LauncherCopy` pattern. Call sites never embed product copy directly.
public enum RecoveryCopy {

    public static let windowTitle = "DeepSeek Harness 恢复"
    public static let quitItemTitle = "退出 DeepSeek Harness 恢复"

    /// States what a recovery launch is and is not, before any action.
    public static let footerNote = "恢复启动只会通过本 App 启动上一次验证过的 last-good 冻结版本。它不是升级，也不是数据回滚：不会改写 active/last-good 记录，不会迁移或复制数据，也不会升级已安装的版本。哈希校验只能发现意外损坏，不能防御能同时改写记录和内容的同用户恶意修改。"

    public static let diagnoseButtonTitle = "重新诊断（只读）"
    public static let startButtonTitle = "启动上次可用版本（恢复启动）"
    public static let startButtonDisabledTitle = "诊断通过后才能启动"

    public static let statusDiagnosing = "正在只读诊断 last-good 记录与冻结包…"
    public static let statusVerified = "● 诊断通过，等待人工启动"
    public static let statusFailed = "● 诊断未通过"
    public static let statusStarting = "正在启动 last-good 后台服务…"
    public static let statusValidating = "正在校验冻结包运行时…"
    public static let statusRunning = "● last-good 后台服务运行中"
    public static let statusStopping = "正在停止 last-good 后台服务…"
    public static let statusIdle = "服务已停止"

    public static let diagnoseTitle = "恢复诊断失败"
    public static let leaseDismiss = "知道了"
    public static let openButtonTitle = "打开 DeepSeek Harness"

    /// The managed installation the Recovery App launches from; also shown so
    /// a human can confirm the selection before starting anything.
    public static func installationLine(_ path: String) -> String {
        "受管安装：\(path)"
    }

    public static func diagnosisPassed(_ appPath: String) -> String {
        "诊断通过：\n\(appPath)\n配置与运行时清单摘要与 last-good 记录一致，冻结包结构完整。尚未启动任何进程。"
    }

    public static func selectionFailed(_ detail: String) -> String {
        "last-good 记录或冻结包不可用：\(detail)\n未启动任何进程。请先修复受管安装，或重新建立 last-good 记录。"
    }

    /// The full payload integrity check runs during diagnosis, before any
    /// launch is offered.
    public static func integrityFailed(_ detail: String) -> String {
        "冻结包运行时完整性校验未通过：\(detail)\n未启动任何进程。请先修复受管安装中的冻结包。"
    }

    /// The record, not the Recovery App, decides what is launched; this copy
    /// explains the record-only selection rule.
    public static let recordNotSelected =
        "未找到受管安装的 last-good 记录（recovery-last-good.json）。恢复 App 只读取这一条显式记录，不扫描目录，也不猜测最新版本。"
}
