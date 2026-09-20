---
description: "聊天侧自开发发起器：Agent 工具起草任务、只向用户要一次审批，放行后自动驱动稳定侧门面完成工作区分配、验收定义写入、规划、预算与无人值守战役，再把结果投影回聊天。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development-chat

[English](README.md) | 中文

<a id="summary"></a>
## 概述

让用户能在一条普通聊天消息里发起自开发战役，通过后再合并进稳定版。`self_development_propose` 起草需求与验收，展示一张审批卡，放行后驱动稳定侧门面直到战役启动。`self_development_status` 汇报进度；`self_development_stop` 结束战役。`self_development_merge` 把已通过的任务合并进目标分支、独立重新验证，再重建并重启稳定版；出现冲突或验证失败则改为在同一次审批下自动起一个无人值守的修复战役。本包不实现隔离、也从不代替用户点"允许"——见[已知限制](#known-limitations-and-deferred-work)。

## 目录

- [Service](#service)
- [工具](#tools)
- [八步顺序](#the-eight-step-sequence)
- [任务 id 与基线摘要](#task-id-and-baseline-digest)
- [战役结果通知](#campaign-result-notices)
- [自迭代模式](#self-iterate-mode)
- [合并到稳定版](#merge-to-stable)
- [升级](#upgrade)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="service"></a>
## Service

`SelfDevelopmentChat`（默认导出，Cordis 服务 `selfDevelopmentChat`）把 `tools` 与 `approval` 声明为硬依赖注入——没有工具注册表与审批应答者，插件不会加载。稳定侧门面、工作区服务、事件服务、试用服务与 runner 验证服务全部用 `ctx.get(...)` 结构式读取，而不是声明为带类型的注入，因为本包是照着 DH-a/DH-c/DI-a 的冻结接口先行开发的，此刻并非每个 worktree 都有这些包的源码；集成后真实服务会满足同一套结构形状。

| Config 字段 | 含义 |
|---|---|
| `stableRepo` | 稳定分支所在仓库的绝对路径，其 `HEAD` 用于生成 `stableBaselineDigest`。 |
| `controlDirectory` | 本包写入验收定义的绝对目录（`<controlDirectory>/acceptance/<taskId>.json`，0600 权限、目录 0700）；也是 `self_development_status` 汇报的派生路径 `<controlDirectory>/campaigns/<taskId>.json` 的基准目录。必须解析到 `experimentsRoot` 之外——runner 拒绝评判放在实验根目录内的验收定义，`controlDirectory` 嵌套在里面会让每一轮战役都被拒；插件构造时与每次提案前都会（经 `realpath`）校验一次。 |
| `experimentsRoot` | 未挂载工作区服务时用于解析任务工作区的绝对实验根目录：回退路径要求 `<experimentsRoot>/<taskId>` 已存在。 |
| `actor` | 记录为任务创建者、计划确认人、预算批准人、无人值守战役接受人与试用批准人的人类操作者。 |
| `targetBranch` | `self_development_merge` 把已通过任务的工作区合并进的分支。必填、非空——构造时校验。 |
| `integrationGates` | `self_development_merge` 的 `verify` 在合并后的工作区内以 `sh -c` 依次执行的命令；任一命令非零退出或超过每条 20 分钟的超时都会让合并拒绝关闭。默认 `[]`。 |
| `upgrade` | `self_development_merge` 在 `integrated` 结果后如何重建并重启稳定版——见[升级](#upgrade)。默认 `{ kind: 'none' }`。构造时校验——显式给出的非法值会让加载失败。 |
| `commitIdentity` | `self_development_merge` 请 `workspaces.integrate` 在 rebase 前给脏的任务工作区打快照提交时用的 `{ name, email }` git 作者——见[合并到稳定版](#merge-to-stable)。默认 `{ name: 'DSH self-development', email: 'self-development@dsh.local' }`。构造时校验——显式给出空的 `name` 或 `email` 会让加载失败。 |
| `cardLocale` | `'zh'`（默认）或 `'en'`：审批卡文案与战役结果聊天通知使用的语言。 |
| `defaultBudget` | 提案省略预算时使用的默认值；默认为 `{ preset: 'unlimited' }`。构造时校验——显式给出的非法值会让加载失败。 |
| `defaultUnattended` | 提案省略无人值守选择时的默认值；默认 `true`。 |
| `guidance` | 是否注册自开发引导 `systemPrompt` 片段（见 [Model Experience](#model-experience)）；默认 `true`。 |

从上下文读取的端口（除 `approval` 外均可选）：

| 端口 | 上下文键 | 缺失时的行为 |
|---|---|---|
| Remote 门面 | `selfDevelopmentRemote` | 每个工具调用都会以门面错误失败；实践中不应在没有它的情况下组合本插件。 |
| 审批 | `approval` | 硬依赖注入：插件无法加载。 |
| 工作区 | `selfDevelopmentWorkspaces` | `self_development_propose` 回退为要求 `<experimentsRoot>/<taskId>` 已存在，不存在则拒绝；`self_development_merge` 直接拒绝关闭（其 `integrate` 方法没有回退路径）。 |
| 事件 | `selfDevelopmentEvents` | 永远不会投递战役结果聊天通知；`self_development_status` 的 `latestEvent` 字段永远为空。 |
| 系统提示 | `systemPrompt` | 不会注册自开发引导片段（记一条 `debug` 日志）；模型看不到"优先用 self_development_propose、而不是直接改试验版"的内置指令。 |
| 试用（DH-c） | `selfDevelopmentTrial` | `self_development_status` 的 `trialUrl` 字段永远为空。 |
| runner 验证 | `selfDevelopmentRunner` | `self_development_merge` 直接拒绝关闭——不提供在合并进稳定版之前由 runner 独立验证验收的能力。 |

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
| `acceptance` | 起草的验收定义：`{ "cases": [ { "caseId", "command": string[], "cwd"?, "timeoutMs", "assertions": [...] } ] }`，每条断言是以下之一：`{ assertionId, kind: "exit-code", expected }`、`{ assertionId, kind: "stdout-includes", text }`、`{ assertionId, kind: "file-exists", path }`、`{ assertionId, kind: "file-includes", path, text }`——工具参数 schema 显式声明了这个形状（是对象 schema，不是不透明的 JSON blob），对于无法直接生成嵌套对象的工具调用格式，也接受同形状的 JSON 字符串。`plan.requiredCases` 里每个 `caseId` 与 `assertionIds` 都必须在此定义；审批卡展示前即校验。 |
| `budget` | `{ preset: 'unlimited' }`（时间上限 24 小时）、`{ mode: 'rounds', maxRounds }`，或 `{ mode: 'time', hours }`（`hours` ≤ 24，否则拒绝）。 |
| `unattended` | 是否一次审批覆盖全部战役轮次。 |
| `parallel` | `false` 时，若本进程发起的另一战役仍在运行则拒绝本次提案。 |

行为：先校验输入（含验收定义是否覆盖计划所需用例、预算 `hours ≤ 24` 上限——工具参数 schema 没有数值范围关键字，因此该约束写在代码里，与 `tool-bash` 处理自身 schema 之外取值约束的方式相同）；`parallel` 为 `false` 时，先逐个检查本进程已发起的任务是否有战役在运行，一旦发现即提前拒绝——在向用户提问之前就已判定；随后展示**一张**审批卡（`ctx.approval.request`），列出需求、验收用例、预算、无人值守选择与工作区。只有 `allowed-once` 才会继续——其余结果（`rejected`、`cancelled`、`unavailable`）不发起任何门面调用，直接返回 `{ ok: false, reason }`。放行后，[八步顺序](#the-eight-step-sequence)依次执行；任一步失败即停止并返回已完成的步骤、失败原因，以及（如有）机器可路由的错误码。已写入的内容不会回滚：工作区、验收定义文件、以及已提交的任务日志条目都原样保留供排查。

### `self_development_status`

参数：`{ taskId }`。返回任务的控制态摘要（状态、修订号、需求、已耗轮数/时间、规划是否已授权、无进展计数）、战役状态（轮数、最近结果、原因、确认方式，如已存在）、派生路径（已设启动档案时取其工作区与验收路径，外加始终存在的验收定义与战役记录路径）、试用服务汇报有运行实例时的试用地址，以及本进程为该任务观察到的最近一条 `campaign-passed`/`campaign-ended` 事件。门面失败（如任务 id 未知）时返回 `{ ok: false, reason, error }`。

### `self_development_stop`

参数：`{ taskId, reason }`。转发给门面的 `stopCampaign(taskId, reason)`，返回结果战役状态；被拒绝时返回 `{ ok: false, reason, error }`。

### `self_development_merge`

Host-only：这个工具会重建并重启它所在的这个稳定版，所以只有当调用方进程就是那个部署本身时才有意义（见[已知限制](#known-limitations-and-deferred-work)——没有运行时的调用方身份校验来强制这一点）。

参数：`{ taskId? }`——要合并的任务；省略时取最近一次本进程自己发起、且状态为 `awaiting-trial` 的任务（按最新优先搜索）。显式给出的 `taskId` 若不是 `awaiting-trial`，或省略后找不到任何一个，都会在发起任何审批之前就被拒绝——没有任何改动可合的任务也一样（见[合并到稳定版](#merge-to-stable)）。

行为：展示**一张**审批卡，写明任务、目标分支、合并会重建并重启稳定版、以及冲突或验证失败会自动起一个修复战役——因此那种情况不会再弹第二张卡。只有 `allowed-once` 才会继续。放行后：`recordTrialApproval(taskId, revision, actor)`，然后 `workspaces.integrate({ taskId, targetBranch, actor, verify, snapshot })`——`verify`、`snapshot` 与四种结果见[合并到稳定版](#merge-to-stable)。已经完成的部分（已记录的试用批准、留在工作区上的快照或 rebase、已起的修复战役）不会因为后续失败而回滚。

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

<a id="merge-to-stable"></a>
## 合并到稳定版

在其它任何事之前——包括审批卡本身——`self_development_merge` 会先检查有没有任何东西可合并：如果解出的任务工作区没有未提交的改动，*并且*它的分支 HEAD 已经等于 `targetBranch` 自己的 tip（任务工作区与稳定版仓库共享 refs，所以 `targetBranch` 在其内部也能解出），就直接返回 `{ ok: false, reason: 'nothing to merge' }`，不会询问。这项检查本身的任何失败——还没有启动档案、工作区不可读、分支解不出来——都会失开（fail open），走下面的正常流程，而不是拦住它。

`self_development_merge` 驱动工作区服务的 `integrate({ taskId, targetBranch, actor, verify, snapshot })`（DI-a 冻结接口），传入本包自己构造的 `verify(worktree)`，依次做两步，任一步失败都会终止：

1. **runner 验收验证** ——`selfDevelopmentRunner` 的 `verifyAcceptance(worktree, acceptancePath, { experimentsRoot })`：在合并后（可能已 rebase）的工作区上，由独立进程、而不是模型，重新核对同一份验收定义。
2. **集成门禁** ——依次执行 `integrationGates` 里配置的每条命令，每条都在工作区内以 `sh -c` 运行，20 分钟后强制终止；非零退出或超时都会拒绝关闭，原因里点名命令与其合并输出（stdout/stderr）的最后 2 KB。

`snapshot` 是 `{ message: 'selfdev(<taskId>): <需求首行，最多 72 字符>', author: commitIdentity }`（任务需求拿不到时就是单纯的 `selfdev(<taskId>)`）。当任务工作区有未提交的改动时——比如实验 Agent 的工作还没提交——`integrate` 会在 rebase *之前*用这条消息和这个作者把它们暂存并提交，这样合并就永远不会悄悄丢掉这些改动；干净的工作区不会产生快照提交。不管哪种情况，`integrate` 都会在 rebase（如果目标分支动过）之后、快进之前调用 `verify`，无论基线是否动过都会调用。它会落到以下四种结果之一：

| 状态 | 含义 | 本包的反应 |
|---|---|---|
| `integrated` | 已快进；汇报 `commit`、`baseMoved`，打过快照时还有 `snapshotCommit`。 | 发出 `merge-integrated`；除非 `upgrade.kind` 是 `none`，否则跑配置的[升级](#upgrade)。 |
| `conflict` | rebase 无法干净应用；`files` 点名冲突文件。 | 发出 `merge-blocked`；自动起一个无人值守的修复战役（见下）。不会快进任何东西。 |
| `verification-failed` | rebase 后（或基线未动时）`verify` 失败；rebase 结果（如有）留在工作区上。 | 与 `conflict` 相同的修复战役反应。 |
| `failed` | 门面本身未能完成这次操作。 | 发出 `merge-blocked`；只报告，不起修复战役——这不是一个能靠改代码修的失败。 |

上面每处"发出"实际是两个 Cordis 事件，不是一个：本包自己的 `self-development-chat/merge-integrated`/`self-development-chat/merge-blocked`（`{ taskId, commit, baseMoved, occurredAt, revision, snapshotCommit? }` / `{ taskId, status, occurredAt, revision, files?, reason? }`，声明在 `src/index.ts`），以及 `self-development/merge-integrated`/`self-development/merge-blocked`（`{ taskId, revision }` / `{ taskId, status, revision }`，`revision` 取自 `recordTrialApproval` 的返回结果）——后者是 `@deepseek-ai/dsh-workflow-self-development-events` 真正订阅的名字与形状，会折进它统一的通知事件（`Task integrated into stable` / `Merge blocked: <status>`）。`snapshotCommit` 只存在于本包自己的事件里；上游事件的 payload 就是 DI-a 声明的那个形状，一个字段都不多。

**修复战役**：对 `conflict`/`verification-failed`，本包直接调用自己的提案编排——无人值守、`{ preset: 'unlimited' }` 预算、`allowedModificationScope: ['**']`（修复的是同一处改动，不是一个新划定范围的改动）、被拒任务已写好的**同一份**验收定义（原样读回并转发）、以及直接从该定义自身的用例推出的计划，因此天然满足计划覆盖校验。需求文案点名目标分支与冲突文件，或验证失败的原因。关键是**跳过第二张审批卡**：合并卡上已经写明冲突或验证失败会自动起修复战役，再问一次就是多余的。修复战役是一个全新任务（有自己的 id），不是被拒任务的延续。

-----

<a id="upgrade"></a>
## 升级

`integrated` 结果之后，`self_development_merge` 会按部署配置的 `upgrade` 策略执行：

- **`{ kind: 'none' }`**（默认）——完全不跑任何命令。当这里合并的任务不是本部署自己的源码时（例如一个和运行本聊天的进程无关的"稳定版"的演示仓库），这是正确选择。
- **`{ kind: 'source', projectRoot, restartCommand, installIfLockfileChanged? }`** ——面向从源码运行的稳定版（本部署自身就是这种情况）：在 `projectRoot` 里执行 `git merge --ff-only <targetBranch>`（如果 `integrate` 已经在同一个工作区快进过，这一步是空操作，仍然退出码 0）；只有合并改变了 `projectRoot` 的 `pnpm-lock.yaml` 时才 `pnpm install --offline --frozen-lockfile`（`installIfLockfileChanged: false` 则无论如何都不装）；`pnpm run --silent build`；然后以脱离进程的方式执行 `restartCommand`（`spawn(..., { detached: true, stdio: 'ignore' })`、`unref()`），使其活得比本进程久。两秒之后——足够工具结果传到聊天里——本进程退出。合并、安装或构建任一步失败都会被报告并在重启前停下；已完成的部分不会撤销。
- **`{ kind: 'launcher', dshUpgradeBin }`** ——以脱离进程的方式执行 `dshUpgradeBin upgrade --task <taskId>`，面向打包版（Swift 壳）自己的升级工具。本波只做接口与文档，未经现场验证——见[已知限制](#known-limitations-and-deferred-work)。

-----

不发布运行时 invariant 配套模块：本服务没有自己的运行时观察流，它拥有的一切关系——每个提案或合并一次审批请求、八步顺序、每个战役或合并结果一条通知——都由针对替身 seam 的行为测试覆盖。

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
5. When the user says the change should go live, or asks to merge it to
   stable, call self_development_merge (it defaults to the most recently
   proposed task when none is named). This shows one more approval card,
   which also covers the automatic repair campaign a conflict or
   verification failure would start — do not expect or wait for a second one.

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

`selfDevelopmentChat` 挂载期间在 `src/index.ts` 里注册的 `self_development_propose`、`self_development_status`、`self_development_stop`、`self_development_merge` 四个工具定义（`ctx.tools.register(defineTool({...}))`）；完整的参数与结果形状见本页前文。

#### Token effect

这四个工具可见时，每次请求都有固定的 schema 开销；`self_development_propose` 的 schema 最大，因为它携带完整的验收定义形状。

#### KV Cache effect

工具定义与可见性不变时前缀稳定；插件挂载或卸载会让复用从第一个变化的 schema token 处失效。

### Results and notices

#### What the model sees

`self_development_propose` 成功时返回 `{ ok: true, taskId, workspace, baselineDigest, steps, campaign }`，失败时返回 `{ ok: false, steps, reason, error? }`。`self_development_status` 返回任务与战役摘要；`self_development_stop` 返回 `{ ok: true, campaign }` 或 `{ ok: false, reason, error? }`。`self_development_merge` 返回 `{ ok: true, taskId, steps, result, repair?, upgrade? }`——`result` 是门面的 `integrated`/`conflict`/`verification-failed`/`failed` 结果，`repair` 是自动起的修复战役自身的结果（如有），`upgrade` 是跑了升级时的结果（如有）；在这些都还没到达之前失败则返回 `{ ok: false, steps, reason, error? }`。战役结算时，发起 Agent 会收到一条指回 `self_development_status` 的双语单行通知——空闲则续接回合，忙碌则注入上下文。

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
- **`self_development_merge` 的 host-only 只是约定，不是强制** ——本仓库没有任何运行时信号能区分"调用方进程就是正在升级的那个部署"和其它任何调用方；没有可 `ctx.get` 的调用方身份端口可供判断（本代码库里唯一的 host/phone 区分机制在 Remote 门面自己的字段级 `assertCallerIsHost` 检查里，并不覆盖 Agent 工具调用）。今天唯一的防线是审批卡上的文案。
- **源码升级只对本部署自己的仓库有意义** ——`upgrade.kind: 'source'` 是针对 `upgrade.projectRoot` 跑 `git`/`pnpm`/重启命令；如果一个部署的任务是从另一个仓库 fork 出来的（例如只用来跑战役的演示仓库），应该配置 `{ kind: 'none' }`，否则"升级"会重建并重启错误的那棵树。
- **重启后浏览器会话不会自动重连** ——聊天结果里会给出一个预估等待时间，但这里不会主动推送刷新；用户（或客户端外壳）仍然需要在稳定版回来后自己刷新一次。
- **修复战役的修改范围有意放宽** ——`allowedModificationScope: ['**']`，因为一次 rebase 冲突或 rebase 后的验证失败可能牵涉原改动碰过的任何文件，而本包手上并没有原任务自己的范围可供收窄。
- **`upgrade.kind: 'launcher'` 本波只做接口与文档** ——它会以脱离进程的方式执行 `dshUpgradeBin upgrade --task <taskId>`，一旦发起就汇报成功，但这次交接的打包版启动器那一侧还没有经过现场验证。
- **不会回滚任何东西** ——合并、修复战役发起、或升级中的某一步在更早的步骤已经成功之后失败（已记录的试用批准、留在工作区上的 rebase、已经跑过的安装或构建），都会原样保留供排查，与 `self_development_propose` 已有的约定一致。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

None.

</details>
