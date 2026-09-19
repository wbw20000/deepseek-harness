---
description: "自开发任务的稳定侧远端门面：只读进度视图、人工确认卡数据，以及供 UI/手机显式调用的规划、预算、停止与试用审批操作。未开启时全部拒绝；本门面不存在升级批准。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development-remote

[English](README.md) | 中文

<a id="summary"></a>
## 概述

把自开发任务控制服务与受监督 runner 暴露成一个稳定的类型化 Remote 面，供 M4 UI 与手机白名单使用。门面不持有状态、不做决定：读路径返回任务投影与只读确认卡，写路径携带门面生成的 operationId 转发给核心控制器，试验启动只经 runner 并要求显式的人工在场确认。部署设置 `enabled: true` 之前，所有方法以 `SELF_DEV_REMOTE_DISABLED` 拒绝；服务不进入任何默认 bundle，profile 必须显式登记插件，此后 Typert 网关以 `selfDevelopmentRemote` 命名空间挂载它。

## 目录

- [Service](#service)
- [Methods](#methods)
- [Permission model](#permission-model)
- [Phone whitelist mapping](#phone-whitelist-mapping)
- [Error codes](#error-codes)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="service"></a>
## 服务

`SelfDevelopmentRemote`（默认导出，Cordis 服务 `selfDevelopmentRemote`，线上命名空间 `selfDevelopmentRemote`）注入任务控制服务并可选解析受监督 runner：runner 插件未加载时，所有与试验相关的方法以 `SELF_DEV_REMOTE_RUNNER_UNAVAILABLE` 拒绝；读路径与停止的回退路径仅依赖任务控制服务。

| Config 字段 | 含义 |
|---|---|
| `enabled` | 总开关。默认 `false`；为 `false` 时所有方法返回 `SELF_DEV_REMOTE_DISABLED`。 |
| `allowedActors` | 操作者白名单。为空（默认）表示不限制；非空时操作的 actor 字段必须出现在列表中。 |
| `controlDirectory` | 任务控制服务的控制目录。门面只读取它以列出任务日志，从不写入。 |

`controlDirectory` 重复了任务控制服务的值，因为该服务不公开其已解析配置，且本包不得修改它。门面在构造时校验该路径，相对路径在加载即失败。


本包不发布运行时不变式伴生包：门面自身不暴露任何运行时观测流，它在确认卡视图、投影与核心日志之间转发的所有关系都由聚焦的行为测试覆盖；唯一无法自行核验的部署耦合——其 `controlDirectory` 必须与任务控制服务一致——作为已知限制记录，而非用进程内断言。

<a id="methods"></a>
## 方法

下述每个方法都是 `@Remote` 方法。普通聊天消息无法触达它们：调用方必须经 Typert 网关显式调用端点，且连接层自身的鉴权先于门面执行。

| 方法 | 转发 | 约定 |
|---|---|---|
| `listTasks()` | 只读 | 扫描 `<controlDirectory>/tasks/*`，每个任务一行：`taskId`、`status`、`revision`、`title`（requirement 前 80 字）。尚无任务时返回 `[]`；该读路径从不创建任务日志目录。 |
| `getTask(taskId)` | 只读 | 返回任务的 `TaskProjection` 与 `card`（只读确认卡视图）。任务尚无日志时以 `SELF_DEV_REMOTE_TASK_UNKNOWN` 拒绝。 |
| `recentEvents()` | 只读 | 返回事件消费方的标题级通知缓冲（从旧到新）；事件消费方插件未加载时返回 `[]`。 |
| `createTask(spec, expectedRevision)` | `createTask` | 按 TaskSpec 线上形式创建任务。actor 为 `spec.createdBy`。返回门面生成的 `operationId`。 |
| `authorizePlanning(taskId, expectedRevision, authorizedBy)` | `authorizePlanning` | 授予独立的规划授权；它不批准开发，也不消耗轮数。 |
| `submitPlanDraft(taskId, expectedRevision, draft)` | `submitPlanDraft` | 提交草拟计划，等待人工确认。 |
| `confirmPlan(taskId, expectedRevision, plan, actor)` | `confirmPlan` | 冻结人工确认的计划。actor 为显式的 `actor` 参数。 |
| `approveBudget(taskId, expectedRevision, approval)` | `approveBudget` | 记录或替换人工预算批准。actor 为 `approval.approvedBy`；已用轮数与时间从不清零。 |
| `stop(taskId, expectedRevision, reason?)` | runner `stop`，否则核心 `stop` | 停止任务。runner 已加载时，其拥有的进程组与证据写入完成后才返回结果；未加载时只执行核心停止。 |
| `recordTrialApproval(taskId, expectedRevision, approvedBy)` | `recordTrialApproval` | 记录绑定当前已验证结果的人工试用批准。actor 为 `approvedBy`。 |
| `runAttempt(request)` | runner `runAttempt` | 启动一个受监督试验。门面组装 `PresenceConfirmation`：`confirmedAt` 取当下的一次可信时钟观测，`taskId`、`testPlanDigest` 取冻结计划，`acceptanceDefinitionDigest` 取定义字节摘要，`artifactPaths` 去重升序，acknowledgement 固定为 `supervised-not-unattended`。要求显式传入 `presenceAcknowledged: true`。请求中可选的 `dataHome` 仅限宿主侧，并转发为 runner 的每次尝试 `dshHome`；手机端调用必须省略该字段。返回 runner 结果与 `operationId`。 |
| `activeTasks()` | runner `activeTasks` | 返回 runner 当前拥有的试验的任务 id；无 runner 时为 `[]`。 |

每个变更方法用 `randomUUID()` 生成 `operationId` 并返回给调用方；需要核心重放语义的重试必须带回该 id。所有参数先在门面校验，核心与 runner 的拒绝原样透传，保留属主包的机器可路由 code。

<a id="permission-model"></a>
## 权限模型

门面在连接层鉴权之上只加两个部署侧闸门：

- **`enabled`** — `false` 时所有方法以 `SELF_DEV_REMOTE_DISABLED` 拒绝，因此仅挂载插件不会启用任何能力。
- **`allowedActors`** — 为空表示不限制；非空时约束携带 actor 的操作：`createTask`（`spec.createdBy`）、`confirmPlan`（`actor` 参数）、`approveBudget`（`approval.approvedBy`）、`recordTrialApproval`（`approvedBy`）、`runAttempt`（`confirmedBy`）。进度读取、规划授权、草拟与停止对任何调用方开放，因为看进度、插话与停止正是手机白名单面向的低风险操作。

人工在场确认永不被推断：请求未字面携带 `presenceAcknowledged: true` 时，`runAttempt` 以 `SELF_DEV_REMOTE_PRESENCE_UNCONFIRMED` 拒绝；UI 不得默认勾选、预选或暗示该字段。

`runAttempt` 的 `dataHome` 在线上 schema 中标记为仅宿主侧（host-only），只接受来自稳定宿主的调用：每任务的数据目录由工作区服务的 `allocate` 结果分配，稳定侧把该 `dataHome` 转发为 runner 的 `dshHome`；手机端请求必须省略该字段——schema 的 `hostOnly` 标记为未来的手机通道记录了这一约束。

<a id="phone-whitelist-mapping"></a>
## 手机白名单对照

人工审核确认卡允许手机操作：看进度、插话、确认计划与预算、停止、审批继续/驳回；不允许升级批准、访问试验版、修改隔离与凭据设置。

| 手机能力 | 门面方法 |
|---|---|
| 看进度 | `listTasks`、`getTask`、`activeTasks` |
| 插话 | `submitPlanDraft`、`authorizePlanning` |
| 确认计划与预算 | `confirmPlan`、`approveBudget` |
| 停止 | `stop` |
| 审批继续/驳回 | `runAttempt`、`recordTrialApproval` |
| 升级批准 | **本门面不存在。** 没有任何方法记录升级、发布或安装批准；发布审核表在本包之外。 |
| 访问试验版 | 不暴露。门面只在 `runAttempt` 结果中返回证据路径；没有方法读取试验产物。 |
| 修改隔离与凭据设置 | 不暴露。门面配置不含隔离或凭据字段，也没有方法修改 runner 配置。 |
| 指定任务数据目录 | 手机端不可指定。`runAttempt` 的 `dataHome` 仅限宿主侧：稳定侧传入工作区 `allocate` 结果的 `dataHome`；手机端请求必须省略该字段。 |

<a id="error-codes"></a>
## 错误码

`SelfDevelopmentRemoteError` 携带下列机器可路由 code 之一；核心与 runner 错误从不被包装：

| Code | 含义 |
|---|---|
| `SELF_DEV_REMOTE_CONFIG_INVALID` | 服务配置或 Remote 参数在门面边界未通过形状校验。 |
| `SELF_DEV_REMOTE_DISABLED` | 门面未开启；所有方法拒绝。 |
| `SELF_DEV_REMOTE_ACTOR_FORBIDDEN` | 操作的 actor 不在配置的白名单内。 |
| `SELF_DEV_REMOTE_PRESENCE_UNCONFIRMED` | `runAttempt` 未收到 `presenceAcknowledged: true`。 |
| `SELF_DEV_REMOTE_RUNNER_UNAVAILABLE` | 试验相关方法需要受监督 runner 插件，但插件未加载。 |
| `SELF_DEV_REMOTE_TASK_UNKNOWN` | 读路径寻址的任务没有日志目录。 |

核心 code（任务控制包的 `SELF_DEV_*`）与 runner code（`SELF_DEV_RUNNER_*`）原样透传，包括 `SELF_DEV_JOURNAL_UNAVAILABLE`——调用方必须把它作为交接呈现。

<a id="further-exploration"></a>
## 延伸阅读

- [Workflow 子系统](../../../docs/subsystems/workflow.zh.md) — workflow 接缝、任务控制服务与受监督 runner。
- [Workflow 组 README](../../README.zh.md) — 可选自开发包及其角色。

<a id="model-experience"></a>
## 模型体验

无：本服务不注册任何模型可见的工具、提示词或事件，且普通聊天消息无法触达其方法。

#### KV Cache 效应

本服务不添加提示词前缀，也没有模型可见表面。

## Known Limitations and Deferred Work

- **`controlDirectory` 被配置两次** — 门面重复任务控制服务的目录，因为该服务不公开其已解析配置。两个字段指向不同目录的部署会得到空列表或失败的任务列表，而非加载期错误；没有交叉校验。
- **卡片不携带预算依据** — 本增量没有相似历史数据源，`suggestedBudgetBasis` 恒为字面 `无依据`。未来的历史服务替换该常量。
- **费用限制恒为拒绝** — 门面不知道任何余额，`costLimits` 恒为字面 `未知，不放行`。未知余额不会自动放行。
- **`listTasks` 打开每个任务日志** — 每行经核心服务读取完整任务日志，任务多的控制目录按比例付出读取成本；打开一个留有上个进程在途试验的任务时，会记录核心自身的“中断试验恢复”事件。
- **没有网关侧限流或审计日志** — 门面依赖连接层鉴权；除核心日志记录的转发操作外，它不记录谁调用了哪个方法的审计日志。
- **升级批准在设计上不在范围内** — 发布审核表未在本包任何位置实现；没有门面方法能在没有新评审契约的情况下延伸成升级路径。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

None.

</details>
