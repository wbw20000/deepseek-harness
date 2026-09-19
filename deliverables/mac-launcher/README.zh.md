# DeepSeek Harness macOS 启动器

[English](README.md) | 中文

## 概述

本目录构建一个 macOS App 候选包，由它管理 DeepSeek Harness Web 后端的生命周期：启动 `dsh web --no-open`，等待就绪行，并在认证就绪探测通过后打开浏览器。默认模式使用源码工作区；显式启用的冻结模式自带 Node 和运行时。`build.sh` 通过 SwiftPM 构建、签名并校验候选包。它从不安装：目标路径必须不存在，且绝不替换任何已安装的 App。

## 目录

- [前置条件](#prerequisites)
- [构建候选包](#build-a-candidate)
- [冻结候选包](#frozen-candidate)
- [恢复 App](#recovery-apps)
- [升级与恢复事务（`dsh-upgrade`）](#upgrade-transaction)
- [测试](#tests)
- [源码链接限制](#source-linked-limitation)
- [标识与诊断](#identity-and-diagnostics)
- [隔离试用](#isolated-trial)
- [失败行为](#failure-behavior)

<a id="prerequisites"></a>

## 前置条件

- 安装了 Xcode Command Line Tools 的 macOS（`swift`、`xcrun`、`codesign` 与 `/usr/libexec/PlistBuddy`）。
- 一个 Node 可执行文件，以绝对路径传给 `build.sh`。
- 候选包将要运行的 DeepSeek Harness 工作区，且已完成 `pnpm install && pnpm run build`，使 `apps/cli/lib/bin.js` 存在。

<a id="build-a-candidate"></a>

## 构建候选包

```sh
zsh deliverables/mac-launcher/build.sh \
  --project-dir <absolute path to the dsh checkout> \
  --node <absolute path to node> \
  --output <absolute path to the new .app>
```

`--output` 默认为 `deliverables/mac-launcher/.build/DeepSeek Harness (Candidate).app`；选择默认值时，`build.sh` 会在校验完输入后创建该 `.build` 父目录，因此全新工作区可以直接构建，而被拒绝的构建不会留下任何东西。脚本可以在任意工作目录运行——SwiftPM 始终收到指向本目录的 `--package-path`——它拒绝相对路径、不存在的输入和已存在的目标路径（包括符号链接），并以非零状态退出、不触碰目标。它通过 SwiftPM 构建 `LauncherApp` 产品，按 Package.swift 声明的 macOS 13 部署目标编译，只从 `apps/cli/package.json` 的 `bin.dsh` 解析 CLI 入口，以 ad hoc 签名并附带固定候选标识符的 designated requirement。发布是一次原子的不可替换重命名：`build.sh` 用 Command Line Tools 把 `publish-rename.c` 编译进私有暂存目录，该辅助工具用 `renamex_np(RENAME_EXCL)` 移动暂存的 bundle——要么发布成功，要么什么都不改变；抢先创建目标路径的并发写者会让构建响亮失败并保留既有目标，且该辅助工具绝不会被打进 bundle。如果宿主无法运行 SwiftPM 的 manifest 沙箱，`build.sh` 会报告该限制并以非零状态退出；请在允许 `sandbox-exec` 的宿主上下文中重新运行构建——脚本从不禁用沙箱，也不会回退到被削弱的沙箱。

<a id="frozen-candidate"></a>

## 冻结候选包

冻结模式接收已经部署好的依赖目录（根 `package.json` 声明 `bin.dsh`）、适配构建机器的独立 Mach-O Node 二进制文件，以及位于输入运行时和输出 bundle 之外的全新空数据目录。请提供绝对路径、已存在的输出父目录、输入源码修订标识和部署锁文件的 SHA-256。这些标识描述构建输入，不代表发布已获批准。使用 Node 前，请按其分发方提供的校验值核验下载包。

```sh
zsh deliverables/mac-launcher/build.sh --frozen \
  --runtime-dir <absolute deployed-runtime directory> \
  --node <absolute standalone Node binary> \
  --dsh-home <absolute fresh empty data directory> \
  --source-rev <input source revision> \
  --lockfile-digest <deployed lockfile SHA-256> \
  --output <absolute path to a new .app>
```

构建器不安装依赖、不下载 Node、不填入凭据，也不构建 Harness 包。请单独准备并测试依赖目录。实际验证过的部署使用仓库固定版本的 pnpm，参数为 `--filter dsh-python-runtime-closure deploy --prod --offline --ignore-scripts --config.inject-workspace-packages=true --config.node-linker=hoisted --config.allow-unused-patches=true --config.package-import-method=copy`；该依赖集合包含 Web 运行时。其根 manifest 需要通过 `bin.dsh` 指向已安装 CLI 自己声明的入口。只部署 CLI 不能直接替代这一做法：它可能缺少必要的对等依赖。请随候选包保留源码锁文件、派生的部署锁文件和依赖准备记录。

bundle 内是 Node 和运行时的独立字节副本。内部链接被展开为文件；越界或循环链接及特殊文件会被拒绝。Node 只能依赖系统动态库；运行时原生文件还可使用自身的 `@loader_path` 或 `@rpath`，前提是解析到已复制、已列入清单的 Mach-O 文件。外部、继承和无法解析的搜索路径会被拒绝。每个原生文件先签名，再生成 SHA-256 清单。Swift 在启动 Node 前检查文件名、摘要、大小、权限和链接数；摘要计算不占用主 actor，退出会取消启动。清单检测意外变化，不能防御同时改写 bundle 和清单的攻击者。它不是发布审批签名。

冻结版标识符为 `com.local.deepseek-harness-launcher.candidate.frozen`。它使用记录的数据目录和内置 `127.0.0.1`/端口 `0` 配置，覆盖环境中的 `DSH_HOME` 和常规 Web 监听设置。子进程从试用目录启动，保留 UNIX `HOME`，移除 `NODE_OPTIONS`、`NODE_PATH`、`DYLD_*` 及疑似凭据名称的环境变量。已有设置、凭据和会话绝不会自动复制。同一时间只运行一个冻结候选包，因为它们共享标识符和日志。试用时使用独立浏览器配置文件。

这提供运行时和数据分离，不提供文件系统、进程、网络或存储配额限制。没有自动升级、恢复副本管理器、发布指针或无人值守开发循环。任何单独的安装操作获批前，必须由人工试用确切的候选包。详见[冻结运行时决策](../../.agents/notes/implemented/architecture/2026-09-17-frozen-mac-launcher.zh.md)。

<a id="recovery-apps"></a>

## 恢复 App

`tools/build-recovery.sh` 为显式启用的恢复路径构建两个独立的普通 App：`DeepSeek Harness Recovery.app`（`com.local.deepseek-harness-launcher.recovery`）与 `DeepSeek Harness Emergency Recovery.app`（`com.local.deepseek-harness-launcher.recovery.emergency`）。每个 bundle 各自携带一份 `RecoveryApp` 可执行文件与资源的独立副本，因此运行期都不依赖主 LauncherApp 可执行文件、源码工作区或全局 Node。两者都不安装任何内容，也不替换既有 App。

```sh
zsh deliverables/mac-launcher/tools/build-recovery.sh \
  --installation <absolute managed installation root> \
  [--output-root <absolute existing parent directory>]
```

脚本把唯一一个受管安装根目录密封进每个 bundle（`Contents/Resources/recovery-installation.json`），拒绝相对、缺失或符号链接的根目录，并以与 `build.sh` 相同的原子不替换重命名发布两个 bundle。重新构建意味着再次运行脚本；绝不覆盖既有目标。

启动时每个 App 只读取一条显式的带版本 last-good 记录（`<安装根目录>/recovery-last-good.json`），只接受 schema `deepseek-harness.recovery.last-good/1`。记录命名安装内直接的冻结 `.app` bundle，以及它的 `frozen-launcher-config.json` 与 `runtime-inventory.json` 的 SHA-256 摘要。加载器复用冻结校验器并拒绝其余一切：不受支持的 schema、损坏、超长、硬链接或 FIFO 记录、穿越与符号链接的 bundle 路径、所选安装之外的 bundle、摘要不一致，以及缺失的 bundle 或数据目录部分。记录的数据目录必须是所选受管安装内严格更深一层真实目录，且逐级组件经过检查（无 `..`、无符号链接中间组件），并且不得与所选 App 双向重叠；嵌套发布路径只有在记录显式写出且每个组件都检查过时才被接受。清单摘要的读取上限与校验器的 32 MiB 清单上限一致，因为真实清单会密封数万个文件。没有目录扫描、没有最新 mtime 猜测、没有自动回退，也不会宣称既有 HEAD 构建已获批稳定。

诊断只读且先行，并在主线程之外运行：记录加载与摘要检查之后是完整的 `RuntimeIntegrityValidator` 负载校验，只有两者都通过才显示已验证状态并启用启动按钮；哈希计算绝不阻塞主 actor。只有人工点击启动按钮，才会通过自有 `BackendController` 启动已验证的 last-good 后端；启动绑定已验证的数据目录与配置，并重新校验冻结负载。恢复启动绝不改写 active/last-good 记录、绝不迁移数据、也绝不升级发布：它不是升级，也不是数据回滚。新的诊断或退出会丢弃过期结果，绝不会重新启用启动；仍有后端在运行时，新的诊断会先通过其自有销毁流程停止它。错误会指明被违反的规则与路径。

冻结后端启动前，`BackendController` 会在数据目录上获取 OS `flock` 锁。普通冻结启动器与两个恢复 App 共用此规则；锁被占用时，在创建进程之前拒绝启动。尚未确认子进程退出时继续持锁，App 等待确认退出后再关闭。该锁是协作性的；启动器被强制杀死时锁会释放，即使后端仍存活，因此强制退出后必须先检查残留后端再打开。它不是孤儿进程监督器。元数据哈希检测意外不一致，不能防止同用户恶意改写。恢复入口不执行发布事务，也不还原备份。

<a id="upgrade-transaction"></a>

## 升级与恢复事务（`dsh-upgrade`）

把获批候选安装到正式位置、以及回退到上一个版本，都是桌面流程中用户的显式动作，通过 `dsh-upgrade` 命令行执行（状态机在 `Sources/UpgradeTransaction`，纯命令行入口在 `Sources/dsh-upgrade`）。没有任何自动触发：没有启动器钩子、没有 launchd 任务、没有定时器，也永不需要 root、不改 launchd。`dsh-upgrade` 与测试入口一样从本包构建运行；它不会被打进任何 App bundle。

```sh
swift build --package-path deliverables/mac-launcher
.build/debug/dsh-upgrade upgrade \
  --candidate-root <absolute managed-trial root> \
  --identity <absolute candidate-identity.json> \
  --trial-record <absolute trial-record.json> \
  --production-app <absolute production .app> \
  --production-data-home <absolute production data directory> \
  [--backups-root <dir>] [--transaction-dir <dir>] [--verify-command <cmd> [args...]]
.build/debug/dsh-upgrade restore (--from-backup <backup dir> | --from-last-good <recovery-last-good.json>) \
  --production-app <absolute production .app> --production-data-home <absolute production data directory>
.build/debug/dsh-upgrade resume --transaction-dir <dir>
.build/debug/dsh-upgrade make-trial-record --candidate-identity <absolute candidate-identity.json> \
  --approved-by <name> --result-digest <64 lowercase hex> --out <absolute output json>
```

在动第一个字节之前，`upgrade` 先绑定精确输入：候选安装内的 `recovery-last-good.json` 必须指向候选 App，且两个摘要与 identity 完全一致；候选 bundle 内的 `frozen-launcher-config.json` 与 `runtime-inventory.json` 必须重新哈希一致；试用记录（schema `self-development-review.trial-record/1`，含非空 `approvedBy` 与格式合法的 `resultDigest`）必须指向同一候选。`approvedBy` 与 `resultDigest` 为必填：升级必须绑定已记录的试用批准。正常来源是核心 `recordTrialApproval` 流程（`trial/approved`），其 `resultDigest` 未来由稳定侧门面导出。M1 时代没有 `resultDigest` 的人工试用记录不能直接升级：先人工核对候选摘要（可人工复核的值：`frozen-launcher-config.json`、`runtime-inventory.json`、可执行文件）算出摘要，用 `dsh-upgrade make-trial-record` 补录成合规记录——该子命令只做格式化与身份绑定校验（原样复制 identity 的字段，写盘后重读工件，candidate 段与 identity 完全一致才接受，不猜测任何数值）——再用补录后的记录执行升级。补录记录带 `"trialRecordSource": "manual-bridge"` 并被复制进事务记录，因此人工批准始终区别于核心记录的批准；其他来源值一律拒绝。正式 App 与数据目录必须存在，且正式 App 不能就是候选本身。任何一项检查失败都会拒绝执行，且不改动任何文件。

每个入口——`upgrade`、`restore`、`resume`——在读或写任何事务文件之前，都先取得事务目录 `upgrade-transaction.lock` 上的独占 `flock`；锁被占用时整次运行（包括对中断事务的处置）被直接拒绝，且被拒绝的运行不改动任何内容。事务状态机把每一步原子落盘（临时文件 + fsync + `rename(2)`，目录随后 fsync）到事务目录（默认：正式 App 所在目录）的 `upgrade-transaction.json`：`planned → backed-up → staged → switched → verified → committed`，任一步失败进入 `rolled-back` 或 `needs-manual`。状态之外还有一份副作用台账：备份、暂存复制、App 交换、数据版本标记、恢复入口安装每完成一步就落盘一次，且总在下一个不可逆步骤之前落盘；因此回滚——或崩溃恢复——只撤销台账记录的步骤，并按逆序执行。`backed-up` 是正式 App、正式数据目录与既有恢复入口 App 的成对备份，位于 `<backups-root>/<UTC 时间戳>-<被替换版本>/`（默认 `<事务目录>/upgrade-backups`；同一秒内两个事务时加后缀），其可读的 `manifest.json` 记录每个文件的路径、大小、SHA-256 与被替换版本；备份先通过哈希校验才进入 `staged`，中途失败的备份会被整体删除、绝不留下半成品。切换先把候选 App 复制到正式 App 旁的隐藏暂存目录、重新哈希其冻结元数据，再用两次原子 rename 交换；交换完成后立即落盘 `switched`，然后把成对的 `data-version.json` 标记（程序版本与数据版本一起）写进正式数据目录，且先前的标记字节先读取、先落盘。`verified` 之前已运行注入的 `--verify-command`（默认：安装后的 bundle 自身可执行文件加 `--version`；子进程输出边运行边读，输出再多也不会塞满管道导致阻塞）；退出码 0 提交，其余任何结果都回滚事务：已安装的恢复入口恢复为备份里的字节（升级前不存在则移除）、先前标记还原、旧 App 用 rename 快路径或备份慢路径放回，并在记录 `rolled-back` 之前把恢复后的 App 逐文件与备份 manifest 断言一致。回滚自身也失败——或恢复后的 App 与备份不符、或事务记录无法落盘——时进入 `needs-manual`，并打印可读的处理步骤；回滚记录写不进去时如实报告，绝不谎称已记录 `rolled-back`。提交成功的升级会把候选的恢复入口 App 原样复制到正式 App 旁，保持既有 opt-in 恢复语义；入口 App 保留自己的密封，只恢复它构建时绑定的安装，也不是数据还原工具。

崩溃留下的中间状态记录会在下一次 `upgrade`、`restore` 或显式 `resume` 时被处置——始终持有事务锁：副作用台账（无台账的旧记录则看正式 App 旁的 `.replaced` 残留）判定切换是否已经发生；已切换的事务从记录的备份回滚，更早的只做清理，而且待执行的操作绝不在同一次运行中启动，因此副作用绝不重复。`restore` 以相反方向运行同一状态机：`--from-backup` 先复核成对备份的 manifest，把正式 App 回到被备份的版本；`--from-last-good` 重新哈希一条 `recovery-last-good.json` 并安装它指向的 App。两者都会在切换前为当前状态创建自己的成对备份，并用 manifest 校验恢复结果。

限制：这些摘要检测意外不一致，不能防范改写记录与负载的同用户攻击者。`data-version.json` 是元数据配对；事务不迁移数据，安装后的 App 仍使用其冻结配置记录的数据目录。事务从不删除备份。校验命令有运行时限（默认 120 秒），其输出仅供参考。
<a id="tests"></a>

## 测试

```sh
swift run --package-path deliverables/mac-launcher LauncherTests
swift run --package-path deliverables/mac-launcher RecoveryTests
swift run --package-path deliverables/mac-launcher UpgradeTests
zsh deliverables/mac-launcher/tests/run-build-tests.sh
node --test deliverables/mac-launcher/tests/freeze-runtime.test.mjs
```

`RecoveryTests` 是恢复核心的独立无 GUI 测试入口。它覆盖 last-good 选择（有效记录、损坏与不受支持的 schema、超长、硬链接与 FIFO 记录元数据、穿越与符号链接逃逸、摘要不一致、缺失 bundle 或数据目录部分、超过 64 KiB 的清单、超过 32 MiB 清单的拒绝、密封安装加载，以及数据目录包含关系：安装之外、与所选 App 重叠、`..` 与符号链接组件、被接受的显式嵌套发布路径）、恢复锁（进程内互斥、释放、缺失与链接的数据目录），以及自有控制器（密封可启动 fixture 的启动与停止、独立进程租约争用在任何进程被启动之前失败）。显式运行 `swift run --package-path deliverables/mac-launcher RecoveryTests --fixture-install <已存在目录>` 会在该目录内构建一个私有 fixture 安装，并执行选择、完整负载完整性校验和真实自有 `BackendController` 的启动与停止；仅 fixture，无凭据。测试夹具都是私有的临时目录，且明确仅用于测试；fixture 记录绝不是真实的 last-good 批准。`build-recovery.sh` 的构建期拒绝（用法、相对或缺失的安装根目录、既有目标）针对真实脚本验证；完整打包流程需要允许 SwiftPM manifest 沙箱的主机。

`UpgradeTests` 是升级事务的无 GUI 测试入口。它在私有临时目录中覆盖：绑定拒绝（identity 摘要不一致、被篡改的 bundle 元数据、指向其他候选的试用记录、外来的 last-good 记录、把候选安装到它自己上——每一项都在任何文件被改动之前拒绝）、提交路径（记录历史中每个状态可读、正式 App 运行候选字节、成对的 data-version 标记、被安装的恢复入口、可独立复验的备份 manifest）、校验命令失败时的自动回滚、`staged` 与 `switched` 的中断演练及其后的 `resume` 处置、从成对备份与从 last-good 记录的恢复，以及单进程与真实双进程的事务锁拒绝。K3 审查回归从失败一侧覆盖同样的规则：切换之后 marker 写入失败会回滚 App 并如实记录副作用台账；持锁期间（同进程第二把句柄与真实第二进程）的 `resume`/`upgrade` 被拒绝且不触碰进行中的事务；中途失败的备份不留半成品目录；装到一半的恢复入口从备份回滚（既有入口恢复旧字节、新增入口被移除）；回滚记录写不进去时报告 needs-manual 而非谎报 `rolled-back`；以及 `make-trial-record` 桥（正常路径、非法摘要、既有目标、未知来源标记）。整套测试在干净 `.build` 下自给自足：`make-trial-record` 断言通过 `MakeTrialRecordCommand` 在进程内执行（`swift run UpgradeTests` 只构建测试目标及其库依赖，不构建 `dsh-upgrade` 可执行目标）；真实 CLI 冒烟只在 `dsh-upgrade` 二进制已构建时运行，否则记为带原因的显式跳过；`run-build-tests.sh` 则先显式构建 `dsh-upgrade` 产品再跑自己的 CLI 冒烟。`--hold-lock` 持锁模式与演练用的 `stopAfter` 选项都只是测试入口；出厂的命令行绝不会在无显式触发时运行任何事务。

`LauncherTests` 覆盖就绪解析、脱敏、认证探测、配置与数据目录重叠规则、冻结标识选择、自有子进程生命周期和冻结运行时完整性拒绝行为。它在私有目录中创建测试子进程，并绑定临时回环监听端口；请运行这个可执行测试入口，而不是 `swift test`。构建套件不会启动后端。Node 套件使用独立构建工具 fixture（测试前置数据）检查文件复制；fixture 通过不等于真实运行时试用通过。

对于单独构建的冻结候选包，运行 `swift run --package-path deliverables/mac-launcher LauncherTests --frozen-smoke-resources <absolute candidate Contents/Resources path>`。这一显式启用的冒烟测试使用记录的试用数据目录，启动真实内置后端、确认认证就绪、停止，再重复一次。它不打开浏览器、不发送模型请求，也不验证 AppKit 交互或操作系统权限弹窗。原生窗口、浏览器、Cmd-Q 和重新打开仍需在已解锁的 Mac 上单独试用。

对于单独打包、仅含测试 last-good 记录的隔离恢复安装，运行 `swift run --package-path deliverables/mac-launcher RecoveryTests --last-good-smoke <absolute installation path>`。它使用记录中的真实 Node、运行时和试用数据目录，检查认证就绪状态与竞争冻结启动器的互斥，停止自有后端后重复一次。它不调用主 App 可执行文件，也不验证原生恢复 App 交互。绝不能把这个测试指向生产数据。

该套件覆盖各拒绝路径（带哨兵文件的既有目标、符号链接目标、相对与不存在的输入、缺失或没有 `bin.dsh` 的 CLI manifest），验证失败的 SwiftPM 构建不留下目标路径和暂存残留，编译 `publish-rename.c` 并直接测试真实发布操作——全新发布会让暂存 bundle 消失；既有的文件、目录和符号链接连同各自哨兵原样保留，且该目录不会多出子项；并发发布者恰好产生一个胜出者——随后用替身的 `swift` 与 `codesign` 从仓库根目录和含重引号路径的无关工作目录运行密闭构建，检查发布、暂存清理与逐字的 `launcher-config.json` 序列化，最后从仓库根目录构建一个真实候选包并检查其标识符、显示名称、签名、macOS 13 目标与记录的配置。测试夹具都是私有的临时目录；没有任何测试绑定端口、写入凭据或启动已安装的 App。

<a id="source-linked-limitation"></a>

## 源码链接限制

默认的源码链接候选包不是冻结的运行时。`Contents/Resources/launcher-config.json` 记录工作区、Node 可执行文件和 CLI 入口的绝对路径，App 从该工作区运行 `node <entry> web --no-open`。移动或删除工作区、移动 Node、或删除构建产物 `apps/cli/lib` 都会使候选包失效。无论 bundle 在哪里打开，这些记录的路径都必须保持可用。

<a id="identity-and-diagnostics"></a>

## 标识与诊断

候选包使用 bundle 标识符 `com.local.deepseek-harness-launcher.candidate` 与显示名称 `DeepSeek Harness (Candidate)`；已安装的 App 保留 `com.local.deepseek-harness-launcher`。诊断日志文件名由 bundle 标识符派生，因此候选包写入 `~/Library/Logs/com.local.deepseek-harness-launcher.candidate.log`，绝不截断已安装 App 的日志。

<a id="isolated-trial"></a>

## 隔离试用

此流程适用于源码链接模式。构建不会运行候选包，请单独试用；此流程中不要直接通过 Finder 打开，因为没有显式 `DSH_HOME` 时，它会使用常规 Harness 数据目录。独立数据目录不隔离文件系统或网络访问，`HOME` 保持不变。同一时间只运行一个候选包：候选包共享标识符和日志。

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

<a id="failure-behavior"></a>

## 失败行为

启动失败、配置不可读、就绪超时或认证探测失败都会以失败对话框结束。没有自动重试，也没有隐藏的恢复路径：退出并重新打开 App 即可重试。退出 App 或关闭其窗口会终止它拥有的后端子进程。
