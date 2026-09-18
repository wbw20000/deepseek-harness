---
description: "可选启用的自开发任务控制基础：版本化任务规格、冻结验收计划、人工预算批准、经验证的尝试结果，以及持久化 JSONL 任务日志。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development

[English](README.md) | 中文

## 概述

在尝试开始前，记录开发需求、确认测试计划并批准有限预算。重启后保留已消耗的轮数与时间，拒绝不完整或身份不符的结果，并把人工试用批准与测试通过分开记录。集成方必须提供受信执行与验证服务；本包没有人工界面、生产工作进程或升级操作。

## 目录

- [服务](#service)
- [控制器操作](#controller-operations)
- [验证与预算规则](#verification-and-budget-rules)
- [日志](#journal)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="service"></a>
## 服务

`SelfDevelopmentTasks`（默认导出，Cordis 服务 `selfDevelopmentTasks`）拥有一个配置的私有控制目录，并按任务缓存 `SelfDevelopmentTaskController`。本服务可选启用：不进入任何默认 bundle，也不注册工具、提示、事件或守护进程。

| 配置字段 | 含义 |
|---|---|
| `controlDirectory` | 服务私有的控制目录；任务日志位于 `<controlDirectory>/tasks/<taskId>/`。 |
| `maxRecordsPerSegment` | 日志分段文件在轮转前容纳的记录数。 |
| `checkpointInterval` | 两次受保护检查点重写之间的已提交记录数。 |

所有字段均为必填：未实测其边界的部署不提供任何数值，插件在加载时立即失败，而不是猜测。服务在构造时校验配置——`controlDirectory` 必须是绝对路径，两个界限必须为正有限整数（`SELF_DEV_CONFIG_INVALID`）——并在 `taskId` 参与控制路径拼接或创建目录之前，先用纯路径分量文法校验它。

`open(taskId, clock, capabilitySource?)` 每次调用都显式传入受信时钟和能力证据来源。没有默认时钟：Node 时钟无法证明 macOS 的休眠与重启记账，观察来源必须由调用方提供（即未来的 Swift 监督者）。缺少 `capabilitySource` 时，每次尝试启动都以 `SELF_DEV_CAPABILITY_MISSING` 拒绝；不存在能把隔离打开的配置项。

<a id="controller-operations"></a>
## 控制器操作

<details>
<summary>受信宿主操作与取消——点击展开</summary>

每个变更调用携带 `{ taskId, expectedRevision, operationId }`。控制器串行化重叠调用，携带同一 expected revision 的两个调用方不可能同时提交（compare-and-set）。幂等摘要覆盖控制器方法加显式执行负载；同一 operation id 加相同负载会重放已记录结果（`replayed: true`，重新打开之后也一样——重放绝不伪装成新鲜成功）；同一 id 加不同负载、不同方法或不同执行负载被拒绝（`SELF_DEV_OPERATION_PAYLOAD_MISMATCH`）。过期的 `expectedRevision` 被拒绝（`SELF_DEV_REVISION_CONFLICT`）。副作用回调与取消信号永不进入摘要：它们是进程本地的执行指令，不是持久重放内容。

每个状态转换在写入任何内容之前先折叠校验，被拒绝的操作不会让日志改动一个字节。日志追加或 fsync 失败时，持久化结果不可判定：控制器实例锁死拒绝状态，此后一切操作以 `SELF_DEV_JOURNAL_UNAVAILABLE` 拒绝，任务需要人工 handoff。持久化结果不可判定时，控制器绝不继续。

- `createTask` 存储解析后的版本化 `TaskSpec`。
- `authorizePlanning` 授予独立的规划授权，绝不批准开发，也不消耗轮数；普通聊天不产生任何批准。
- `submitPlanDraft` / `confirmPlan` 冻结 `FrozenTestPlan`，其摘要绑定预算批准、尝试、结果和试用批准。折叠会校验确认的计划与人工可见草稿的必测用例和人工用例完全一致——只匹配版本会被拒绝。
- `approveBudget` 记录人工 `BudgetApproval`。轮数与时间按模式成对必填；仅轮数预算必须携带有限的阶段与单次尝试步数上限；仅时间预算必须携带无进展上限。已消耗轮数与时间从不重置；已低于消耗的上限让任务立即停止。
- `startAttempt` 要求状态 `ready`、完整能力证据和可启动的预算。串行化区段在持久提交 `attempt/started`（fsync）后即结束；副作用在其外运行，因此尝试进行中 `stop` 与其他一切操作仍被接受，结算时再回到串行化区段。提交后崩溃只消耗该轮一次，重启绝不重复副作用。首次构建失败同样消耗该轮；取消与迟到的结果从不退还已消耗的轮数或时间。
- `stop` 在尝试仍执行时记录人工取消，并中止该尝试的取消句柄让副作用得以静默。之后到达的结果只作诊断：不提交任何内容，任务保持停止状态，直到未决尝试的结算确认静默。
- `recordTrialApproval` 将人工试用批准绑定到当前已验证结果。此后任何新尝试或新计划版本都使其失效。本包不存在升级路径。

### 受信执行器取消

`startAttempt` 接受可选的 `signal?: AbortSignal`，并把自己的 `AbortSignal` 交给副作用；所供信号中止、请求停止或日志持久化结果不确定时，该信号中止。尝试结算或启动提交失败后，外部监听器会被移除。取消与迟到结果绝不记为通过，已消耗的轮数与时间保持已消耗。普通 `AbortSignal` 是受信执行器的协作式取消，不是子进程监督；真实执行器集成必须有外部监督。

</details>

<a id="verification-and-budget-rules"></a>
## 验证与预算规则

批准了阶段或步数上限时，报告必须携带对应的观察记录；缺少观察记录不能通过。重复的用例或断言身份会被拒绝，不能用后面的通过条目掩盖前面的失败条目。验收器必须独立于实验程序取得这些观察记录。

`verifyAttemptResult` 只接受针对当前任务、尝试、源码、产物和计划摘要完全一致的完整运行：退出码为零、无信号、无超时、无取消，且每个必测用例的每条必测断言都执行并通过。零用例报告、跳过或缺失断言、超时、信号、取消和非零退出都不能通过。在时间截止时或之后完成的结果视为迟到，不能把任务移入 `awaiting-trial`；报告的阶段时长或步数超出批准的 `phaseTimeoutMs` 或 `maxStepsPerAttempt` 同样视为迟到。轮数与时间先到先停：预算先耗尽的限制触发停止，另一项的余量不构成继续许可。

<a id="journal"></a>
## 日志

`TaskJournal` 把带哈希链的 JSONL 记录追加到任务目录下的有界分段中，每条记录完整写入（短写重试）并先 fsync 再让调用方行动，随后原子替换受保护检查点与投影文件——两者写后都会 fsync，新文件出现时目录项也会一并 fsync（仅靠 `writeFileAtomic` 不做 fsync）。读取有界且有证明：分段名必须与序号位置一致，文件必须是普通文件（符号链接、FIFO、目录一律拒绝），记录必须满足完整持久事件模式（null、缺失或未知判别式即为损坏），缺少结尾换行是未完成尾部，非空日志缺检查点则直接关闭失败。缺席与拒绝可区分——不可读的检查点报告其 errno，而不是假装文件不存在。畸形或不完整的尾部、断链、检查点不匹配或任何其他校验失败都会拒绝一切副作用操作并进入 handoff，而不是修复或续作。重启时发现仍在执行的尝试被记为中断，其轮数保持已消耗；跨启动周期的区间冻结剩余时间预算，等待人工复核。

首条记录会创建检查点，后续检查点按配置间隔或分段轮转生成。哈希链检测记录内容改动，检查点检测其覆盖记录的截断。最新检查点之后按完整记录截断日志不会被检测到。两者都不能抵抗管理员或能同时改写两个文件的攻击者；控制目录必须位于实验可写范围之外。

不发布运行时 invariant 配套模块；任务状态来自单一的已验证日志折叠，文件持久性与投影恢复需要文件系统往返测试。本包没有可供交叉核对的独立运行时事件流。

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够用时，阅读这些页面：拥有生命周期与控制加固决策的决策记录，以及把本可选包放入 workflow 兄弟包中的子系统页。

- [自开发任务控制基础（proposed Agent Note）](../../../.agents/notes/proposed/feature/2026-09-18-self-development-task-control-foundation.zh.md) —— 本包实现的生命周期、预算与日志决策。
- [Workflow 子系统](../../../docs/subsystems/workflow.zh.md) —— workflow 接缝与组内其他包。

## Known Limitations and Deferred Work

- **无真实执行器集成** — 尝试只运行受信宿主提供的副作用闭包。工作进程、存储配额执行、沙箱覆盖、外部验收器和 Swift 监督者时钟尚不存在，也无法通过配置启用，也不伪造任何能力证据。
- **阶段与步数上限只验证不执行** — 控制器拒绝超出 `phaseTimeoutMs` 或 `maxStepsPerAttempt` 的报告，但尝试运行期间的执行是宿主监督者的义务（按截止时间终止、限制步数、取消时确认子进程静默、提供受信时钟观察）。此类监督进程尚不存在；`AbortSignal` 是协作式取消，不是监督。
- **快照覆盖缺席** — 已有 dsh/Loader 组合冒烟（服务从测试专用 `cordis.yml` 启动、驱动一个生命周期并释放），但没有录制会话快照覆盖本包，因为它不注册任何模型可见界面。
- **handoff 处置为人工** — 被拒绝的日志保持拒绝状态；由人工处理文件后重新打开任务。不存在修复或自动续作路径。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
