---
description: "自开发任务的稳定侧远端门面：只读进度视图、人工确认卡数据，以及供 UI/手机显式调用的规划、预算、停止与试用审批操作。未开启时全部拒绝；本门面不存在升级批准。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development-remote

[English](README.md) | 中文

<a id="summary"></a>
## 概述

把自开发任务控制服务与受监督 runner 暴露成一个稳定的类型化 Remote 面，供 M4 UI 与手机白名单使用。门面不做决定：读路径返回任务投影与只读确认卡，写路径携带门面生成的 operationId 转发给核心控制器，试验启动只经 runner 并要求显式的人工在场确认。每任务启动档案是宿主写入的部署配置而非任务状态，`runAttempt` 从中推导省略的启动字段。仅限宿主的战役沿同一条 runner 路径自动逐轮启动，依据一次记录下来的接受。`enabled: true` 之前所有方法拒绝；服务不进入任何默认 bundle，挂载为 `selfDevelopmentRemote` 命名空间。

## 目录

- [Service](#service)
- [Methods](#methods)
- [Launch profiles](#launch-profiles)
- [Campaigns](#campaigns)
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
| `controlDirectory` | 任务控制服务的控制目录。门面读取它以列出任务日志，并只在其中写自己的 `launch-profiles/<taskId>.json` 与 `campaigns/<taskId>.json` 文件；从不触碰 `tasks/` 子树。 |
| `maxConcurrentCampaigns` | 同时 `running` 战役数的默认上限，`startCampaign` 调用未指定自己的 `maxConcurrentCampaigns` 时生效。直接构造（每个测试，以及任何不经 `cordis.yml` 加载本插件的部署）必须显式设置；`cordis.yml` schema 默认取 2。 |
| `roundDelayMs` | 一轮真正到达核心、失败之后，到下一轮启动之间的最短间隔。是纵深防御，防的是短时间内连续打出一串"已启动但失败"的轮次，不是约束轮次数量的机制——约束轮次数量的机制见下方"战役"一节的"轮次循环"。直接构造必须显式设置，与 `maxConcurrentCampaigns` 同理；`cordis.yml` schema 默认取 1000。 |

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
| `approveBudget(taskId, expectedRevision, approval)` | `approveBudget` | 记录或替换人工预算批准。actor 为 `approval.approvedBy`；已用轮数与时间从不清零。`approval.preset: 'unlimited'` 是一个便捷项，展开为固定的 24 小时时间预算（见 [Campaigns](#campaigns)）；同时显式设置的字段会覆盖其展开默认值；只有 `preset` 缺省时才要求 `mode`。 |
| `stop(taskId, expectedRevision, reason?)` | runner `stop`，否则核心 `stop` | 停止任务。runner 已加载时，其拥有的进程组与证据写入完成后才返回结果；未加载时只执行核心停止。 |
| `recordTrialApproval(taskId, expectedRevision, approvedBy)` | `recordTrialApproval` | 记录绑定当前已验证结果的人工试用批准。actor 为 `approvedBy`。 |
| `setLaunchProfile(taskId, profile)` | 档案文件写入 | 存储该任务的启动档案（见下文），替换已有档案，并返回解析后的档案。任务尚无日志时以 `self-development/task-unknown` 拒绝。仅限宿主：非宿主调用方以 `self-development/host-only-field` 拒绝。 |
| `runAttempt(request)` | runner `runAttempt` | 启动一个受监督试验。五个启动字段（`worktree`、`artifactPaths`、`acceptancePath`、`loopbackAllowlist`、`confirmedBy`）均可选：缺省字段从任务已存启动档案推导，显式传入的值优先于档案。门面组装 `PresenceConfirmation`：`confirmedAt` 取当下的一次可信时钟观测，`taskId`、`testPlanDigest` 取冻结计划，`acceptanceDefinitionDigest` 取定义字节摘要，`artifactPaths` 去重升序，acknowledgement 固定为 `supervised-not-unattended`。要求显式传入 `presenceAcknowledged: true`。仅限宿主：非宿主调用方以 `self-development/host-only-field` 拒绝——试验启动会指定 worktree、验收与产物等隔离设置——且非宿主请求不得设置仅限宿主的 `dataHome`，该字段由稳定宿主转发为 runner 的每次尝试 `dshHome`。返回 runner 结果与 `operationId`。 |
| `activeTasks()` | runner `activeTasks` | 返回 runner 当前拥有的试验的任务 id，外加本进程当前拥有战役循环的每个任务；无 runner 且无运行中战役时为 `[]`。 |
| `startCampaign(taskId, expectedRevision, options)` | runner `runAttempt`，反复调用 | 启动一次无人值守战役（见下文）。仅限宿主。 |
| `campaign(taskId)` | 只读 | 返回任务当前的 `CampaignState`；从未有过战役时为 `undefined`。仅限宿主。 |
| `stopCampaign(taskId, reason)` | runner `stop` | 取消战役正在进行的一轮并结束其循环。仅限宿主。 |

<a id="launch-profiles"></a>

### 启动档案

启动档案记录宿主的每任务启动设置，让一键启动不再要求人工填写可推导字段。`setLaunchProfile` 与 `createTask` 第三参采用同一线上形式：必填 `worktree` 与 `acceptancePath`（绝对路径），可选 `artifactPaths`、`dataHome`、`loopbackAllowlist`、`confirmedBy`。门面解析可选字段并把解析后的形式存到 `<controlDirectory>/launch-profiles/<taskId>.json`，原子写入（临时文件 + rename），文件 0600、目录 0700：

- `artifactPaths` 缺省取任务的 `allowedModificationScope`；任务尚无 spec 时没有来源，调用以 `self-development/config-invalid` 拒绝。
- `confirmedBy` 缺省取唯一的 `allowedActors` 条目；没有或不止一个时调用拒绝。推导出的确认人与显式值一样经过 actor 校验。
- `loopbackAllowlist` 缺省取 `[]`；`dataHome` 永不推导。

读路径校验已存形状：文件不是合法 JSON 或缺字段时，以 `self-development/config-invalid` 拒绝，message 只点名文件路径、不含文件内容。`getTask` 把已存档案渲染为 `card.launchProfile`；`runAttempt` 从档案推导其五个缺省启动字段，显式请求值优先于档案；既非显式又不可推导的字段以 `self-development/config-invalid` 拒绝并点名该字段，如 `runAttempt.worktree is missing and the task has no launch profile`。`presenceAcknowledged` 永不推导。

每个变更方法用 `randomUUID()` 生成 `operationId` 并返回给调用方；需要核心重放语义的重试必须带回该 id。所有参数先在门面校验，核心与 runner 的拒绝在门面边界转为 `self-development/core`，属主包的机器可路由 code 保留在 `details.code`。

<a id="campaigns"></a>
### 战役（Campaigns）

战役沿着任务已存的启动档案，经 runner 自动启动，依据的是一次记录下来的人工接受。`options.unattended` 决定这次接受覆盖的范围——不只是循环是否继续，也决定每一轮派生的确认语字面量：`true` 覆盖整个已批准的预算窗口，包括第一轮在内的每一轮都携带 `PresenceConfirmation.acknowledgement: 'unattended-accepted'`，runner README 把它定义为仅记录"人一次性接受后续轮次不再逐轮询问"这一事实；`false` 只覆盖这次调用自动启动的那一轮，因此该轮携带 `'supervised-not-unattended'`——与直接调用 `runAttempt` 断言的字面量相同，因为人确实针对那一次具体启动给出了接受。通过时仍会进入 `status: 'passed'`，与 `unattended: true` 战役共用循环唯一的成功路径；只有失败且该失败本身不是战役终态码时，才会因为 `unattended` 为 `false` 而提前停下循环。两种字面量都不是操作系统隔离保证。

`startCampaign(taskId, expectedRevision, options)` 创建战役记录并立即返回 `status: 'running'`、`rounds: 0`；它从不等待某一轮完成——只要预算允许，一轮可以运行任意长时间。`options`：

| 字段 | 含义 |
|---|---|
| `unattended` | `true`：下面这一次接受覆盖预算窗口内的每一轮自动尝试——每一轮都携带 `acknowledgement: 'unattended-accepted'`——循环持续启动新一轮直到终局状态。`false`：战役仍会自动启动第一轮——这次调用就是那一轮的显式接受，因此该轮携带 `acknowledgement: 'supervised-not-unattended'`。通过时仍会进入 `status: 'passed'`，与 `unattended: true` 战役共用循环唯一的成功路径；只有失败且该失败本身不是战役终态码时，才会因为 `unattended` 为 `false` 而提前停下（`status: 'stopped'`），后续轮次需要直接手动调用 `runAttempt`。 |
| `acceptedBy` | 接受本次战役的人；像显式的 `runAttempt.confirmedBy` 一样经过 `allowedActors` 校验，并记录为每一轮派生的 `PresenceConfirmation.confirmedBy`。 |
| `maxConcurrentCampaigns?` | 仅本次调用生效的同时 `running` 战役数上限；缺省取部署配置的 `maxConcurrentCampaigns`（其本身默认 2）。超出上限，或该任务已有运行中战役，均以 `self-development/config-invalid` 拒绝。 |

每个启动字段（`worktree`、`artifactPaths`、`acceptancePath`、`loopbackAllowlist`）都像 `runAttempt` 省略字段一样从任务已存启动档案推导——战役不接受逐轮覆盖，因此 `startCampaign`要求已经设置好启动档案。`dataHome` 永不转发给战役轮次，这与 `runAttempt` 自身的行为一致：只有显式的线上请求才携带它。

**轮次循环。** 每一轮都调用 `runAttempt` 所用的同一条 runner 路径，携带新派生的 `PresenceConfirmation`（新的受信时钟观察）与新生成的 `operationId`——绝不是缓存或复用的确认。每一轮（含第一轮）启动前，循环先读一次核心的实时状态，再启动：

```
Live status read, ahead of every round:
  status: ready                                       → launch the round, below
  status: stopped, reason no-progress or budget-exhausted → exhausted  (campaign-ended event)
  status: stopped, any other reason, or any other status  → stopped    (campaign-ended event)

Launching the round:
running --[round passes]--------------------------------------------------> passed    (campaign-passed event)
running --[round refused: budget exhausted]---------------------------------> exhausted (campaign-ended event)
running --[round rejected before the core committed attempt/started]--------> failed    (campaign-ended event)
running --[round cancelled, e.g. by a concurrent stopCampaign]---------------> stopped   (campaign-ended event)
running --[round fails at the core, unattended: true, budget allows more]---> running (next round, after roundDelayMs)
running --[round fails at the core, unattended: false]------------------------> stopped   (campaign-ended event)
running --[unrecognized exception]---------------------------------------------> failed    (campaign-ended event)
running --[stopCampaign call]-----------------------------------------------------> stopped  (campaign-ended event)
```

实时状态检查存在的原因：核心可能在某一轮结算后反应式地把任务停下——无进展上限或预算下限在核心自己的失败后处理里触发——而这一轮自己的拒绝从不携带这个停止事实；只有下一轮启动前的这次读取才能可靠地捕捉到它，而不是盲目重试进去。

一轮在核心提交 `attempt/started` 之前就被拒绝——验收定义不可读、格式不对、或放在了实验根目录之内，确认没有绑定真实的启动事实，重放操作的启动记录对不上，或任何本包未特别识别的其他拒绝——会让战役立即以 `failed` 结束：不重试，也不计入 `rounds`。以上三个可识别的 runner 错误码无需借助其他手段即可判定；其余每一种拒绝，能否与一次到达核心的普通失败区分开，靠的是核心自己的 revision（轮次前后各读一次），绝不单靠错误码——一轮如果从未到达核心，无论表面上是什么错误，核心的 revision 都不会前进。一次真正到达核心的普通轮次失败（验收失败或迟到，或任何其他在核心留下记录的可识别 runner 错误）会被重试，就像人工重试一次失败的 `runAttempt` 一样，重试前先等待 `roundDelayMs`——这是纵深防御，防的是背靠背打出一串这样的轮次，不是约束轮次数量的机制；真正约束一个持续失败任务的是下一轮启动前的实时状态检查，经由核心自己的 `noProgressAttemptLimit`，这也是为什么 `preset: 'unlimited'` 总会设置该字段。只有本包完全无法识别为核心或 runner 错误的异常——是崩溃，不是轮次结果——才会以同样的方式让战役以 `failed` 结束且不重试；其消息绝不会被吞掉。

`stopCampaign(taskId, reason)` 先经 runner 取消当前在途的一轮，再以给定的 `reason` 把战役收尾为 `stopped`。幂等：对已处于终态的战役调用是空操作，原样返回已存状态。并发的收尾方（`stopCampaign` 与循环自身的收尾竞争）不会相互破坏：恰好一次写入胜出，其余每个调用方——包括在胜出者完成之前就已开始的 `stopCampaign`——都会返回那同一个真实结果，绝不是自己那份收尾前的过期视图。

战役记录存放在 `<controlDirectory>/campaigns/<taskId>.json`，原子写入（临时文件 + rename），文件 0600、目录 0700，是门面独占拥有的每任务运行时状态——核心日志从不记录它。构造时，本进程会把它发现的每个 `running` 战役标记为 `stopped`，reason 为 `process restarted`（惰性扫描一次，在第一次战役方法调用之前）——战役从不跨重启自动续跑，因此被崩溃进程留下的无人值守战役会保持停止状态，直到有人重新调用 `startCampaign`。这次重启恢复直接写记录，不发出 `campaign-ended` 事件；消费方必须轮询 `campaign(taskId)` 才能得知。

**预算便捷项。** `approveBudget` 的 `preset: 'unlimited'` 在核心看到它之前展开为 `{ mode: 'time', durationMs: 86_400_000, noProgressAttemptLimit: 5 }`——无每次尝试步数/调用上限（`time` 模式无需携带,故 `unlimited` 不设）、无每阶段上限、无 token 上限；任何同时显式设置的字段都会覆盖或补充该默认值。`durationMs`——无论显式还是由 preset 展开——硬性上限为 24 小时；更大的值一律以 `self-development/config-invalid` 拒绝，与是否使用 `preset` 无关。

<a id="permission-model"></a>
## 权限模型

门面在连接层鉴权之上只加三个闸门：

- **`enabled`** — `false` 时所有方法以 `self-development/disabled` 拒绝，因此仅挂载插件不会启用任何能力。
- **`allowedActors`** — 为空表示不限制；非空时约束携带 actor 的操作：`createTask`（`spec.createdBy`）、`confirmPlan`（`actor` 参数）、`approveBudget`（`approval.approvedBy`）、`recordTrialApproval`（`approvedBy`）、`runAttempt`（`confirmedBy`）。进度读取、规划授权、草拟与停止对任何 actor 开放，因为看进度、插话与停止正是手机白名单面向的低风险操作。
- **调用方来源** — 门面读取可选连接服务的调用方上下文（`ctx.connection.caller.current()`，即冻结的 `ConnectionCaller` 契约），仅当请求携带回环 Host 头、或完全没有调用方上下文时视为稳定宿主；非回环 Host 头即手机调用方。`runAttempt`、`createTask` 与 `setLaunchProfile` 会指定隔离设置——试验启动的 worktree、验收路径、产物路径与 `dataHome`；任务的 `stableBaselineDigest` 与 `allowedModificationScope`——因此手机调用方调用三者时，门面在触碰核心或 runner 之前即以 `self-development/host-only-field` 拒绝，且手机调用方不得设置或替换任务的启动档案。`startCampaign`、`campaign` 与 `stopCampaign` 整体仅限宿主——不同于上面的逐字段闸门，手机调用方连读方法也一并拒绝——因为战役既指定隔离设置，又携带一次性的无人值守在场接受。读方法、`authorizePlanning`、`submitPlanDraft`、`confirmPlan`、`approveBudget`、`stop` 与 `recordTrialApproval` 对手机保持可用。

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
| 发起/查看/停止无人值守战役 | 整体仅限宿主，含读方法。`startCampaign`、`campaign`、`stopCampaign` 手机调用方一律以 `self-development/host-only-field` 拒绝。 |
| 升级批准 | **本门面不存在。** 没有任何方法记录升级、发布或安装批准；发布审核表在本包之外。 |
| 访问试验版 | 不暴露。门面只在 `runAttempt` 结果中返回证据路径；没有方法读取试验产物。 |
| 修改隔离与凭据设置 | 不暴露。门面配置不含隔离或凭据字段，也没有方法修改 runner 配置。 |
| 指定任务数据目录 | 手机端不可指定。`runAttempt` 的 `dataHome` 仅限宿主：稳定侧传入工作区 `allocate` 结果的 `dataHome`；设置该字段的非宿主请求被拒绝。 |

<a id="error-codes"></a>
## 错误码

`SelfDevelopmentRemoteError` 是真正的 `RemoteError`，因此每种拒绝的机器可路由 code 都能穿过网关保留；下表 code 词表在 `src/errors.ts` 中合并进共享的 `RemoteErrorDetailsMap`：

| Code | 含义 |
|---|---|
| `self-development/config-invalid` | 服务配置或 Remote 参数在门面边界未通过形状校验；同一 code 也用于拒绝损坏或缺字段的已存启动档案或战役记录、既非显式又不可推导的 `runAttempt` 启动字段、任务已有运行中战役或将超出 `maxConcurrentCampaigns` 的 `startCampaign`、没有战役记录的 `stopCampaign`，以及既无 `mode` 也无 `preset`、或 `durationMs` 超过 24 小时上限的 `approveBudget`。 |
| `self-development/disabled` | 门面未开启；所有方法拒绝。 |
| `self-development/actor-forbidden` | 操作的 actor 不在配置的白名单内。 |
| `self-development/host-only-field` | 非宿主调用方调用了 `runAttempt`、`createTask`、`setLaunchProfile`、`startCampaign`、`campaign` 或 `stopCampaign`，或设置了标记 `hostOnly` 的线上字段（当前为 `runAttempt.dataHome` 与全部 `launchProfile` 字段）。 |
| `self-development/presence-unconfirmed` | `runAttempt` 未收到 `presenceAcknowledged: true`。 |
| `self-development/runner-unavailable` | 试验相关方法，或 `startCampaign`/`stopCampaign`，需要受监督 runner 插件，但插件未加载。 |
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
- **无人值守战役不是隔离保证** — `unattended-accepted` 记录的是一次性人工接受，绝不是持续在场、沙箱化或配额强制。runner 自己 README 所述的每一条限制（同用户执行、无进程组逃逸防护、没有 Windows 或 Linux 时钟源）对战役启动的每一轮都同样成立。24 小时、受 `noProgressAttemptLimit` 约束的预算是时间与轮数上限，不是安全边界。
- **战役一轮不接受逐轮覆盖** — 每个启动字段都来自任务已存的启动档案；战役不能在轮次之间改变 worktree、产物路径、验收路径、回环端口允许清单或数据目录。战役进行中要改变它们，需要先停止、重新调用 `setLaunchProfile`，再启动一个新的。
- **战役收尾的竞态被化解，而非被阻止** — `stopCampaign` 与循环自身的自然收尾（一轮通过、预算耗尽，或无法识别的崩溃）竞争时，绝不会破坏记录或重复上报事件，但两个并发 `stopCampaign` 的 reason 最终哪一个被持久化，调用方无法从自己这一侧确定。
- **未到达核心护栏是对核心 revision 的一次观测，不是 runner 或验收器自证的属性** — 循环从"这一轮结束后 revision 未变"（轮次前后各读一次）推断"这一轮从未提交 attempt/started"；它从不检查 runner 或验收器自身的内部状态，也无法区分"确实从未启动"与一个假设性的核心 bug——提交了什么却没有把它反映到上报的 revision 里。`roundDelayMs` 只在护栏没有拦下的那种轮次（它已独立确认到达了核心）之后才等待，绝不会延迟护栏自身的立即终止。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

None.

</details>
