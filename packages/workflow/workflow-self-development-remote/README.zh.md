---
description: "自开发任务的稳定侧远端门面：只读进度视图、人工确认卡数据，以及供 UI/手机显式调用的规划、预算、停止与试用审批操作。未开启时全部拒绝；本门面不存在升级批准。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development-remote

[English](README.md) | 中文

<a id="summary"></a>
## 概述

把自开发任务控制服务与受监督 runner 暴露成一个稳定的类型化 Remote 面，供 M4 UI 与手机白名单使用。门面不做决定：读路径返回任务投影与只读确认卡，写路径携带门面生成的 operationId 转发给核心控制器，试验启动只经 runner 并要求显式的人工在场确认。每任务启动档案是宿主写入的部署配置而非任务状态，`runAttempt` 从中推导省略的启动字段。`enabled: true` 之前所有方法拒绝；服务不进入任何默认 bundle，挂载为 `selfDevelopmentRemote` 命名空间。

## 目录

- [Service](#service)
- [Methods](#methods)
- [Launch profiles](#launch-profiles)
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

`SelfDevelopmentRemote`（默认导出，Cordis 服务 `selfDevelopmentRemote`，线上命名空间 `selfDevelopmentRemote`）注入任务控制服务，可选解析受监督 runner——runner 插件未加载时，所有与试验相关的方法以 `self-development/runner-unavailable` 拒绝，读路径与停止的回退路径仅依赖任务控制服务——并在连接服务已挂载时用 `ctx.get` 读取其调用方上下文（见权限模型）。

| Config 字段 | 含义 |
|---|---|
| `enabled` | 总开关。默认 `false`；为 `false` 时所有方法返回 `self-development/disabled`。 |
| `allowedActors` | 操作者白名单。为空（默认）表示不限制；非空时操作的 actor 字段必须出现在列表中。 |
| `controlDirectory` | 任务控制服务的控制目录。门面读取它以列出任务日志，并只在其中写自己的 `launch-profiles/<taskId>.json` 文件；从不触碰 `tasks/` 子树。 |

`controlDirectory` 重复了任务控制服务的值，因为该服务不公开其已解析配置，且本包不得修改它。门面在构造时校验该路径，相对路径在加载即失败。


本包不发布运行时不变式伴生包：门面自身不暴露任何运行时观测流，它在确认卡视图、投影与核心日志之间转发的所有关系都由聚焦的行为测试覆盖；唯一无法自行核验的部署耦合——其 `controlDirectory` 必须与任务控制服务一致——作为已知限制记录，而非用进程内断言。

<a id="methods"></a>
## 方法

下述每个方法都是 `@Remote` 方法。普通聊天消息无法触达它们：调用方必须经 Typert 网关显式调用端点，且连接层自身的鉴权先于门面执行。

| 方法 | 转发 | 约定 |
|---|---|---|
| `listTasks()` | 只读 | 扫描 `<controlDirectory>/tasks/*`，每个任务一行：`taskId`、`status`、`revision`、`title`（requirement 前 80 字）。尚无任务时返回 `[]`；该读路径从不创建任务日志目录。 |
| `getTask(taskId)` | 只读 | 返回任务的 `TaskProjection` 与 `card`（只读确认卡视图）。宿主已设置启动档案时，卡的 `launchProfile` 携带填满全部推导字段的已存档案。任务尚无日志时以 `self-development/task-unknown` 拒绝。 |
| `recentEvents()` | 只读 | 返回事件消费方的标题级通知缓冲（从旧到新）；事件消费方插件未加载时返回 `[]`。 |
| `createTask(spec, expectedRevision, launchProfile?)` | `createTask` | 按 TaskSpec 线上形式创建任务。actor 为 `spec.createdBy`。携带 `launchProfile` 时，已解析档案只在核心提交创建之后写入，创建失败不会留下档案文件。返回门面生成的 `operationId`。仅限宿主：非宿主调用方以 `self-development/host-only-field` 拒绝，因为 spec 固化了 `stableBaselineDigest` 与 `allowedModificationScope`，且档案固化试验的隔离与确认设置。 |
| `authorizePlanning(taskId, expectedRevision, authorizedBy)` | `authorizePlanning` | 授予独立的规划授权；它不批准开发，也不消耗轮数。 |
| `submitPlanDraft(taskId, expectedRevision, draft)` | `submitPlanDraft` | 提交草拟计划，等待人工确认。 |
| `confirmPlan(taskId, expectedRevision, plan, actor)` | `confirmPlan` | 冻结人工确认的计划。actor 为显式的 `actor` 参数。 |
| `approveBudget(taskId, expectedRevision, approval)` | `approveBudget` | 记录或替换人工预算批准。actor 为 `approval.approvedBy`；已用轮数与时间从不清零。 |
| `stop(taskId, expectedRevision, reason?)` | runner `stop`，否则核心 `stop` | 停止任务。runner 已加载时，其拥有的进程组与证据写入完成后才返回结果；未加载时只执行核心停止。 |
| `recordTrialApproval(taskId, expectedRevision, approvedBy)` | `recordTrialApproval` | 记录绑定当前已验证结果的人工试用批准。actor 为 `approvedBy`。 |
| `setLaunchProfile(taskId, profile)` | 档案文件写入 | 存储该任务的启动档案（见下文），替换已有档案，并返回解析后的档案。任务尚无日志时以 `self-development/task-unknown` 拒绝。仅限宿主：非宿主调用方以 `self-development/host-only-field` 拒绝。 |
| `runAttempt(request)` | runner `runAttempt` | 启动一个受监督试验。五个启动字段（`worktree`、`artifactPaths`、`acceptancePath`、`loopbackAllowlist`、`confirmedBy`）均可选：缺省字段从任务已存启动档案推导，显式传入的值优先于档案。门面组装 `PresenceConfirmation`：`confirmedAt` 取当下的一次可信时钟观测，`taskId`、`testPlanDigest` 取冻结计划，`acceptanceDefinitionDigest` 取定义字节摘要，`artifactPaths` 去重升序，acknowledgement 固定为 `supervised-not-unattended`。要求显式传入 `presenceAcknowledged: true`。仅限宿主：非宿主调用方以 `self-development/host-only-field` 拒绝——试验启动会指定 worktree、验收与产物等隔离设置——且非宿主请求不得设置仅限宿主的 `dataHome`，该字段由稳定宿主转发为 runner 的每次尝试 `dshHome`。返回 runner 结果与 `operationId`。 |
| `activeTasks()` | runner `activeTasks` | 返回 runner 当前拥有的试验的任务 id；无 runner 时为 `[]`。 |

<a id="launch-profiles"></a>

### 启动档案

启动档案记录宿主的每任务启动设置，让一键启动不再要求人工填写可推导字段。`setLaunchProfile` 与 `createTask` 第三参采用同一线上形式：必填 `worktree` 与 `acceptancePath`（绝对路径），可选 `artifactPaths`、`dataHome`、`loopbackAllowlist`、`confirmedBy`。门面解析可选字段并把解析后的形式存到 `<controlDirectory>/launch-profiles/<taskId>.json`，原子写入（临时文件 + rename），文件 0600、目录 0700：

- `artifactPaths` 缺省取任务的 `allowedModificationScope`；任务尚无 spec 时没有来源，调用以 `self-development/config-invalid` 拒绝。
- `confirmedBy` 缺省取唯一的 `allowedActors` 条目；没有或不止一个时调用拒绝。推导出的确认人与显式值一样经过 actor 校验。
- `loopbackAllowlist` 缺省取 `[]`；`dataHome` 永不推导。

读路径校验已存形状：文件不是合法 JSON 或缺字段时，以 `self-development/config-invalid` 拒绝，message 只点名文件路径、不含文件内容。`getTask` 把已存档案渲染为 `card.launchProfile`；`runAttempt` 从档案推导其五个缺省启动字段，显式请求值优先于档案；既非显式又不可推导的字段以 `self-development/config-invalid` 拒绝并点名该字段，如 `runAttempt.worktree is missing and the task has no launch profile`。`presenceAcknowledged` 永不推导。

每个变更方法用 `randomUUID()` 生成 `operationId` 并返回给调用方；需要核心重放语义的重试必须带回该 id。所有参数先在门面校验，核心与 runner 的拒绝在门面边界转为 `self-development/core`，属主包的机器可路由 code 保留在 `details.code`。

<a id="permission-model"></a>
## 权限模型

门面在连接层鉴权之上只加三个闸门：

- **`enabled`** — `false` 时所有方法以 `self-development/disabled` 拒绝，因此仅挂载插件不会启用任何能力。
- **`allowedActors`** — 为空表示不限制；非空时约束携带 actor 的操作：`createTask`（`spec.createdBy`）、`confirmPlan`（`actor` 参数）、`approveBudget`（`approval.approvedBy`）、`recordTrialApproval`（`approvedBy`）、`runAttempt`（`confirmedBy`）。进度读取、规划授权、草拟与停止对任何 actor 开放，因为看进度、插话与停止正是手机白名单面向的低风险操作。
- **调用方来源** — 门面读取可选连接服务的调用方上下文（`ctx.connection.caller.current()`，即冻结的 `ConnectionCaller` 契约），仅当请求携带回环 Host 头、或完全没有调用方上下文时视为稳定宿主；非回环 Host 头即手机调用方。`runAttempt`、`createTask` 与 `setLaunchProfile` 会指定隔离设置——试验启动的 worktree、验收路径、产物路径与 `dataHome`；任务的 `stableBaselineDigest` 与 `allowedModificationScope`——因此手机调用方调用三者时，门面在触碰核心或 runner 之前即以 `self-development/host-only-field` 拒绝，且手机调用方不得设置或替换任务的启动档案。读方法、`authorizePlanning`、`submitPlanDraft`、`confirmPlan`、`approveBudget`、`stop` 与 `recordTrialApproval` 对手机保持可用。

未挂载连接服务、或调用发生在任何 `@Remote` 请求之外时，没有调用方上下文，该调用按宿主处理：这是本机直连与测试语义。这也意味着门面自身不会硬化手机通道——必须挂载连接服务，调用方来源闸门才会生效。

人工在场确认永不被推断：请求未字面携带 `presenceAcknowledged: true` 时，`runAttempt` 以 `self-development/presence-unconfirmed` 拒绝；UI 不得默认勾选、预选或暗示该字段。

`runAttempt` 的 `dataHome` 在线上 schema 中标记为 `hostOnly`：每任务的数据目录由工作区服务的 `allocate` 结果分配，稳定侧把该 `dataHome` 转发为 runner 的 `dshHome`，手机端请求必须省略该字段。wire 层按 schema 元数据自动收集所有 `hostOnly` 字段并检查解析后的请求（`assertHostOnlyFields`），因此未来新增仅限宿主的字段只需标记 `.meta({ hostOnly: true })`，不需要新的拒绝代码。

<a id="phone-whitelist-mapping"></a>
## 手机白名单对照

人工审核确认卡允许手机操作：看进度、插话、确认计划与预算、停止、审批继续/驳回；不允许发起任务或试验、升级批准、访问试验版、修改隔离与凭据设置。

| 手机能力 | 门面方法 |
|---|---|
| 看进度 | `listTasks`、`getTask`、`activeTasks` |
| 插话 | `submitPlanDraft`、`authorizePlanning` |
| 确认计划与预算 | `confirmPlan`、`approveBudget` |
| 停止 | `stop` |
| 审批继续/驳回 | `recordTrialApproval` |
| 创建任务 | 仅限宿主。`createTask` 固化 `stableBaselineDigest` 与 `allowedModificationScope`；手机调用方以 `self-development/host-only-field` 拒绝。 |
| 设置启动档案 | 仅限宿主。`setLaunchProfile` 与 `createTask` 第三参固化试验的隔离与确认设置；手机调用方以 `self-development/host-only-field` 拒绝。 |
| 发起试验 | 仅限宿主。`runAttempt` 指定 worktree、验收与产物等隔离设置；手机调用方以 `self-development/host-only-field` 拒绝。 |
| 升级批准 | **本门面不存在。** 没有任何方法记录升级、发布或安装批准；发布审核表在本包之外。 |
| 访问试验版 | 不暴露。门面只在 `runAttempt` 结果中返回证据路径；没有方法读取试验产物。 |
| 修改隔离与凭据设置 | 不暴露。门面配置不含隔离或凭据字段，也没有方法修改 runner 配置。 |
| 指定任务数据目录 | 手机端不可指定。`runAttempt` 的 `dataHome` 仅限宿主：稳定侧传入工作区 `allocate` 结果的 `dataHome`；设置该字段的非宿主请求被拒绝。 |

<a id="error-codes"></a>
## 错误码

`SelfDevelopmentRemoteError` 是真正的 `RemoteError`，因此每种拒绝的机器可路由 code 都能穿过网关保留；下表 code 词表在 `src/errors.ts` 中合并进共享的 `RemoteErrorDetailsMap`：

| Code | 含义 |
|---|---|
| `self-development/config-invalid` | 服务配置或 Remote 参数在门面边界未通过形状校验；同一 code 也用于拒绝损坏或缺字段的已存启动档案，以及既非显式又不可推导的 `runAttempt` 启动字段。 |
| `self-development/disabled` | 门面未开启；所有方法拒绝。 |
| `self-development/actor-forbidden` | 操作的 actor 不在配置的白名单内。 |
| `self-development/host-only-field` | 非宿主调用方调用了 `runAttempt`、`createTask` 或 `setLaunchProfile`，或设置了标记 `hostOnly` 的线上字段（当前为 `runAttempt.dataHome` 与全部 `launchProfile` 字段）。 |
| `self-development/presence-unconfirmed` | `runAttempt` 未收到 `presenceAcknowledged: true`。 |
| `self-development/runner-unavailable` | 试验相关方法需要受监督 runner 插件，但插件未加载。 |
| `self-development/task-unknown` | 读路径寻址的任务没有日志目录。 |

核心 code（任务控制包的 `SELF_DEV_*`）与 runner code（`SELF_DEV_RUNNER_*`）在门面边界被转换为 `self-development/core`，其 `details.code` 携带所属包的原码——包括 `SELF_DEV_JOURNAL_UNAVAILABLE`，调用方必须把它作为交接呈现。没有这层转换时，网关会把拒绝折叠为 `gateway/internal`，手机调用方无从分辨原因。

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
