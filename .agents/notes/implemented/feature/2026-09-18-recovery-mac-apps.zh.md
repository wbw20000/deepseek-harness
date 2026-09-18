# Agent Note: 独立的 macOS 恢复 App

Status: implemented

[English](2026-09-18-recovery-mac-apps.md) | 中文

## 问题

主 App 可执行文件损坏时，仍须能够诊断，并由人工启动显式选择的 last-good 运行时。恢复不能从目录修改时间推断人工发布批准，也不能把重启后端当作还原数据。

## 决策

`deliverables/mac-launcher` 通过 `tools/build-recovery.sh` 从同一个 `RecoveryApp` 可执行文件构建两个独立的普通 App——`DeepSeek Harness Recovery` 与 `DeepSeek Harness Emergency Recovery`，它们使用不同的 bundle 标识符，并独立复制可执行字节与资源。运行期两者都不依赖主 LauncherApp 可执行文件、源码工作区或全局 Node；两者在构建期链接 `LauncherCore`，从不动态加载实验代码。

每个 App 只读取一条显式的带版本 last-good 记录（`<安装根目录>/recovery-last-good.json`，schema `deepseek-harness.recovery.last-good/1`），记录命名密封受管安装内直接的冻结 bundle，以及它的 `frozen-launcher-config.json` 与 `runtime-inventory.json` 的 SHA-256 摘要。`RecoverySelection` 复用冻结校验器，拒绝不受支持的 schema、损坏、超长、硬链接与 FIFO 记录、穿越与符号链接的 bundle 路径、安装之外的 bundle、摘要不一致，以及缺失的 bundle 或数据目录部分。记录的数据目录必须是所选受管安装内严格更深一层真实目录，且逐级组件经过检查，并且不得与所选 App 重叠；嵌套发布路径只有在记录显式写出时才被接受。清单摘要的读取上限与校验器的 32 MiB 清单上限一致，因为真实清单会密封数万个文件。诊断只读并在主线程之外运行：摘要检查之后是完整的 `RuntimeIntegrityValidator` 负载校验，只有两者都通过才启用启动。只有人工刻意点击，才会通过自有 `BackendController` 启动已验证的 last-good 后端。恢复启动绝不改写 active/last-good 记录，也绝不迁移数据。

`RecoveryLease` 用数据目录自身描述符上的 OS `flock` 把并发的冻结写入者排除在同一数据目录之外。`BackendController` 在任何冻结后端启动之前获取它——普通冻结启动器与两个恢复 App 一视同仁——并持有到该次启动的销毁流程完全落定，因此租约争用会在任何进程被启动之前失败，过期的校验结果也无法在退出后重新打开数据目录。没有锁文件，也没有需要清理的过期 PID 状态；恢复 App 不会在控制器的租约之外再获取第二个租约。

## 已考虑的替代方案

按最新 mtime 扫描已安装 App 被拒绝：它会启动最近被改动的那个，这正是恢复要防止的失败。PID 文件锁被拒绝：崩溃的持有者留下阻塞恢复的过期文件，更糟的是复用的 PID 会误导判断；内核持有的 `flock` 没有这两种失败。在仅恢复 App 持锁的方案中，普通冻结启动器与恢复 App 仍可能并发写同一数据目录，因此选择把租约放进 `BackendController`：在任何冻结进程被启动之前共享获取，用一个属主为每一次冻结启动封闭这条不安全路径。

## 后果

协作锁不约束跳过加锁的进程，也不监督孤儿进程：强制结束启动器会释放锁，即使子进程仍存活。强制退出后重新打开前，必须检查残留后端。未确认子进程停止时继续持锁，App 等待确认退出后再关闭。元数据哈希检测意外不一致，不能防止同用户同时替换记录与负载。这些 App 提供诊断和人工后端恢复，不提供沙箱、发布批准、发布事务或备份还原。last-good 记录必须显式提供；产品未暴露记录写入方。Emergency Recovery 与 Recovery 使用相同实现，但入口副本独立；共享的选定运行时损坏时，两者仍都会拒绝启动。

## 现有决策

[冻结候选包决策](../architecture/2026-09-17-frozen-mac-launcher.zh.md)仍然拥有负载完整性、数据目录规则，以及本恢复路径复用的无限制声明。[单一 dsh 启动器决策](../architecture/2026-08-22-single-dsh-application-launcher.zh.md)拥有 Node 应用入口规则。没有活动笔记被取代。

## 验证

`swift run --package-path deliverables/mac-launcher RecoveryTests` 覆盖有效选择、损坏与不受支持的 schema、超长/硬链接/FIFO 记录元数据、超过 64 KiB 的清单与超过 32 MiB 清单的拒绝、穿越与符号链接逃逸、摘要不一致、缺失 bundle 与数据目录部分、密封安装加载、数据目录包含关系（安装之外、与所选 App 重叠、`..` 与符号链接组件、被接受的显式嵌套发布路径）、通过持锁子进程验证的独立进程锁互斥，以及自有 `BackendController` 对密封可启动 fixture 的启动与停止和在任何进程被启动之前失败的独立进程租约争用。`RecoveryTests --fixture-install <已存在目录>` 针对私有 fixture 安装运行选择、完整负载校验与真实自有启动和停止。`run-build-tests.sh` 验证 `build-recovery.sh` 的拒绝行为。真实 Mac 上的原生窗口、点击启动和双 App 并发试用仍是独立的人工平台证据；本增量的元数据哈希记录明确仅用于测试，绝不构成真实稳定批准的种子。
