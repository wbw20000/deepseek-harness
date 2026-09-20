---
description: "聊天侧自开发发起器：Agent 工具起草任务、只向用户要一次审批，放行后自动驱动稳定侧门面完成工作区分配、验收定义写入、规划、预算与无人值守战役，再把结果投影回聊天。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development-chat

[English](README.md) | 中文

<a id="summary"></a>
## 概述

让用户能在一条普通聊天消息里发起自开发战役。`self_development_propose` 起草需求、验收用例与预算，展示一张列出其覆盖一切的审批卡，`allowed-once` 放行后自动驱动稳定侧门面，从工作区分配经任务创建、规划、预算批准直到战役启动。`self_development_status` 汇报进度；`self_development_stop` 结束正在运行的战役。战役结算时，本包会尽力把结果作为聊天消息投递给发起它的 Agent。本包不实现隔离、也从不代替用户点"允许"——见[已知限制](#known-limitations-and-deferred-work)。

## 目录

- [Service](#service)
- [工具](#tools)
- [八步顺序](#the-eight-step-sequence)
- [任务 id 与基线摘要](#task-id-and-baseline-digest)
- [战役结果通知](#campaign-result-notices)
- [自迭代模式](#self-iterate-mode)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="service"></a>
## Service

`SelfDevelopmentChat`（默认导出，Cordis 服务 `selfDevelopmentChat`）把 `tools` 与 `approval` 声明为硬依赖注入——没有工具注册表与审批应答者，插件不会加载。稳定侧门面、工作区服务、事件服务与试用服务全部用 `ctx.get(...)` 结构式读取，而不是声明为带类型的注入，因为本包是照着 DH-a/DH-c 的冻结接口先行开发的，此刻并非每个 worktree 都有这些包的源码；集成后真实服务会满足同一套结构形状。

| Config 字段 | 含义 |
|---|---|
| `stableRepo` | 稳定分支所在仓库的绝对路径，其 `HEAD` 用于生成 `stableBaselineDigest`。 |
| `controlDirectory` | 本包写入验收定义的绝对目录（`<controlDirectory>/acceptance/<taskId>.json`，0600 权限、目录 0700）；也是 `self_development_status` 汇报的派生路径 `<controlDirectory>/campaigns/<taskId>.json` 的基准目录。 |
| `experimentsRoot` | 未挂载工作区服务时用于解析任务工作区的绝对实验根目录：回退路径要求 `<experimentsRoot>/<taskId>` 已存在。 |
| `actor` | 记录为任务创建者、计划确认人、预算批准人与无人值守战役接受人的人类操作者。 |
| `cardLocale` | `'zh'`（默认）或 `'en'`：审批卡文案与战役结果聊天通知使用的语言。 |
| `defaultBudget` | 提案省略预算时使用的默认值；默认为 `{ preset: 'unlimited' }`。构造时校验——显式给出的非法值会让加载失败。 |
| `defaultUnattended` | 提案省略无人值守选择时的默认值；默认 `true`。 |
| `guidance` | 是否注册自开发引导 `systemPrompt` 片段（见 [Model Experience](#model-experience)）；默认 `true`。 |

从上下文读取的端口（除 `approval` 外均可选）：

| 端口 | 上下文键 | 缺失时的行为 |
|---|---|---|
| Remote 门面 | `selfDevelopmentRemote` | 每个工具调用都会以门面错误失败；实践中不应在没有它的情况下组合本插件。 |
| 审批 | `approval` | 硬依赖注入：插件无法加载。 |
| 工作区 | `selfDevelopmentWorkspaces` | `self_development_propose` 回退为要求 `<experimentsRoot>/<taskId>` 已存在，不存在则拒绝。 |
| 事件 | `selfDevelopmentEvents` | 永远不会投递战役结果聊天通知；`self_development_status` 的 `latestEvent` 字段永远为空。 |
| 系统提示 | `systemPrompt` | 不会注册自开发引导片段（记一条 `debug` 日志）；模型看不到"优先用 self_development_propose、而不是直接改试验版"的内置指令。 |
| 试用（DH-c） | `selfDevelopmentTrial` | `self_development_status` 的 `trialUrl` 字段永远为空。 |

-----

<a id="tools"></a>
## 工具

### `self_development_propose`

参数（除 `budget`/`unattended`/`parallel` 省略时取部署配置默认值外，其余均由模型依据用户话语起草）：

| 字段 | 含义 |
|---|---|
| `requirement` | 整理自用户话语的需求。 |
| `allowedModificationScope` | 开发工作者可修改的仓库路径（允许 glob）。 |
| `plan.requiredCases` | `{ caseId, requirement, assertionIds }[]`——每轮战役都必须通过的验收用例。 |
| `plan.manualCases` | 明确留给人工核验的验收项。 |
| `acceptance` | 起草的验收定义：`{ "cases": [ { "caseId", "command": string[], "cwd"?, "timeoutMs", "assertions": [ { "assertionId", "kind": "exit-code" \| "stdout-includes" \| "file-exists" \| "file-includes", ... } ] } ] }`。`plan.requiredCases` 里每个 `caseId` 与 `assertionIds` 都必须在此定义；审批卡展示前即校验。 |
| `budget` | `{ preset: 'unlimited' }`（时间上限 24 小时）、`{ mode: 'rounds', maxRounds }`，或 `{ mode: 'time', hours }`（`hours` ≤ 24，否则拒绝）。 |
| `unattended` | 是否一次审批覆盖全部战役轮次。 |
| `parallel` | `false` 时，若本进程发起的另一战役仍在运行则拒绝本次提案。 |

行为：先校验输入（含验收定义是否覆盖计划所需用例、预算 `hours ≤ 24` 上限——工具参数 schema 没有数值范围关键字，因此该约束写在代码里，与 `tool-bash` 处理自身 schema 之外取值约束的方式相同）；`parallel` 为 `false` 时，先逐个检查本进程已发起的任务是否有战役在运行，一旦发现即提前拒绝——在向用户提问之前就已判定；随后展示**一张**审批卡（`ctx.approval.request`），列出需求、验收用例、预算、无人值守选择与工作区。只有 `allowed-once` 才会继续——其余结果（`rejected`、`cancelled`、`unavailable`）不发起任何门面调用，直接返回 `{ ok: false, reason }`。放行后，[八步顺序](#the-eight-step-sequence)依次执行；任一步失败即停止并返回已完成的步骤、失败原因，以及（如有）机器可路由的错误码。已写入的内容不会回滚：工作区、验收定义文件、以及已提交的任务日志条目都原样保留供排查。

### `self_development_status`

参数：`{ taskId }`。返回任务的控制态摘要（状态、修订号、需求、已耗轮数/时间、规划是否已授权、无进展计数）、战役状态（轮数、最近结果、原因、确认方式，如已存在）、派生路径（已设启动档案时取其工作区与验收路径，外加始终存在的验收定义与战役记录路径）、试用服务汇报有运行实例时的试用地址，以及本进程为该任务观察到的最近一条 `campaign-passed`/`campaign-ended` 事件。门面失败（如任务 id 未知）时返回 `{ ok: false, reason, error }`。

### `self_development_stop`

参数：`{ taskId, reason }`。转发给门面的 `stopCampaign(taskId, reason)`，返回结果战役状态；被拒绝时返回 `{ ok: false, reason, error }`。

-----

<a id="the-eight-step-sequence"></a>
## 八步顺序

单次审批之后，`self_development_propose` 严格按顺序驱动门面完成以下步骤，任一步失败即停止：

1. **工作区** ——已挂载工作区服务时，`allocate({ taskId, projectRoot: stableRepo })`；未挂载时，取已存在的 `<experimentsRoot>/<taskId>` 目录（不存在则拒绝）。
2. **验收定义写入** ——把校验过的验收定义写入 `<controlDirectory>/acceptance/<taskId>.json`（原子写入，0600 权限，目录 0700）。
3. **`createTask(spec, 0, launchProfile)`** ——`launchProfile` 携带 `worktree`、`acceptancePath`、`confirmedBy`，工作区服务分配了数据目录时再加上 `dataHome`（工作区分配结果必含数据目录；已存在目录回退路径则永不携带）。
4. **`authorizePlanning`**
5. **`submitPlanDraft`**
6. **`confirmPlan`**
7. **`approveBudget`** ——`budget` 字段映射为门面的线上形式；`unlimited` 预设同时携带 `preset: 'unlimited'` 标记与其展开字段（`durationMs: 24 小时、phaseTimeoutMs: 600000、maxStepsPerAttempt: 40、noProgressAttemptLimit: 5`），因此该调用在 DH-a 线上变更落地前后都合法。
8. **`startCampaign(taskId, rev, { unattended, acceptedBy })`** ——启动无人值守（或逐轮）战役循环；成功时其返回的 `CampaignState` 即提案结果的 `campaign` 字段。

返回的 `steps[]` 轨迹在这八步之前还有两个记账步骤——`approval`（已获批准）与 `baseline`（已读取的 `stableBaselineDigest`）——在上述八个门面操作之外，再多给出五个具名检查点，便于诊断部分失败。

-----

<a id="task-id-and-baseline-digest"></a>
## 任务 id 与基线摘要

`taskId` 从需求派生：取前四个以空白分隔的词，转小写，每个词只保留 `[a-z0-9]`（一个词若因此变空——例如纯中文或纯标点——则丢弃；若全部词都被丢弃，回退到字面词干 `task`），用 `-` 连接，再加 6 位十六进制随机后缀——例如 `add-json-flag-a1b2c3`。`stableBaselineDigest` 是在 `stableRepo` 里执行 `git rev-parse HEAD`、对其去空白 stdout 取 `sha256`；每次提案都重新读取，因此战役声明的基线精确等于提案那一刻稳定分支的顶端。

-----

<a id="campaign-result-notices"></a>
## 战役结果通知

挂载了可选事件服务时，本包会订阅它，并在内存里保留一份有界记录：为每个仍未结算的任务记住发起它的那个存活 `NotifiableAgent`（机制照搬 `@deepseek-ai/dsh-tool-jobs` 投递后台任务完成通知的方式：`Agent.followup`/`Agent.inject`，来源标注 `{ kind: 'plugin', form: 'notice' }`）。当某任务收到 `campaign-passed` 或 `campaign-ended` 事件、且本进程仍为它记着 Agent 时，会投递一条双语单行聊天通知——空闲 Agent 走续接回合，忙碌 Agent 则注入上下文——随后消费掉该登记项。无论聊天通知能否投递成功，`self_development_status` 的 `latestEvent` 字段都会为每个这样的事件更新。

-----

<a id="self-iterate-mode"></a>
## 自迭代模式

本包 `presets/self-iterate/` 下的一个 opt-in [agent preset](../../preset/agent-presets/README.zh.md)，**不在** `@deepseek-ai/dsh-agent-presets` 自带的预设集合里——部署方必须先把这个目录加成一个 root，预设选择器才会展示它。

**怎么启用**：把 `agent-presets` 配置的 `roots` 指向这个目录（`packages/workflow/workflow-self-development-chat/presets`，`trust: 'system'`）；`packages/bundle/web-app/overlays/self-development.overlay.yml` 里已经有一份可以直接改的 patch。`self_development_*` 三个工具不需要在预设里再挂一行——它们来自组合里任何已经挂载了 `selfDevelopmentChat` 的地方（挂载后就注册进所有预设共用的工具表）。

**包含什么**：`@deepseek-ai/dsh-persona` 一行负责给这个模式定调（`complete: false`，所以本包自己的[引导片段](#model-experience)与其它所有已注册的提示片段依然会拼进去；`includeRuntimeContext: true`，与内置的 `minimal` 预设不同，因为起草验收用例得看到仓库当前状态）；`@deepseek-ai/dsh-agent-instructions` 提供项目级指令；`@deepseek-ai/dsh-tool-fs-search` 作为只读检索，让 Agent 能一边看代码一边起草验收用例。

**不包含什么**：没有文件编辑工具（`tool-fs`、`tool-str-replace-editor`），没有 Shell 或终端工具（`tool-bash`、`tool-pwsh`，及它们的持久/终端形态）——对工作区的任何改动都只能走 `self_development_propose` 与它启动的战役，这个会话本身碰不到工作区。

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

`selfDevelopmentChat` 挂载、且挂载了 `systemPrompt` 服务、`guidance` 又不是 `false`（默认 `true`）时，本包会注册一段固定文本的 `systemPrompt` 片段（`tool:self-development`，见 `src/guidance.ts`）。没有挂载 `systemPrompt` 服务时跳过并记一条 `debug` 日志；`guidance: false` 时跳过且不记日志，留给部署方自行组合引导。一次聊天侧现场实测显示：这段引导原来只是 README 里的文字、从未被注入任何地方时，模型会直接拿起自己的改文件与 Shell 工具，而不是发起提案——以下是实际注册的文本：

##### Self-development guidance

```markdown
When the user asks for a change to be made on the trial branch (not this
stable session), use the self-development tools instead of editing files
yourself:

1. Ask — in one ordinary message, not a tool call — for the three choices the
   approval card will show, unless the user already stated them: unattended
   (default yes), parallel (default yes, multiple campaigns may run), and
   budget (a round count, a time limit in hours capped at 24, or "unlimited"
   for the 24-hour default).
2. Draft the acceptance cases and the acceptance definition (commands and
   assertions a trusted runner can execute mechanically) from the
   requirement before calling any tool.
3. Call self_development_propose with the drafted requirement, scope, plan,
   acceptance definition, and the budget/unattended/parallel choices. This
   shows the user one approval card; you must never claim it was approved,
   guess at the outcome, or retry as though it were — wait for the tool
   result.
4. Use self_development_status to check progress or report evidence paths,
   and self_development_stop only when the user asks to stop.

Never call these tools without the user having asked for a change on the
trial branch, and never fill in placeholder or guessed acceptance commands
just to get past validation.

When the user asks for a change on the trial branch, do NOT edit files in
this workspace yourself and do NOT run the tests yourself; propose it with
self_development_propose and stop after the tool result.
```

#### Token effect

片段注册期间，每次请求都有一份小额固定输入开销。

#### KV Cache effect

片段保持注册、文本不变时前缀稳定；挂载、卸载插件或切换 `guidance` 都会让复用从这个片段处失效。

### Tool calls

#### What the model sees

`selfDevelopmentChat` 挂载期间在 `src/index.ts` 里注册的 `self_development_propose`、`self_development_status`、`self_development_stop` 三个工具定义（`ctx.tools.register(defineTool({...}))`）；完整的参数与结果形状见本页前文。

#### Token effect

这三个工具可见时，每次请求都有固定的 schema 开销；`self_development_propose` 的 schema 最大，因为它携带完整的验收定义形状。

#### KV Cache effect

工具定义与可见性不变时前缀稳定；插件挂载或卸载会让复用从第一个变化的 schema token 处失效。

### Results and notices

#### What the model sees

`self_development_propose` 成功时返回 `{ ok: true, taskId, workspace, baselineDigest, steps, campaign }`，失败时返回 `{ ok: false, steps, reason, error? }`。`self_development_status` 返回任务与战役摘要；`self_development_stop` 返回 `{ ok: true, campaign }` 或 `{ ok: false, reason, error? }`。战役结算时，发起 Agent 会收到一条指回 `self_development_status` 的双语单行通知——空闲则续接回合，忙碌则注入上下文。

#### Token effect

结果会留在父级历史里直到被压缩。给空闲 Agent 的结算通知还会额外买下一次计划外的续接回合；给忙碌 Agent 的则只给它正在进行的回合加一步。

#### KV Cache effect

仅追加：新出现的结果与通知跟在可复用的请求前缀之后，不会使已有的 KV Cache 条目失效。

## Known Limitations and Deferred Work

- **无 OS 隔离** ——本包不实现、不请求、也不宣称对其启动的战役有进程或文件系统隔离；审批卡"无 OS 隔离"这行字与 DH-a 的 `PresenceAcknowledgement` 都如实携带这一声明。这里的"无人值守"仅意味着一次审批而非逐轮审批，别无其他。
- **从不替自己点"允许"** ——每次提案都展示且只展示一次真实的 `ctx.approval.request`；本包没有任何路径会伪造、推断或绕过这个决定。
- **战役结果聊天通知是内存态、尽力而为的** ——发起 Agent 的登记表只存在于本进程，重启即丢失；这与 DH-a 自身战役状态在重启后的处理一致（`running` 的战役会被标记为 `stopped`，原因 `process restarted`），因此不会丢失任何 DH-a 本就会保留的东西。会话已结束的 Agent 会被静默跳过。无论通知是否投递成功，`self_development_status` 轮询始终是可靠路径。
- **通知投递依赖事件服务自身的监听器容错** ——`deliverCampaignNotice` 在事件服务的订阅回调里同步运行，自己不捕获投递失败；它依赖上游事件服务把每个监听器包在 try/catch 里（`@deepseek-ai/dsh-workflow-self-development-events` 目前就是这样做的），这样一个通知失败才不会连累其他订阅者或事件服务自身的记账。如果未来某个事件源不提供这种容错，投递失败（比如 `Agent.followup`/`Agent.inject` 抛出异常）就可能从订阅回调里冒出来。
- **已存在目录的工作区回退不分配任何东西** ——没有工作区服务时，`self_development_propose` 只检查 `<experimentsRoot>/<taskId>` 是否已存在；不会创建、填充或隔离它。
- **没有 DH-c 就无法访问试验版地址** ——`self_development_status` 的 `trialUrl` 字段在挂载 `selfDevelopmentTrial` 服务并汇报有运行实例之前始终为空。
- **`parallel: false` 是礼貌性预检查，不是执行边界** ——它在请求审批之前读取每个已知任务的 `campaign()` 状态，但状态读取失败会被当作"未运行"处理（失败开放）而非阻塞提案；真正的权威上限是 DH-a 自身在 `startCampaign` 上的 `maxConcurrentCampaigns` 拒绝。
- **只读战役的操作面，不是试验版体验本身** ——DH-c 的试验实例地址只读取、不打开；本包不提供也不代理试验版本身的访问。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

None.

</details>
