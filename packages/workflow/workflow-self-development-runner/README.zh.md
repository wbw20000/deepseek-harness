---
description: "可选的有人监督模式自研 runner：受信宿主时钟、人工在场能力证据、限制在实验 worktree 内的 headless 执行器，以及独立验收器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development-runner

[English](README.md) | 中文

<a id="summary"></a>
## 概述

为任务控制基础包运行一次有人监督模式的开发尝试。从 `sysctl kern.boottime` 派生跨启动会话的受信时钟，把一次显式的人工确认变成能力证据，在实验 worktree 内驱动 headless 执行器，并由独立验收器验证结果。证据文件写入实验进程写不到的稳定侧目录。该服务是可选挂载的，不注册任何工具、提示词或事件，也绝不启用无人值守执行。

## 目录

- [服务](#service)
- [受信时钟](#trusted-clock)
- [进一步探索](#further-exploration)
- [Model Experience](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="service"></a>
## 服务

`SelfDevelopmentRunner`（默认导出，Cordis 服务 `selfDevelopmentRunner`）在构造时校验部署配置，并围绕注入的 `selfDevelopmentTasks` 控制器组合尝试流水线。它不出现在任何默认 bundle 中。

| 配置字段 | 含义 |
|---|---|
| `nodeBinary` | 执行器与验收命令使用的 `node` 二进制的绝对路径。 |
| `dshBin` | 执行器 spawn 的 harness CLI 入口（`apps/cli/lib/bin.js`）的绝对路径。 |
| `dshHome` | 实验 Agent 的 `DSH_HOME` 绝对路径；绝不是操作用户的 `~/.dsh`。 |
| `experimentsRoot` | 所有实验 worktree 的父目录绝对路径。 |
| `evidenceRoot` | 稳定侧证据目录的绝对路径；必须位于 `experimentsRoot` 之外。 |
| `killGraceMs` | 进程组清理时从 `SIGTERM` 到 `SIGKILL` 的毫秒宽限。 |

每个字段都是必需的。相对路径、位于 `experimentsRoot` 之内的 `evidenceRoot`，或者不是正有限整数的 `killGraceMs`，都会在构造时抛出带 `SELF_DEV_RUNNER_CONFIG_INVALID` 的 `SelfDevelopmentRunnerError`。没有任何配置能放松 worktree 或证据位置规则。

没有发布运行时不变式伴生包，因为本包尚无独立的可观察关系——时钟、摘要与配置校验都由聚焦的行为测试往返覆盖，而能证明跨观察不变式的尝试流水线还不存在。

<a id="trusted-clock"></a>
## 受信时钟

`HostClock` 从 `sysctl kern.boottime` 派生 `bootId` 与含休眠的单调毫秒计数。墙钟被调整时 `monotonicMs` 可能不单调；跨启动会话由核心任务控制包判为 `uncertain`；这不是 Swift 监督者的受信时钟——它是证明同样两条性质的 Node 侧替代品。

<a id="further-exploration"></a>
## 进一步探索

阅读把本包放进 workflow 兄弟包中的子系统页。

- [Workflow 子系统](../../../docs/subsystems/workflow.zh.md) —— workflow 接缝与组内其他包。

<a id="model-experience"></a>
## Model Experience

没有，本 runner 不注册任何面向模型的工具、提示词或事件，它产出的每条记录都写入稳定侧证据文件，而不是模型请求。

#### KV Cache effect

没有任何内容进入模型请求，因此提供方缓存复用不受影响。

## Known Limitations and Deferred Work

- **墙钟敏感性** —— `HostClock.monotonicMs` 派生自 `Date.now()`，两次观察之间墙钟被调整就可能不单调；核心包把 `bootId` 变化判为 `uncertain`，这是唯一的防线。
- **执行器与验收器尚未实现** —— headless 执行器、独立验收器与尝试组合是同一计划的后续任务；本包当前只搭好服务、时钟与 worktree 摘要。
- **时钟源仅限 macOS** —— `readBootTimeSysctl` 依赖 `sysctl kern.boottime`，Linux 与 Windows 上不存在；没有后备时钟。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
