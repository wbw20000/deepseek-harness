---
description: "有人监督的自开发尝试执行：受信时钟、人工在场证据、操作绑定的启动记录、headless 执行、独立验收、证据落盘，以及由控制器拥有的停止。有人监督模式，不是无人值守。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development-runner

[English](README.md) | 中文

<a id="summary"></a>
## 概述

端到端运行一次有人监督的自开发尝试。该服务组合受信时钟、人工在场证据、操作绑定的启动记录、headless 执行器与独立验收器，把持久尝试证据与终局结果一起落盘，停止则经由任务控制器。每次启动都要求一条已记录的人工确认和有限预算。这是带明确记录限制的有人监督模式，不是无人值守运行：这里没有任何东西提供操作系统隔离，也不会升级已有安装。

## 目录

- [服务](#service)
- [受信时钟](#trusted-clock)
- [人工在场证据](#human-presence-evidence)
- [尝试预算](#attempt-budget)
- [启动绑定与启动记录](#launch-binding-and-the-launch-record)
- [每次尝试的数据目录](#per-attempt-data-directory)
- [执行与验收](#execution-and-acceptance)
- [尝试证据](#attempt-evidence)
- [尝试编排](#attempt-orchestration)
- [错误码](#error-codes)
- [进一步探索](#further-exploration)
- [Model Experience](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="service"></a>
## 服务

`SelfDevelopmentRunner`（默认导出，Cordis 服务 `selfDevelopmentRunner`）在构造时校验部署配置，并在 `ctx.selfDevelopmentRunner` 上暴露四个服务方法。它不出现在任何默认 bundle 中。

| 方法 | 契约 |
|---|---|
| `clock()` | 返回 runner 的单例受信时钟：第一次调用创建一个 `HostClock`，之后的每次调用都返回同一实例，任务控制器与每次尝试共享同一个引导会话观察者。 |
| `runAttempt(req)` | 在 runner 的时钟、配置与取消句柄下为 `req.taskId` 运行一次有人监督的尝试；调用方的 signal（如存在）会与 runner 自己的组合。同一任务在 runner 内已有进行中的尝试时，第二个 `runAttempt` 会在触碰核心之前抛出 `SELF_DEV_RUNNER_ATTEMPT_ACTIVE`。worktree、确认、启动记录与证据校验仍由 `runSupervisedAttempt` 负责。返回的 promise 会原样拒绝核心 `open` 或 `runSupervisedAttempt` 抛出的任何错误：日志交接不会被包装、重试，也不会在此记录为尝试结果。 |
| `stop(req)` | 以固定顺序停止任务并完成 runner 自己的收尾：先对着单例时钟打开控制器并执行核心 stop——核心提交 `task/stopped` 并中止该尝试的启动信号；runner 随后中止自己的取消句柄，等待该尝试的 promise 结算——执行器与验收器进程组已退出、证据写入已完成——然后返回核心的 stop 结果。没有进行中的尝试时，只执行核心 stop。尝试的拒绝由 `runAttempt` 的调用方承接；stop 只要求收尾已经完成。 |
| `activeTasks()` | 返回 runner 当前拥有的尝试的任务 id 的只读快照；之后的归属变化不再反映。 |

卸载服务时会中止它拥有的每个尝试，然后等待全部收尾——执行器与验收器读完管道、杀掉组内剩余成员并等待进程组退出，证据写入完成——之后 dispose 才返回。任何情况下都不会按进程名扫描。

| 配置字段 | 含义 |
|---|---|
| `nodeBinary` | 执行器与验收命令使用的 `node` 二进制的绝对路径。 |
| `dshBin` | 执行器 spawn 的 harness CLI 入口（`apps/cli/lib/bin.js`）的绝对路径。 |
| `dshHome` | 实验 Agent 的 `DSH_HOME` 绝对路径；绝不是操作用户的 `~/.dsh`。 |
| `experimentsRoot` | 所有实验 worktree 的父目录绝对路径。 |
| `evidenceRoot` | 稳定侧证据目录的绝对路径；必须位于 `experimentsRoot` 之外。 |
| `killGraceMs` | 升级为 `SIGKILL` 前的毫秒宽限，以及最终确认进程组退出的单独最长等待时间。 |

每个字段都是必需的。相对路径、词法上位于 `experimentsRoot` 之内的 `evidenceRoot`，或者不是正有限整数的 `killGraceMs`，都会在构造时抛出带 `SELF_DEV_RUNNER_CONFIG_INVALID` 的 `SelfDevelopmentRunnerError`。这项配置检查不能建立文件系统隔离，也不能阻止以同一用户身份运行的其他进程访问目录。

没有发布运行时不变式伴生包：本包不暴露自己的运行时观察流，它拥有的启动记录、尝试证据与核心结果之间的关系由聚焦行为测试覆盖，而证据目录与控制目录之间的漂移通过拒绝并转人工处理，而不是由进程内检查来调和。

<a id="trusted-clock"></a>
## 受信时钟

[`clock.ts`](src/clock.ts) 导出 `HostClock`：从 `sysctl kern.boottime` 派生 `bootId`，并用当前墙钟与启动时间的差计算 `monotonicMs`。尽管字段这样命名，它并不保证单调。核心任务控制包将启动标识变化判为 `uncertain`。每次尝试请求都携带自己的时钟；此辅助函数不能替代经过验证的监督者时钟。

<a id="human-presence-evidence"></a>
## 人工在场证据

[`presence.ts`](src/presence.ts) 把一条具体确认变成核心 `startAttempt` 约定的能力证据。确认记录由谁确认、何时确认（一条受信时钟观察）、尝试在哪个实验 worktree 中运行、会话可绑定哪些回环端口，以及字面确认语。`PresenceAcknowledgement` 为 `'supervised-not-unattended' | 'unattended-accepted'`：`supervised-not-unattended` 断言的是有人在那一次具体启动时在场；`unattended-accepted` 记录的是有人在战役开始时一次性接受了"后续轮次自动启动不再逐轮确认"。**`unattended-accepted` 不是隔离保证**——它不检测人员是否持续在场，也不提供操作系统隔离；它只记录：在被接受的预算窗口内，人不会被要求为每一轮自动尝试重新确认。它还绑定被确认人审阅过的启动事实：任务 id、冻结测试计划摘要、验收定义摘要与产物路径集，因此为一次启动给出的确认不能被重放到不同内容上。

`HumanPresenceCapabilitySource` 为每个所需能力产出一条证据项，每条的摘要都绑定到该确认——包含确认语字面值——无论哪种确认语，核心都据此把尝试记录为有人监督。该来源记录的是一次确认；它不会检测人员是否持续在场，也不会强制执行所记录的回环端口允许清单。

<a id="attempt-budget"></a>
## 尝试预算

[`budget.ts`](src/budget.ts) 从人工批准的预算中减去任务已消耗的时间，得到本次尝试的有限界限。缺少批准、既不约束阶段也不约束总量的预算、或者总量已经花完的预算，都会在任何进程启动之前以 `SELF_DEV_RUNNER_BUDGET_INVALID` 拒绝。每个阶段都在自己的运行中期限下运行：开发阶段取批准的阶段上限与剩余总量中较小者，验收阶段取开发之后剩下的时间。任何一个限制先到零，都取消本次运行。期限在自己的 `AbortSignal` 上按限值中止；外部取消会中止它但不报告为超时。期限结束的是本次运行的可观察执行；对于逃出进程组的进程，它不是子进程监督。

<a id="launch-binding-and-the-launch-record"></a>
## 启动绑定与启动记录

[`binding.ts`](src/binding.ts) 拒绝确认未绑定真实启动事实的启动：任务 id、worktree 的文件系统 realpath（必须解析到 experiments root 之内并带有 `.git` 条目）、冻结计划摘要、验收定义摘要与产物路径集。

[`launch-record.ts`](src/launch-record.ts) 把操作绑定的启动记录写到 `<evidenceRoot>/tasks/<taskId>/launches/<operationId>.json`，每个操作只写一次，内容是启动时计算的摘要：worktree realpath、数据目录 realpath、产物路径、验收路径与摘要、测试计划摘要、源码与产物摘要、派生预算以及人工确认。用同一 operation id 重试时读取该记录，而不是重新计算启动输入；记录的内容事实被精确比对，任何分歧都会抛出 `SELF_DEV_RUNNER_LAUNCH_MISMATCH`，把启动拒绝给人工。记录的 `expectedRevision` 记录本次启动期望的 revision，并被刻意排除在比对之外：失败尝试后的重试必然到达更高 revision，绑定重试操作的是核心自己的重放检查。

<a id="per-attempt-data-directory"></a>
## 每次尝试的数据目录

`runSupervisedAttempt` 在请求上接受可选的 `dshHome`：本次尝试运行时使用的数据目录。缺省时，尝试与之前完全一致，使用部署配置的 `dshHome`。给定时，该目录必须是绝对路径，必须经过文件系统解析到 `experimentsRoot` 之内——普通目录即可，不要求 `.git` 条目——不得等于配置的 `dshHome`，也不得位于实验 worktree 之内（那里是被启动 Agent 可以自由写入的地方）。其他任何取值都会抛出 `SELF_DEV_RUNNER_WORKTREE_INVALID`，此时验收定义尚未加载，启动记录也不存在。

执行器的子进程与每个验收用例进程都以该尝试的数据目录作为自己的 `DSH_HOME`，因此 harness 写入其 home 的每任务状态都会落进该任务的目录。启动记录把解析出的目录存为 `dshHomeReal` 并参与重试比对：重试时换了数据目录会被 `SELF_DEV_RUNNER_LAUNCH_MISMATCH` 拒绝；在该字段出现之前写入的记录按配置的 `dshHome` 读取，因此旧操作无法在重试时凭空获得数据目录。

这正是 workspaces 服务交付其分配结果的接缝：`allocate` 返回的 `TaskWorkspace` 带有 `dataHome`（`<experimentsRoot>/<taskId>/dsh-home`，从部署的 `dataHomeTemplate` 复制而来）；把该值直接作为尝试的 `dshHome` 传入即可：

```ts ignore-check
// The workspaces allocation already carries the task's data home.
const workspace = await workspaces.allocate({ taskId, projectRoot })
await runner.runAttempt({
  taskId: workspace.taskId,
  worktree: workspace.worktree,
  dshHome: workspace.dataHome,
  // remaining supervised-attempt fields as usual: expectedRevision,
  // operationId, artifactPaths, acceptancePath, presence
})
```

这种分离只是记账与 spawn 环境的管道，不是隔离。子进程仍以操作用户身份运行，同用户进程——包括被启动的 Agent——可以读写其他每个任务的数据目录、证据根目录与控制目录；保护它们需要外层沙箱或本包不提供的操作系统级访问控制。

<a id="execution-and-acceptance"></a>
## 执行与验收

[执行器](src/executor.ts) 通过 headless profile 启动配置的 CLI，以实验目录为工作目录，并以该尝试的数据目录为 `DSH_HOME`。[验收器](src/acceptor.ts) 加载独立定义，检查命令结果与文件断言，并把同一数据目录交给它的用例进程。二者均使用 POSIX 进程组执行取消。上文的在场证据源记录的是一次确认；它不会检测人员是否持续在场，也不会强制执行所记录的回环端口允许清单。

验收定义必须位于实验根目录之外。这种放置方式可以减少误改，但不能保证同一用户的进程无法修改它。调用方必须独立保护控制文件与已批准输入。只有完整接入任务控制器，才能将这些辅助函数的结果与任务预算、冻结计划及人工试用关联起来。

执行器遇到标准输出溢出就停止，不会把截断结果当作成功。验收输出溢出会使所有断言失败。二者都会读完直接子进程的管道，杀掉其进程组内剩余成员，并等待进程组消失后才返回。最终清理按我们自己 spawn 的组长判定组归属——组长 pid、辅助函数自己对组长退出的观察、以及 spawn 后立即用 `ps -o lstart=` 读到的启动时间：当组长已不再能被确认为我们的进程而组信号得到 `EPERM` 时，运行结果记录 `pgidReused` 而不是让运行失败。退出仍无法确认就拒绝本次运行，包括仍可观察到未回收进程、或按指纹组长仍属于我们的情形。验收路径和产物祖先目录通过文件系统检查；产物符号链接只记录链接文本，不读取目标内容。这些检查不能阻止同用户的并发写入者在两次观察之间替换文件。

<a id="attempt-evidence"></a>
## 尝试证据

[`evidence.ts`](src/evidence.ts) 把一次尝试的持久记录发布到 `<evidenceRoot>/tasks/<taskId>/attempts/<attemptId>.json`，并把终局决定作为 `<attemptId>.outcome.json` 写在其旁边。证据记录启动摘要、开发阶段结束后取的摘要 A、验收后取的摘要 B（验收未运行时为 `undefined`）、两者是否相等、观察到的执行器与验收事实、阶段运行以及结构化结果。结果文件记录终局决定——`passed`、`failed`、`cancelled`、`late` 或 `unknown`——已提交的 revision，以及结构化失败。

没有结果文件的证据只算诊断记录：它绝不声称核心日志已通过。写入经由 [`durable-json.ts`](src/durable-json.ts)：独占临时文件、fsync、原子重命名加目录同步，因此中断的写入绝不会留下可读的半发布文件。重写相同字节返回 `unchanged`；目标路径已持有不同字节时抛出 `SELF_DEV_RUNNER_EVIDENCE_CONFLICT`。

<a id="attempt-orchestration"></a>
## 尝试编排

[`attempt.ts`](src/attempt.ts) 按固定顺序运行一次有人监督的尝试：先判定任务状态与 revision，把确认绑定到解析出的 worktree、计划摘要、验收定义与产物集，写入或校验启动记录，然后让核心在任何进程启动之前提交 `attempt/started`。副作用随后运行开发、取摘要 A、在自己的期限下运行验收、取摘要 B、比对 A 与 B（不相等即判本次运行失败）、写入持久证据，并把结果交回核心校验与提交。核心重放绝不启动第二个执行器：重放操作直接返回已记录结果，不执行任何内容。证据写入失败使该轮失败；结果文件写入失败按尽力而为记录，绝不会遮蔽核心自己的决定。

本服务拥有它启动的每次尝试。[stop](#service) 先提交核心 stop，并且只在被拥有的尝试结算之后才返回；被取消的尝试只能以取消失败结算，因为副作用运行在控制器串行化区段之外，结算时再回到区段。dispose 对每个被拥有的尝试执行同样的收尾：中止，然后等待执行器与验收器读完管道、杀掉组内剩余成员并等待进程组退出后才返回。

<a id="error-codes"></a>
## 错误码

`SelfDevelopmentRunnerError` 携带以下机器可路由代码之一（见 [`runtime.ts`](src/runtime.ts)）：

| 代码 | 含义 |
|---|---|
| `SELF_DEV_RUNNER_CONFIG_INVALID` | 服务配置或人工在场确认在配置边界未通过形状校验。 |
| `SELF_DEV_RUNNER_WORKTREE_INVALID` | worktree 不能解析到 experiments root 之内、缺少 `.git` 条目、无法计算摘要；或请求的每次尝试数据目录是相对路径、解析到 experiments root 之外、等于配置的 `dshHome`、或位于 worktree 之内。 |
| `SELF_DEV_RUNNER_CLOCK_UNAVAILABLE` | `sysctl kern.boottime` 无法启动、读取或解析成启动记录。 |
| `SELF_DEV_RUNNER_ACCEPTANCE_INVALID` | 验收定义不可用、位置不对，或者未覆盖冻结计划的必测用例。 |
| `SELF_DEV_RUNNER_EXECUTOR_FAILED` | headless 执行器无法 spawn 子进程，或无法确认进程组退出。 |
| `SELF_DEV_RUNNER_EVIDENCE_FAILED` | 启动记录、证据文件或结果文件的持久写入失败。 |
| `SELF_DEV_RUNNER_EVIDENCE_CONFLICT` | 目标路径已持有的字节与正在写入的记录、证据或结果不同。 |
| `SELF_DEV_RUNNER_EVIDENCE_INVALID` | 启动记录、证据文件或结果文件未通过字段或路径校验，或证据根目录、id 畸形。 |
| `SELF_DEV_RUNNER_PRESENCE_MISMATCH` | 人工确认未绑定启动的真实事实。 |
| `SELF_DEV_RUNNER_BUDGET_INVALID` | 批准的预算缺失、畸形、不约束任何东西，或总量已经花完。 |
| `SELF_DEV_RUNNER_LAUNCH_MISMATCH` | 已存在的启动记录与本次重试启动的内容或路径不一致。 |
| `SELF_DEV_RUNNER_ATTEMPT_ACTIVE` | 对 runner 内已有进行中尝试的任务再次调用 `runAttempt`，在触碰核心之前抛出。 |

<a id="further-exploration"></a>
## 进一步探索

阅读拥有编排决策的决策记录、把本包放进 workflow 兄弟包中的子系统页，以及拥有辅助函数 fail-closed 限制的记录。

- [有人监督的尝试编排](../../../.agents/notes/implemented/feature/2026-09-18-supervised-attempt-orchestration.zh.md) —— 每次尝试显式传入证据与时钟、操作绑定的启动记录，以及 A/B 摘要比对。
- [Workflow 子系统](../../../docs/subsystems/workflow.zh.md) —— workflow 接缝与组内其他包。
- [监督辅助能力的限制](../../../.agents/notes/implemented/bug-fix/2026-09-18-supervised-runner-fail-closed.zh.md) —— 失败处理与本地检查的能力范围。

<a id="model-experience"></a>
## Model Experience

没有，该服务不注册任何面向模型的工具、提示词或事件。显式调用执行器时，调用方的任务会传给独立的 headless Agent。

#### KV Cache effect

该服务不添加提示词前缀。独立启动的 Agent 内部缓存复用取决于其配置的 profile 和提供方。

## Known Limitations and Deferred Work

- **墙钟敏感性** —— `HostClock.monotonicMs` 派生自 `Date.now()`，墙钟调整可能使时长测量失效。JavaScript 定时器不是能够应对进程故障或主机休眠的独立监督者。
- **没有自动尝试循环** —— 服务不会重复失败的尝试，也不提供无人值守执行或升级路径。重试是由调用方发起、携带自己幂等键的操作；启动记录要么重放它，要么把它拒绝给人工。
- **同用户执行** —— 选择工作目录和限制环境变量不是沙箱。子进程仍拥有操作系统用户的权限；所提供的实验 home 可能含有凭据。验收命令也没有外层沙箱。每次尝试的数据目录只改变子进程 `DSH_HOME` 的指向，不改变它能到达的范围：同用户进程仍可读写其他每个任务的数据目录。
- **进程组身份与逃逸** —— 离开进程组的后代（例如调用 `setsid`）可以逃过进程组取消。数字进程组 ID 在退出后也可能被复用；发信号并未固定操作系统拥有的进程身份。最终清理因此按我们自己 spawn 的组长判定归属——组长 pid、辅助函数自己对组长退出的观察、以及 spawn 后立即用 `ps -o lstart=` 读到的启动时间：组长已不再能被确认为我们的进程而组信号得到 `EPERM` 时，运行结果记录 `pgidReused` 而不是失败；组长按指纹仍是我们的进程、或进程组在等待后仍可见时，仍然拒绝本次运行。某些宿主上被复用的 pid 仍可能读到一致的启动时间；被复用的同用户进程组也可能收到本应发给我们组的信号。执行辅助函数在启动进程前拒绝 Windows；它们没有实现 Windows 进程监督机制。
- **时钟源仅限 macOS** —— `readBootTimeSysctl` 依赖 `sysctl kern.boottime`，Linux 与 Windows 上不存在；没有后备时钟。
- **监督不是隔离** —— 工作目录选择、环境变量白名单、workspace-write 和路径检查不是外层操作系统沙箱。同一用户的子进程可能访问正式 home、实验凭据、控制目录与其他进程。人工确认不会自动生成配额、隔离或真实在场检测。Node 墙钟差与 JavaScript 定时器不能替代独立监督者的时钟、休眠计账和崩溃清理。当前阶段只能提供明确记录限制的有人监督测试，不得据此放行无人值守。
- **预算期限结束的是观察，不是逃逸的进程** —— 阶段期限与取消经由 POSIX 进程组生效，而进程组无法约束用 `setsid` 逃逸的后代；限制触发时会拆除组内成员并记录超时，但停不掉已离开进程组的进程。
- **检查与使用之间的符号链接竞态** —— worktree 包含关系、验收放置与产物路径检查在执行时解析路径；同用户的并发写入者可以在检查与使用之间把某个路径组件替换成符号链接，这些检查不能消除这一竞态。
- **证据目录与控制目录同属操作用户** —— 证据根目录与任务控制目录都是与尝试同用户的普通目录；本包没有任何东西阻止同用户进程（包括实验本身）改写证据、启动记录或结果文件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
