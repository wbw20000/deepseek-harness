# DeepSeek Harness macOS 启动器

[English](README.md) | 中文

## 概述

本目录构建一个 macOS App 候选包，由它管理 DeepSeek Harness Web 后端的生命周期：从源码工作区启动 `dsh web --no-open`，等待就绪行，并在认证就绪探测通过后打开浏览器。`build.sh` 通过 SwiftPM 构建、签名并校验候选包。它从不安装：目标路径必须不存在，且绝不替换任何已安装的 App。

## 前置条件

- 安装了 Xcode Command Line Tools 的 macOS（`swift`、`xcrun`、`codesign` 与 `/usr/libexec/PlistBuddy`）。
- 一个 Node 可执行文件，以绝对路径传给 `build.sh`。
- 候选包将要运行的 DeepSeek Harness 工作区，且已完成 `pnpm install && pnpm run build`，使 `apps/cli/lib/bin.js` 存在。

## 构建候选包

```sh
zsh deliverables/mac-launcher/build.sh \
  --project-dir <absolute path to the dsh checkout> \
  --node <absolute path to node> \
  --output <absolute path to the new .app>
```

`--output` 默认为 `deliverables/mac-launcher/.build/DeepSeek Harness (Candidate).app`；选择默认值时，`build.sh` 会在校验完输入后创建该 `.build` 父目录，因此全新工作区可以直接构建，而被拒绝的构建不会留下任何东西。脚本可以在任意工作目录运行——SwiftPM 始终收到指向本目录的 `--package-path`——它拒绝相对路径、不存在的输入和已存在的目标路径（包括符号链接），并以非零状态退出、不触碰目标。它通过 SwiftPM 构建 `LauncherApp` 产品，按 Package.swift 声明的 macOS 13 部署目标编译，只从 `apps/cli/package.json` 的 `bin.dsh` 解析 CLI 入口，以 ad hoc 签名并附带固定候选标识符的 designated requirement。发布是一次原子的不可替换重命名：`build.sh` 用 Command Line Tools 把 `publish-rename.c` 编译进私有暂存目录，该辅助工具用 `renamex_np(RENAME_EXCL)` 移动暂存的 bundle——要么发布成功，要么什么都不改变；抢先创建目标路径的并发写者会让构建响亮失败并保留既有目标，且该辅助工具绝不会被打进 bundle。如果宿主无法运行 SwiftPM 的 manifest 沙箱，`build.sh` 会报告该限制并以非零状态退出；请在允许 `sandbox-exec` 的宿主上下文中重新运行构建——脚本从不禁用沙箱，也不会回退到被削弱的沙箱。

## 测试

```sh
swift run --package-path deliverables/mac-launcher LauncherTests
zsh deliverables/mac-launcher/tests/run-build-tests.sh
```

`LauncherTests` 覆盖就绪解析、脱敏、认证探测、配置和自有子进程生命周期。它在私有目录中创建测试子进程，并绑定临时回环监听端口；请运行这个可执行测试入口，而不是 `swift test`。下述构建套件不会启动后端。

该套件覆盖各拒绝路径（带哨兵文件的既有目标、符号链接目标、相对与不存在的输入、缺失或没有 `bin.dsh` 的 CLI manifest），验证失败的 SwiftPM 构建不留下目标路径和暂存残留，编译 `publish-rename.c` 并直接测试真实发布操作——全新发布会让暂存 bundle 消失；既有的文件、目录和符号链接连同各自哨兵原样保留，且该目录不会多出子项；并发发布者恰好产生一个胜出者——随后用替身的 `swift` 与 `codesign` 从仓库根目录和含重引号路径的无关工作目录运行密闭构建，检查发布、暂存清理与逐字的 `launcher-config.json` 序列化，最后从仓库根目录构建一个真实候选包并检查其标识符、显示名称、签名、macOS 13 目标与记录的配置。测试夹具都是私有的临时目录；没有任何测试绑定端口、写入凭据或启动已安装的 App。

## 源码链接限制

候选包不是冻结的运行时。`Contents/Resources/launcher-config.json` 记录工作区、Node 可执行文件和 CLI 入口的绝对路径，App 从该工作区运行 `node <entry> web --no-open`。移动或删除工作区、移动 Node、或删除构建产物 `apps/cli/lib` 都会使候选包失效。无论 bundle 在哪里打开，这些记录的路径都必须保持可用。

## 标识与诊断

候选包使用 bundle 标识符 `com.local.deepseek-harness-launcher.candidate` 与显示名称 `DeepSeek Harness (Candidate)`；已安装的 App 保留 `com.local.deepseek-harness-launcher`。诊断日志文件名由 bundle 标识符派生，因此候选包写入 `~/Library/Logs/com.local.deepseek-harness-launcher.candidate.log`，绝不截断已安装 App 的日志。

## 隔离试用

构建不会运行候选包，请单独试用；此流程中不要直接通过 Finder 打开，因为没有显式 `DSH_HOME` 时，它会使用常规 Harness 数据目录。独立数据目录不隔离文件系统或网络访问，`HOME` 保持不变。同一时间只运行一个候选包：候选包共享标识符和日志。

1. 按上文构建一个候选包。
2. 创建全新的试用目录，不要复制已有设置、凭据或会话。在目录内将以下内容保存为 `cordis.patch.yml`，让试用服务绑定操作系统分配的回环端口。

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: 127.0.0.1
    port: 0
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
```

3. 从 shell 直接启动可执行文件：`DSH_HOME=<全新试用目录的绝对路径> "<output>/Contents/MacOS/DeepSeek Harness" &`。子进程继承 shell 环境；若不打算在试用中使用模型凭据，请从该环境中移除它们。已安装的 App 继续运行；候选包不替换、不退出它。
4. 确认窗口进入运行状态且浏览器打开认证 URL，然后用 Cmd-Q 退出，并确认后端子进程随之退出。用相同方式再次启动，检查能否重开。这只检查本地启动和退出，不验证模型访问或全新 macOS 账号上的权限弹窗。

## 失败行为

启动失败、配置不可读、就绪超时或认证探测失败都会以失败对话框结束。没有自动重试，也没有隐藏的恢复路径：退出并重新打开 App 即可重试。退出 App 或关闭其窗口会终止它拥有的后端子进程。
