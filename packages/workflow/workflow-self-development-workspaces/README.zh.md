---
description: "面向可选自开发模式的任务工作区分配与串行集成：每个任务在 experiments 根目录下拥有独立 git worktree、分支与复制的数据目录，配有持久登记文件，并按一次一个的方式 fast-forward 集成回项目基线。提供的是协调，不是隔离。"
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development-workspaces

[English](README.md) | 中文

<a id="summary"></a>
## 概述

为每个自开发任务分配一个工作区，并把完成任务分支集成回项目基线。对每个任务，本服务在一个 `selfdev/<taskId>` 分支上创建一个 git worktree，并从部署模板复制出一个 `DSH_HOME`，把两者登记到 experiments 根目录下的持久登记文件中，之后只释放自己登记过的路径。集成严格串行：每个 experiments 根目录一把锁，基线移动后向目标分支最新 tip 执行 rebase，fast-forward 之前可选执行调用方提供的校验门，再执行从不创建 merge 提交、从不强制移动引用的 fast-forward。这里的任务级隔离指的是目录、进程与数据目录的分离——不是操作系统沙箱。

## 目录

- [服务](#service)
- [并行边界](#parallel-boundary)
- [串行集成](#serialized-integration)
- [磁盘布局](#on-disk-layout)
- [错误码](#error-codes)
- [进一步探索](#further-exploration)
- [Model Experience](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="service"></a>
## 服务

`SelfDevelopmentWorkspaces`（默认导出，Cordis 服务 `selfDevelopmentWorkspaces`）在构造时校验部署配置，并在 `ctx.selfDevelopmentWorkspaces` 上暴露四个服务方法。它不声明任何注入依赖，也不进入任何默认 bundle。

| 方法 | 约定 |
|---|---|
| `allocate(req)` | 为 `req.taskId` 创建工作区：执行 `git worktree add -b selfdev/<taskId> <experimentsRoot>/<taskId>/worktree <baseCommit>`（`baseCommit` 缺省取项目 `HEAD`），并从 `dataHomeTemplate` 复制出 `<experimentsRoot>/<taskId>/dsh-home` 数据目录。同一 taskId 的重复分配会原样返回已登记的记录，无论新请求给出的 projectRoot 是什么。已分配数量达到配置上限后，新的分配会以 `SELF_DEV_WORKSPACE_LIMIT` 被拒绝——绝不排队，因为排在活跃 worktree 之后的任务并不会并行运行。对同一 experiments 根目录的分配与释放会在内存中串行，因此上限检查与登记写入在单进程内是精确的。所有目标路径都会在创建任何东西之前被证明解析于 experiments 根目录之内，且登记项最后写入，因此分配失败不会留下半成品工作区。 |
| `release(taskId)` | 用 `git worktree remove --force` 移除已登记的 worktree，删除数据目录，并删除登记项。只触碰登记过的路径，且每条路径在删除前都会经 `realpath` 重新解析：解析结果落在 experiments 根目录之外的登记路径会被拒绝；已消失的 worktree 目录改为从 git 登记中 prune；不存在的数据目录本来就已经不在了。登记路径之外的文件不受影响。 |
| `list()` | 从持久登记文件返回当前已登记的工作区；返回的快照不反映之后的变更。 |
| `integrate(req)` | 在下文的串行集成约定下，把 `req.taskId` 的 worktree 集成进 `req.targetBranch`。集成过程中的 git 失败以携带原因的 `failed` 结果返回，不会抛出；未分配的 taskId 抛出 `SELF_DEV_WORKSPACE_TASK_UNKNOWN`。同一服务实例上的调用在内存中串行；跨进程的调用在 experiments 根目录的集成锁上串行。可选的 `req.verify(worktree)` 校验门会在 rebase（如果发生过）之后、fast-forward 之前运行一次，无论基线是否移动；被拒绝或抛出异常都会返回 `{ status: 'verification-failed', reason, baseMoved }`，并让目标分支保持不变。 |

| 配置字段 | 含义 |
|---|---|
| `experimentsRoot` | 所有任务 worktree、数据目录以及本服务的登记与锁文件所在的绝对父目录。 |
| `dataHomeTemplate` | 复制进每个任务 `DSH_HOME` 的模板目录的绝对路径；`sessions/` 与 `attachments/` 子树以及所有 `*.lock` 文件不会被复制。 |
| `maxConcurrentTasks` | 同时允许的最大已分配工作区数量；schema 默认值为 2。 |

相对路径，以及不是正有限整数的 `maxConcurrentTasks`，会在构造时抛出带 `SELF_DEV_WORKSPACE_CONFIG_INVALID` 的 `SelfDevelopmentWorkspacesError`。taskId 必须是纯字母数字加点、连字符、下划线的单词，且不含 `..`，也不以 `.lock` 结尾；其余情况会在命名分支或目录之前抛出 `SELF_DEV_WORKSPACE_TASK_INVALID`。该配置检查不建立文件系统隔离，也不能保护目录免受同用户其他进程的影响。

本包不发布运行时不变量伴随包：它不暴露自己的运行时观察流，它拥有的登记文件与文件系统、锁文件与 pid 之间的关系由针对真实 git 仓库的行为测试覆盖，而与文件系统漂移的登记文件会在 release 时拒绝并交还给人处理，而不是靠进程内检查自动修复。

<a id="parallel-boundary"></a>
## 并行边界

两个已分配任务各自拥有独立的 worktree、独立的 `DSH_HOME`，以及——通过[runner 包](../workflow-self-development-runner/README.zh.md)在 worktree 内为每次尝试启动一个 headless 进程——独立的进程。一个任务写入自己 worktree 或数据目录的文件对另一个任务不可见。这就是全部隔离主张：同一台主机上并发任务的目录、进程与数据目录分离，不是沙箱。子进程保留操作系统用户的权限，能访问该用户能访问的一切。

当部署把所有任务都路由到单路本地推理端点（例如一个 LM Studio 服务）时，并发任务共享该端点，模型请求会在其内部排队；这些工作区并不制造推理并行度，对应 development plan 交叉设计第 7 条。与此一致，超过上限的分配会被直接拒绝而不是排队：排在活跃 worktree 后面等待的任务并不会并行执行，假装它会，就等于虚报部署真实拥有的并行度。

<a id="serialized-integration"></a>
## 串行集成

每个 experiments 根目录同一时间只运行一个集成，由 `<experimentsRoot>/integration.lock` 守护；锁文件记录持有进程的 pid，pid 已不复存在的锁视为陈旧锁，由下一个获取者清除——但仅当文件内容仍与判定陈旧时读到的一致，被并发获取者改写过的锁会被等待而不是被删除——存活持有者最多被等待一分钟，之后本次尝试以 `SELF_DEV_WORKSPACE_INTEGRATION_BUSY` 被拒绝。持锁期间，集成依次：

1. 解析目标 tip：若目标分支配置了上游则先 fetch，并在远程跟踪引用存在时使用它；否则以本地分支为基线权威。
2. 当目标 tip 与分配时的 `baseCommit` 不同（即 `baseMoved`），在 worktree 中把任务分支 rebase 到目标 tip 上。发生冲突时中止 rebase 并返回 `{ status: 'conflict', files, baseMoved: true }`——该任务需要针对移动后的基线重新开发并复验。其余 rebase 失败同样会被中止，并以 `failed` 结果返回。
3. 当请求携带 `verify(worktree)` 校验门时，针对该 worktree 运行一次——第 2 步执行过 rebase 时就是 rebase 后的 worktree，否则原样——无论 `baseMoved` 与否都会运行。被拒绝（`{ ok: false, reason }`）或抛出异常（异常的字符串形式成为 `reason`）都会返回 `{ status: 'verification-failed', reason, baseMoved }` 且不执行 fast-forward：目标分支保持不变，已完成的 rebase 结果留在 worktree 中供后续修复使用。
4. 把目标分支 fast-forward 到 worktree HEAD（此时它已包含目标 tip）：项目根目录检出着该分支时用 `merge --ff-only`；分支未被任何 worktree 检出时用比较并交换的 `update-ref`；分支被其他 worktree 检出时拒绝。这里从不创建 merge 提交，从不强制移动引用；非祖先关系的移动会让集成失败。成功的 `integrated` 结果总是携带 `baseMoved`，调用方可以据此区分"基线未变的直接 fast-forward"与"先 rebase 过的 fast-forward"。

每一步都不留半状态：已开始的 rebase 会在返回结果前被中止；集成收尾时无论成败（包括 `verification-failed`）都会释放锁。rebase 会改写任务的提交，因此 rebase 后的任务分支以新的提交 id 承载原有变更。

<a id="on-disk-layout"></a>
## 磁盘布局

```
<experimentsRoot>/
  workspaces.json
  integration.lock
  <taskId>/worktree
  <taskId>/dsh-home
```

登记文件是本服务可删除内容的唯一权威。每次写入都通过独占临时文件加原子重命名发布，因此被中断的写入不会留下可读的半成品登记；与预期结构不符的登记文件会以 `SELF_DEV_WORKSPACE_REGISTRY_INVALID` 显式失败，而不是被悄悄修复。

<a id="error-codes"></a>
## 错误码

| 错误码 | 抛出条件 |
|---|---|
| `SELF_DEV_WORKSPACE_CONFIG_INVALID` | 路径配置字段缺失、为空或为相对路径，或 `maxConcurrentTasks` 不是正有限整数。 |
| `SELF_DEV_WORKSPACE_TASK_INVALID` | taskId 无法安全地充当分支名和目录名。 |
| `SELF_DEV_WORKSPACE_LIMIT` | 配置的工作区数量上限已被占满。 |
| `SELF_DEV_WORKSPACE_TASK_UNKNOWN` | `release` 或 `integrate` 指向没有登记工作区的任务。 |
| `SELF_DEV_WORKSPACE_ALLOC_FAILED` | 项目根目录、基线、模板、worktree 创建或数据目录复制失败。 |
| `SELF_DEV_WORKSPACE_RELEASE_FAILED` | 登记路径解析到 experiments 根目录之外，或 git 无法移除 worktree。 |
| `SELF_DEV_WORKSPACE_REGISTRY_INVALID` | 登记文件无法读取、解析或写入。 |
| `SELF_DEV_WORKSPACE_GIT_FAILED` | git 调用无法启动、非零退出或超时。 |
| `SELF_DEV_WORKSPACE_INTEGRATION_BUSY` | 存活的集成锁持有者在等待上限内未释放锁。 |

<a id="further-exploration"></a>
## 进一步探索

阅读拥有任务工作区拆分决策的计划章节、为这些工作区提供执行环境的 runner 包，以及把本包放进 workflow 兄弟序列的子系统页面。

- [Workflow 子系统](../../../docs/subsystems/workflow.zh.md)——workflow seam 与同组的其他包。
- [Supervised runner](../workflow-self-development-runner/README.zh.md)——在已分配 worktree 内、使用任务数据目录运行尝试的执行器。
- [Task control](../workflow-self-development/README.zh.md)——这些工作区所承载尝试对应的每任务生命周期。

<a id="model-experience"></a>
## Model Experience

没有，本服务只分配目录、git worktree 与登记文件，不注册任何面向模型的工具、提示词或事件。

#### KV Cache effect

本服务不添加提示词前缀。任务的模型请求由 runner 在该任务的 worktree 与数据目录下启动；缓存复用取决于 Agent 的 profile 与提供方，与本服务无关。

## Known Limitations and Deferred Work

- **目录隔离不是沙箱**——独立的 worktree、数据目录与进程不是禁闭。子进程保留操作系统用户的权限；任务可以读写该用户能读写的一切，包括其他任务的 worktree 和登记文件。路径检查在运行时经 `realpath` 解析，不能堵住同用户并发写入者制造的符号链接竞态。
- **进程内有串行链，跨进程仍是一个写入者**——对同一 experiments 根目录的 `allocate` 与 `release` 调用会在进程内的串行链上排队，因此上限检查与登记读-改-写在单进程内是精确的。跨进程没有任何机制串行化登记文件：它仍是最后写入者胜出，两个进程对同一 experiments 根目录并发分配仍会竞争登记文件——落败一方的 worktree 留在磁盘上却没有登记，`release` 找不到它。部署应当为每个 experiments 根目录挂载一个服务实例。
- **进程内串行链没有 BUSY 上限**——排在串行链上的调用会等待排在它前面的全部工作完成，没有超时，也不会以 `SELF_DEV_WORKSPACE_INTEGRATION_BUSY` 拒绝：一个挂起的 `allocate`、`release` 或 `integrate` 回调会让该 experiments 根目录上的所有后续调用无限期等待。只有跨进程集成锁有等待上限（默认一分钟）。
- **集成锁信任同一主机上记录的 pid**——陈旧锁按 pid 存活判定，pid 复用可能延迟接管，等待上限（默认一分钟）基于墙钟；挂起的存活持有者会被拒绝，绝不被抢占。该锁只保护集成，不保护登记文件；登记文件跨进程的单一写入者靠部署约定维持。
- **fast-forward 已检出的分支会更新其工作树**——当项目根目录检出着目标分支时，`merge --ff-only` 会把项目工作树改写为集成后的内容。调用方集成的是自己拥有的项目基线。
- **rebase 改写历史，冲突在这里是终点**——冲突任务返回 `conflict` 结果并保留自己的分支；本服务不自动重试、不重新开发、也不复验。接下来做什么由人或所属编排者决定。
- **幂等分配返回首条记录**——对存活任务的重复 `allocate` 原样返回已登记的工作区，即使新请求给出不同的 projectRoot；纠正分配错的项目根目录必须先 release。
- **校验门由调用方提供，不受沙箱约束**——`req.verify` 在本进程中以本进程的权限针对真实 worktree 运行；本包既不为它设超时，也不隔离它。挂起的校验门会一直占着集成锁，直到调用方自己的等待上限放行为止（进程内串行链没有上限；跨进程锁默认一分钟）。被拒绝与抛出异常会以同样的方式终止集成，因此需要区分诊断信息的校验门必须自己把它折进 `reason`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

None.

</details>
