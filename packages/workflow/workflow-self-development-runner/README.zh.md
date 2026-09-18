---
description: "有人监督的自开发执行与验收辅助能力：进程限制、worktree 摘要、人工在场记录，以及部署要求。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development-runner

[English](README.md) | 中文

<a id="summary"></a>
## 概述

使用导出的辅助函数运行 headless 开发命令，并独立检查明确的验收用例。记录人工监督确认，计算源码与产物摘要。这些辅助函数不提供操作系统隔离或自动开发循环，也不会升级已有安装。

## 目录

- [服务](#service)
- [受信时钟](#trusted-clock)
- [执行与验收](#execution-and-acceptance)
- [进一步探索](#further-exploration)
- [Model Experience](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="service"></a>
## 服务

`SelfDevelopmentRunner`（默认导出，Cordis 服务 `selfDevelopmentRunner`）在构造时校验部署配置。它不出现在任何默认 bundle 中，也没有可启动任务的服务方法。导出的辅助函数与任务控制器尚未连接；调用方必须提供监督并自行接入取消机制。

| 配置字段 | 含义 |
|---|---|
| `nodeBinary` | 执行器与验收命令使用的 `node` 二进制的绝对路径。 |
| `dshBin` | 执行器 spawn 的 harness CLI 入口（`apps/cli/lib/bin.js`）的绝对路径。 |
| `dshHome` | 实验 Agent 的 `DSH_HOME` 绝对路径；绝不是操作用户的 `~/.dsh`。 |
| `experimentsRoot` | 所有实验 worktree 的父目录绝对路径。 |
| `evidenceRoot` | 稳定侧证据目录的绝对路径；必须位于 `experimentsRoot` 之外。 |
| `killGraceMs` | 升级为 `SIGKILL` 前的毫秒宽限，以及最终确认进程组退出的单独最长等待时间。 |

每个字段都是必需的。相对路径、词法上位于 `experimentsRoot` 之内的 `evidenceRoot`，或者不是正有限整数的 `killGraceMs`，都会在构造时抛出带 `SELF_DEV_RUNNER_CONFIG_INVALID` 的 `SelfDevelopmentRunnerError`。这项配置检查不能建立文件系统隔离，也不能阻止以同一用户身份运行的其他进程访问目录。

没有发布运行时不变式伴生包，因为本包尚无独立的可观察关系——时钟、摘要与配置校验都由聚焦的行为测试往返覆盖，而能证明跨观察不变式的尝试流水线还不存在。

<a id="trusted-clock"></a>
## 受信时钟

`HostClock` 从 `sysctl kern.boottime` 派生 `bootId`，并用当前墙钟与启动时间的差计算 `monotonicMs`。尽管字段这样命名，它并不保证单调。核心任务控制包将启动标识变化判为 `uncertain`。此辅助函数不能替代经过验证的监督者时钟。

<a id="execution-and-acceptance"></a>
## 执行与验收

[执行器](src/executor.ts) 通过 headless profile 启动配置的 CLI，并以实验目录为工作目录。[验收器](src/acceptor.ts) 加载独立定义，检查命令结果与文件断言。二者均使用 POSIX 进程组执行取消。[在场证据源](src/presence.ts) 记录确认，但不会检测人员是否持续在场，也不会强制执行所记录的回环端口允许清单。

验收定义必须位于实验根目录之外。这种放置方式可以减少误改，但不能保证同一用户的进程无法修改它。调用方必须独立保护控制文件与已批准输入。只有完整接入任务控制器，才能将这些辅助函数的结果与任务预算、冻结计划及人工试用关联起来。

执行器遇到标准输出溢出就停止，不会把截断结果当作成功。验收输出溢出会使所有断言失败。二者都会读完直接子进程的管道，杀掉其进程组内剩余成员，并等待进程组消失后才返回。无法确认退出就拒绝本次运行，包括仍可观察到未回收进程的情形。验收路径和产物祖先目录通过文件系统检查；产物符号链接只记录链接文本，不读取目标内容。这些检查不能阻止同用户的并发写入者在两次观察之间替换文件。

<a id="further-exploration"></a>
## 进一步探索

阅读把本包放进 workflow 兄弟包中的子系统页。

- [Workflow 子系统](../../../docs/subsystems/workflow.zh.md) —— workflow 接缝与组内其他包。
- [监督辅助能力的限制](../../../.agents/notes/implemented/bug-fix/2026-09-18-supervised-runner-fail-closed.zh.md) —— 失败处理与本地检查的能力范围。

<a id="model-experience"></a>
## Model Experience

没有，该服务不注册任何面向模型的工具、提示词或事件。显式调用执行器时，调用方的任务会传给独立的 headless Agent。

#### KV Cache effect

该服务不添加提示词前缀。独立启动的 Agent 内部缓存复用取决于其配置的 profile 和提供方。

## Known Limitations and Deferred Work

- **墙钟敏感性** —— `HostClock.monotonicMs` 派生自 `Date.now()`，墙钟调整可能使时长测量失效。JavaScript 定时器不是能够应对进程故障或主机休眠的独立监督者。
- **没有任务编排** —— 服务尚未将辅助函数接入 `startAttempt`、持久化尝试证据或重复失败的尝试。不提供无人值守执行或升级路径。
- **同用户执行** —— 选择工作目录和限制环境变量不是沙箱。子进程仍拥有操作系统用户的权限；所提供的实验 home 可能含有凭据。验收命令也没有外层沙箱。
- **进程组身份与逃逸** —— 离开进程组的后代（例如调用 `setsid`）可以逃过进程组取消。数字进程组 ID 在退出后也可能被复用；发信号并未固定操作系统拥有的进程身份。执行辅助函数在启动进程前拒绝 Windows；它们没有实现 Windows 进程监督机制。
- **时钟源仅限 macOS** —— `readBootTimeSysctl` 依赖 `sysctl kern.boottime`，Linux 与 Windows 上不存在；没有后备时钟。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
