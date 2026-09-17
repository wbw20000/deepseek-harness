# Agent Note: 源码链接的 macOS 启动器候选包

Status: implemented

[English](2026-09-17-source-linked-mac-launcher.md) | 中文

## Problem

macOS 启动器需要可重复的候选包构建流程，让人与已安装 App 并行试用，同时运行时仍由源码工作区持有。构建必须包含完整的 Swift 包、区分候选包的激活和诊断，并保留已有输出目标。

## Decision

### SwiftPM 拥有构建

`deliverables/mac-launcher/build.sh` 用 SwiftPM 构建 `LauncherApp` 产品，并通过 `--show-bin-path` 定位二进制；两个操作均使用从脚本位置推导的绝对 `--package-path`。Package.swift 管理模块布局和 macOS 13 部署目标。工作目录不影响包解析。SwiftPM 沙箱限制和其他构建失败均返回非零状态，不采用更弱的回退方式。

### 候选标识不同

构建复制 Info.plist 并用 PlistBuddy 改写：bundle 标识符 `com.local.deepseek-harness-launcher.candidate`、显示名称 `DeepSeek Harness (Candidate)`、bundle 目录 `DeepSeek Harness (Candidate).app`。Info.plist 保留稳定的 `com.local.deepseek-harness-launcher` 标识符，若不是如此 build.sh 拒绝运行。不同的标识符隔离了 LaunchServices 激活、TCC 授权与诊断；App 用 `Bundle.main.bundleIdentifier` 派生日志文件名，因此候选包写入 `~/Library/Logs/com.local.deepseek-harness-launcher.candidate.log`，绝不截断已安装 App 的日志。

### 源码链接配置

候选包只记录绝对路径：项目目录、Node 可执行文件，以及从 `apps/cli/package.json` 的 `bin.dsh` 解析的 CLI 入口（唯一受支持的入口）。Node 用 JSON.stringify 序列化 `launcher-config.json`，任何路径值都无法注入 JSON 结构。App 从该工作区运行 `node <entry> web --no-open`；候选包不是冻结的运行时。

### 失败即关闭的交付

路径必须是绝对路径。项目和 Node 输入必须存在；目标路径必须不存在，包括符号链接形式。同一目标卷上的私有暂存目录保存已签名的 bundle。仅用于构建的 `publish-rename.c` 辅助工具通过 `renamex_np(..., RENAME_EXCL)` 实现原子的不可替换发布；已有目标保持原样，包括被其他发布者并发创建的目标。辅助工具由宿主 Command Line Tools 编译，不打入 bundle。显式输出需要已存在且非符号链接的父目录；默认输出在输入校验后创建 `.build`。清理仅删除私有暂存目录。在报告成功之前检查发布目录和候选标识符。构建从不安装或替换 App。

### 运行时所有权与就绪

启动器只拥有它自己派生的子进程：先 SIGTERM，超过有界宽限后 SIGKILL，绝不向已存在的后端发信号。就绪要求 `dsh web:` 就绪行及禁用 cookie 和重定向的探测：裸请求必须返回 401，带 token 请求必须返回 303。两个请求并发执行，不校验 cookie 头。失败阶段是终态：对话框说明失败原因，退出并重开即恢复路径；没有隐藏的重试。候选标识不隔离 Harness 数据或文件系统访问；[试用说明](../../../../deliverables/mac-launcher/README.zh.md)要求显式指定全新数据目录和回环端口分配。

## Existing decisions and supersession

[One dsh launcher for application profiles](2026-08-22-single-dsh-application-launcher.zh.md) 拥有哪些入口可以启动 Node 应用；本候选包启动 `dsh web`，在该清单之内，该笔记保持其权威。没有活跃笔记被本决策取代。

## Alternatives considered

**保留手工 swiftc 文件清单。** 否决：独立维护的清单可能遗漏包源码，或错误描述模块导入和平台目标。

**发布时使用 `mv -n`。** 否决：它可能未发布却返回成功，也可能把源嵌套到已有目标目录中。检查暂存是否消失，不能区分嵌套移动与在预期路径发布。

**复用稳定的 bundle 标识符并要求测试者先退出已安装 App。** 否决：共享标识符时，LaunchServices 会激活已在运行的已安装实例，macOS 按标识符共享 Documents 授权，试用可能静默地测错了二进制。

**在 SwiftPM 的 manifest 沙箱失败时回退到 `--disable-sandbox`。** 否决：错误文本匹配不能授权削弱构建隔离。调用者选择支持 SwiftPM 沙箱的宿主上下文。

## Consequences

- 只有当记录的工作区、Node 可执行文件和 CLI 入口保持在记录的绝对路径、且 `apps/cli/lib` 保持已构建时，候选包才能工作。
- 二进制以构建机的架构、按 macOS 13 部署目标编译；试用应在构建候选包的机器上进行。
- 无法运行 SwiftPM 的 sandbox-exec manifest 隔离的宿主无法在内部构建候选包；构建必须在允许的宿主上下文中重新运行。
- `tests/run-build-tests.sh` 守护交付契约：目标拒绝且哨兵完好、符号链接拒绝、相对与不存在输入拒绝、manifest 解析、构建失败清理、`publish-rename.c` 面对既有文件、目录与符号链接的真实发布操作（哨兵不变、不多出子项、并发发布者只产生一个胜出者）、从仓库根目录和含重引号路径的无关工作目录运行的密闭构建，以及真实候选包的标识、签名、目标与配置。

## Testing

- `zsh deliverables/mac-launcher/tests/run-build-tests.sh` 覆盖上文描述的拒绝、失败、发布辅助工具、密闭构建与有效候选包用例；有效候选包用例要求 `LauncherApp` 目标可编译，这需要允许 SwiftPM 的 sandbox-exec manifest 隔离的宿主上下文。
- `swift run --package-path deliverables/mac-launcher LauncherTests` 覆盖解析、脱敏、配置、HTTP 探测和子进程生命周期。
- `pnpm run verify-translation-pairing deliverables/mac-launcher/README.md` 根据记录的源码哈希检查 README 双语对。
