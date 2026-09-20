# 工作流

[English](workflow.md) | 中文

工作流 seam 允许 agent（智能体）运行由模型编写、会启动 subagent 的编排脚本。与 [subagent](subagent.zh.md) 一样，它是**一项可选能力**，不属于 agent loop，因此其类型和操作记录在此处，而非 [core.md](core.zh.md)。与 bash 一样，每个上下文只允许一个引擎实现提供 `ctx.workflowEngine`；没有命名提供方注册表（第二个引擎通过插件配置替换第一个，而不与它同时运行）。

Service Definition：[dsh-workflow](../../packages/workflow/workflow)（`ctx.workflowEngine` 和下文词汇）。[dsh-workflow-ptc](../../packages/workflow/workflow-ptc)通过共享 Node PTC 进程运行时按调用 Session 的文件策略执行 VM 与辅助函数。消费方为 [dsh-tool-workflow](../../packages/workflow/tool-workflow) 和需显式启用的 [dsh-tool-ralph](../../packages/workflow/tool-ralph)。[工作流沙箱复用](../../.agents/notes/implemented/architecture/2026-09-13-workflow-ptc-sandbox-reuse.zh.md)负责执行选择；[动态工作流决策](../../.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.zh.md)负责脚本语义。

源码：浏览器安全词汇位于 [`packages/workflow/workflow/src/types.ts`](../../packages/workflow/workflow/src/types.ts)，Host 请求与活跃运行句柄位于 [`runtime-types.ts`](../../packages/workflow/workflow/src/runtime-types.ts)。

## 启动请求

本节定义调用方启动一次运行时提交的请求。普通工作流工具会根据模型的 `{ script, meta, args }` 调用和发起调用的 agent 构建该请求；专用消费方还可以为本次运行选择引擎级 `subagentProvider`，并将 `maxTotalAgents` 调低，但脚本无法观察或替换这两项策略。`meta` 与 `args` 是普通 JSON 数据；引擎会用 schema 校验 `meta`，并在任何工作开始前明确报错并拒绝无效数据。引擎绝不会通过对脚本文本求值来获取它们。`parent` 是必填字段——脚本启动的每个子 agent 都归属于它，cwd、谱系与深度通过 [subagent seam](subagent.zh.md) 传递。

```ts type-equiv
/**
 * What a caller asks for when starting a workflow run. `meta` and `args` are
 * plain JSON data by the seam contract. `parent` is required because every
 * `agent()` spawned by the script is attributed to that live Agent.
 */
interface WorkflowStartRequest {
  /** The plain-JS script body (top-level await allowed; ends with `return <json-value>`). */
  script: string
  /** The workflow's identity block, as plain JSON data (shape-validated by the engine). */
  meta: WorkflowMeta
  /** Optional input exposed verbatim to the script as the `args` global. */
  args?: unknown
  /** Optional engine-wide child-provider override for this run. */
  subagentProvider?: string
  /** Optional per-run total-child ceiling. */
  maxTotalAgents?: number
  /** The agent on whose behalf the run executes (parent of every child). */
  parent: Agent
  /** Cancels the run when aborted. */
  signal?: AbortSignal
}
```

## 工作流的身份标识：`WorkflowMeta`

作为数据附在启动请求上的身份块（工具的 `meta` 参数；字段词汇与 Claude Code 动态工作流的 meta 块一致）。`phases` 仅用于进度展示：`phase()` 调用与标题匹配，供观察者使用；不暗示任何执行结构。

```ts type-equiv
/**
 * The script's identity block, provided as plain JSON data alongside the
 * script body (the model-facing tool carries it as its `meta` parameter) and
 * validated by the engine before the body runs. `name`/`description` are
 * required; the rest is optional annotation. The field vocabulary matches the
 * Claude Code dynamic-workflows meta block.
 */
interface WorkflowMeta {
  /** Short kebab-case workflow name (display + persistence key). */
  name: string
  /** One-line description of what the workflow does. */
  description: string
  /** Optional guidance on when this workflow applies (shown in listings). */
  whenToUse?: string
  /** Optional phase declarations matched by `phase()` calls. */
  phases?: WorkflowPhase[]
}
```

## 终态结果：`WorkflowResult`

`WorkflowRun.result` 会兑现为一次运行的结果。`value` 是脚本的物化返回值——纯宿主域 JSON 数据（脚本无返回值时为 `null`）——仅在 `completed` 时有意义。`stopReason` 是封闭联合类型（由引擎定义；消费方可穷举）：`completed` | `cancelled` | `error`。非 `completed` 的原因在 `error` 中携带失败信息，消费方将其映射为 `isError` 工具结果，而非把部分输出当作成功上报。

```ts type-equiv
/**
 * The outcome resolved by a live workflow run. `value` is
 * the script's materialized return value (plain host-realm JSON data; `null`
 * when the script returned `undefined`) — meaningful only for `completed`.
 * A non-`completed` reason carries the failure in `error`; the consumer maps
 * it to an `isError` tool result rather than reporting partial output.
 */
interface WorkflowResult {
  /** The script's return value (host JSON data; `null` for no return). */
  value: unknown
  /** Why the run settled. */
  stopReason: WorkflowStopReason
  /** The failure message (present iff `stopReason` is not `completed`). */
  error?: string
  /**
   * How many `agent()` calls the run accepted over its whole lifetime. On a
   * graceful settlement this is the script-side count (calls still queued for
   * a concurrency slot included); on a termination path (cancellation or
   * process failure) it degrades to the host-observed count — calls queued
   * inside a terminated script are unknowable then.
   */
  agentsStarted: number
}
```

## 活跃运行：`WorkflowRun`

消费方等待 `result`，可以在执行期间调用 `cancel`，且必须在每条路径上调用 `dispose`（资源释放）。`result` 绝不拒绝：脚本失败以 `stopReason: 'error'` 兑现，取消以 `'cancelled'` 兑现。PTC 引擎没有整体经过时间截止；取消时立即中止受管进程。资源释放按照各提供方约定等待进程与子 agent 清理，不另设工作流清理截止。

```ts type-equiv
/**
 * Holder-owned live workflow. `result` never rejects; consumers may cancel
 * and must call idempotent `dispose()` to await script and child quiescence.
 */
interface WorkflowRun {
  readonly id: WorkflowRunId
  /** The validated meta block available before the script body runs. */
  readonly meta: WorkflowMeta
  readonly result: Promise<WorkflowResult>
  /** Cancel the run and its children. */
  cancel(reason?: string): void
  /** Cancel if needed and await script and child cleanup. */
  dispose(): Promise<void>
}
```

## 失败纪律：`WorkflowError.fatal`

脚本内部的钩子误用：错误参数、未知或延迟的 `agent()` 选项、超出[结构化输出子集](../../packages/core/tools/README.zh.md)的 schema、超出上限、seam 启动失败、取消，都会抛出 `fatal: true` 的 `WorkflowError`。`parallel()`/`pipeline()` 组合器对 fatal 错误直接重新抛出，而非将该项映射为 `null`：一个拼写错误的选项必须明确报错并终止脚本，绝不能消融为看似普通子 agent 失败的结果。逐项的 `null` 保留给子运行失败（非 `completed` 的 stop reason）和阶段内的普通脚本错误。

## 事件

`workflow/*` 事件（`workflow/start`、`workflow/phase`、`workflow/log`、`workflow/agent-start`、`workflow/agent-end`、`workflow/end`，见[事件目录](#cordis-surface)）是**仅供观察**的 emit，携带数据快照：每个 payload 以 `WorkflowRunInfo`（id + meta）开头，而非活跃的 `WorkflowRun`，因此订阅者无法获得 `cancel`/`dispose`；`workflow/end` 刻意省略 result value（观察结果的监听器不得收到调用方 result 的可变别名）。每次 emit 对每个监听器隔离：订阅者抛出的异常会被记录到日志中而不会传播，也不会阻止后续注册的监听器收到事件；每个监听器收到自己的 payload 克隆，因此修改它既不会损坏引擎也不会影响其他监听器。这种隔离方式与 `subagent/start`/`subagent/end` 一致。

## 持久 Chat 记录

顶层 `dsh-tool-workflow` 消费方把展示事实投影到调用它的父 Session，同时不改变执行所有权。运行接受后写 `tool-workflow/run-start`，以 `runId + seq` 配对成员开始与结束，并且只在结果已取得且 dispose 完全停稳后写 `tool-workflow/run-end`。嵌套 transport 调用不写记录。第一次 append 失败会禁用本运行后续写入，因此日志保持为空或合法连续前缀，工具结果不变。

`dsh-tool-workflow/invariant` 会在实时提交前和 Session 加载时校验同一协议：每个运行只有一个 start，成员序号为正且唯一，成员 end 必须配对，仍有开放成员时不能结束运行，运行结束后不能继续更新。日志尾部缺少成员 end 或 run end 是有效的中断证据，不是损坏。

`dsh-client-ui-workflow-run` 通过 Conversation Node 引擎把四类事件折叠为一个 `workflow-run` Chat 节点，以 run-start 序号锚定在原工作流工具节点之后。阶段组只来自真正开始过的成员，并保留精确字符串，包括字段缺省与 `''` 的区别。Location 关闭时，缺失终点会显示为已中断。[界面包 README](../../packages/client/ui-workflow-run/README.zh.md)负责定义 disclosure、状态与同父本地导航行为。

## 自开发任务控制与有人监督的 runner

workflow 组还拥有脚本 seam 之外的可选自开发组合。[dsh-workflow-self-development](../../packages/workflow/workflow-self-development/README.zh.md) 在私有控制目录中为每个任务拥有一条持久生命周期——版本化 spec、冻结测试计划、人工预算批准、已验证尝试结果、试用批准——并为每个任务缓存一个串行化控制器。[dsh-workflow-self-development-runner](../../packages/workflow/workflow-self-development-runner/README.zh.md) 针对该控制器组合一次有人监督的尝试：受信时钟、人工在场证据、操作绑定的启动记录、headless 执行器、独立验收器，以及带终局结果的持久尝试证据。每次启动都要求一条已记录的人工确认和有限预算；这对包提供的是带明确记录限制的有人监督测试，绝不是无人值守运行。第三个可选兄弟包 [dsh-workflow-self-development-workspaces](../../packages/workflow/workflow-self-development-workspaces/README.zh.md) 在持久登记文件下为每个任务分配一个 git worktree、分支与复制的数据目录，并把完成的任务分支串行集成回项目基线。每次启动都要求一条已记录的人工确认和有限预算；这三个包提供的是带明确记录限制的有人监督测试，绝不是无人值守运行。三个服务都以 `ctx.selfDevelopmentTasks`、`ctx.selfDevelopmentRunner` 与 `ctx.selfDevelopmentWorkspaces` 出现在 [Cordis API](#cordis-surface) 中。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxselfdevelopmentevents--selfdevelopmentevents"></a>

### `ctx.selfDevelopmentEvents` — `SelfDevelopmentEvents`

Unified self-development event projection. Subscribing consumers and the recent buffer see every mapped event exactly once, in commit order. Without a configured `localNotificationCommand` the service never spawns.

```ts cordis-catalog
/**
 * Read the retained recent events, oldest first.
 * @param limit - maximum number of events to return, taken from the most
 *   recent tail of the buffer; defaults to every retained event.
 * @returns the retained events in chronological order, oldest first.
 */
recent(limit?: number): readonly SelfDevelopmentEvent[]

/**
 * Subscribe one listener to every mapped event from now on. The buffer is
 * not replayed: a subscriber sees only events observed after subscribing.
 * @param listener - callback invoked once per event in commit order.
 * @returns the disposer that removes the listener.
 */
subscribe(listener: (event: SelfDevelopmentEvent) => void): () => void
```

Source: [`packages/workflow/workflow-self-development-events/src/index.ts`](../../packages/workflow/workflow-self-development-events/src/index.ts)

<a id="ctxselfdevelopmentremote--selfdevelopmentremote"></a>

### `ctx.selfDevelopmentRemote` — `SelfDevelopmentRemote`

Stable-side Remote facade. The supervised runner is optional: every method that needs it refuses with a facade code when the runner plugin is not loaded, and the read paths work against the task-control service alone. The connection service is optional too and is read with `ctx.get`, per the repository's optional-service rule: a deployment without the phone channel mounts no connection service, and every caller is then the stable host.

```ts cordis-catalog
/**
 * List every task under the control directory with its progress row.
 * @returns one row per task journal directory, sorted by task id.
 * @throws SelfDevelopmentRemoteError with `self-development/disabled` while the facade is disabled.
 * @throws whatever the task-control service or a task journal rejects with, converted at the
 *   facade boundary into `self-development/core` (`details.code` keeps the original code).
 */
@Remote('listTasks') async listTasks(): Promise<readonly TaskSummary[]>

/**
 * Read one task's full projection and its confirmation-card view. The card
 * carries the task's stored launch profile, when the host has set one; a
 * stored but unreadable profile refuses the read with
 * `self-development/config-invalid` rather than rendering without it.
 * @param taskId - task identity.
 * @returns the projection and the read-only card.
 * @throws SelfDevelopmentRemoteError with `self-development/disabled` while the facade is disabled,
 *   `self-development/config-invalid` when the task id is malformed or the stored launch profile
 *   fails its shape validation, or
 *   `self-development/task-unknown` when the task has no journal yet; the facade never creates a
 *   journal from a read path.
 * @throws whatever the task-control service rejects with, converted at the facade boundary into
 *   `self-development/core` (`details.code` keeps the original code).
 */
@Remote('getTask') async getTask(taskId: string): Promise<TaskDetail>

/**
 * Read the retained recent self-development notification events.
 * @returns the events consumer's title-level buffer, oldest first; `[]` when
 *   the events consumer plugin is not loaded in this context.
 * @throws SelfDevelopmentRemoteError with `self-development/disabled` while the facade is disabled.
 */
@Remote('recentEvents') async recentEvents(): Promise<readonly RecentEvent[]>

/**
 * Create one task from a TaskSpec, optionally storing a launch profile in
 * the same call. The actor is the spec's `createdBy` field; it is checked
 * against `allowedActors` when that list is non-empty. The profile's
 * derived `confirmedBy` and the spec's `createdBy` are both actor-checked.
 * The profile is written only after the core commits the creation: a
 * failed create leaves no profile file behind.
 * @param spec - TaskSpec in wire form.
 * @param expectedRevision - revision the caller observed; a new task is at revision 0.
 * @param launchProfile - optional launch profile; host-only, and every field of it derives or
 *   stores an isolation or confirmation setting.
 * @returns the operation id the facade generated plus the core's result.
 * @throws SelfDevelopmentRemoteError with `self-development/disabled`, `self-development/config-invalid`,
 *   `self-development/actor-forbidden`, or `self-development/host-only-field` from a non-host caller:
 *   the spec fixes `stableBaselineDigest` and `allowedModificationScope`, and a present
 *   `launchProfile` fixes the launch isolation and confirmation settings, which the phone
 *   whitelist may not set.
 * @throws whatever the task-control service rejects with, converted at the facade boundary into
 *   `self-development/core` (`details.code` keeps the original code).
 */
@Remote('createTask') async createTask( spec: TaskSpecInput, expectedRevision: number, launchProfile?: LaunchProfileInput, ): Promise<RemoteOperationResult>

/**
 * Store one task's launch profile, replacing any previous one. The profile
 * resolves its derived fields against the task's current spec and the
 * facade's `allowedActors` before anything is written.
 * @param taskId - task identity.
 * @param profile - launch profile in wire form; every field is host-only.
 * @returns the task id and the stored profile with every derived field filled.
 * @throws SelfDevelopmentRemoteError with `self-development/disabled`, `self-development/config-invalid`
 *   (malformed id, malformed profile, or an underivable `artifactPaths`/`confirmedBy`),
 *   `self-development/actor-forbidden`, `self-development/host-only-field` from a non-host caller,
 *   or `self-development/task-unknown` when the task has no journal yet.
 * @throws whatever the task-control service rejects with, converted at the facade boundary into
 *   `self-development/core` (`details.code` keeps the original code).
 */
@Remote('setLaunchProfile') async setLaunchProfile(taskId: string, profile: LaunchProfileInput): Promise<LaunchProfileResult>

/**
 * Grant the separate planning authorization. This never approves
 * development and consumes no development round.
 * @param taskId - task identity.
 * @param expectedRevision - revision the caller observed.
 * @param authorizedBy - human actor granting the authorization.
 * @returns the operation id the facade generated plus the core's result.
 * @throws SelfDevelopmentRemoteError with `self-development/disabled` or `self-development/config-invalid`.
 * @throws whatever the task-control service rejects with, converted at the facade boundary into
 *   `self-development/core` (`details.code` keeps the original code).
 */
@Remote('authorizePlanning') async authorizePlanning(taskId: string, expectedRevision: number, authorizedBy: string): Promise<RemoteOperationResult>

/**
 * Submit a drafted plan for human confirmation.
 * @param taskId - task identity.
 * @param expectedRevision - revision the caller observed.
 * @param draft - plan draft in wire form.
 * @returns the operation id the facade generated plus the core's result.
 * @throws SelfDevelopmentRemoteError with `self-development/disabled` or `self-development/config-invalid`.
 * @throws whatever the task-control service rejects with, converted at the facade boundary into
 *   `self-development/core` (`details.code` keeps the original code).
 */
@Remote('submitPlanDraft') async submitPlanDraft( taskId: string, expectedRevision: number, draft: PlanDraftInput, ): Promise<RemoteOperationResult>

/**
 * Freeze the human-confirmed plan. The actor is the explicit confirmer.
 * @param taskId - task identity.
 * @param expectedRevision - revision the caller observed.
 * @param plan - confirmed plan in wire form.
 * @param actor - human actor confirming the plan; checked against `allowedActors`.
 * @returns the operation id the facade generated plus the core's result.
 * @throws SelfDevelopmentRemoteError with `self-development/disabled`, `self-development/config-invalid`,
 *   or `self-development/actor-forbidden`.
 * @throws whatever the task-control service rejects with, converted at the facade boundary into
 *   `self-development/core` (`details.code` keeps the original code).
 */
@Remote('confirmPlan') async confirmPlan( taskId: string, expectedRevision: number, plan: ConfirmedPlanInput, actor: string, ): Promise<RemoteOperationResult>

/**
 * Record a human budget approval, or replace the current one. The actor is
 * the approval's `approvedBy` field; consumed rounds and time never reset.
 * @param taskId - task identity.
 * @param expectedRevision - revision the caller observed.
 * @param approval - budget approval in wire form.
 * @returns the operation id the facade generated plus the core's result.
 * @throws SelfDevelopmentRemoteError with `self-development/disabled`, `self-development/config-invalid`,
 *   or `self-development/actor-forbidden`.
 * @throws whatever the task-control service rejects with, converted at the facade boundary into
 *   `self-development/core` (`details.code` keeps the original code).
 */
@Remote('approveBudget') async approveBudget( taskId: string, expectedRevision: number, approval: BudgetApprovalInput, ): Promise<RemoteOperationResult>

/**
 * Stop a task at human request. When the runner is loaded, the stop goes
 * through it so owned process groups and evidence writes finish before the
 * result returns; otherwise only the core stop runs.
 * @param taskId - task identity.
 * @param expectedRevision - revision the caller observed.
 * @param reason - optional stop reason; only `cancelled` exists today.
 * @returns the operation id the facade generated plus the core's result.
 * @throws SelfDevelopmentRemoteError with `self-development/disabled` or `self-development/config-invalid`.
 * @throws whatever the core or the runner rejects with, converted at the facade boundary into
 *   `self-development/core` (`details.code` keeps the original code).
 */
@Remote('stop') async stop(taskId: string, expectedRevision: number, reason?: 'cancelled'): Promise<RemoteOperationResult>

/**
 * Record a human trial approval bound to the current verified result. The
 * actor is the approver. No upgrade path exists in this facade.
 * @param taskId - task identity.
 * @param expectedRevision - revision the caller observed.
 * @param approvedBy - human actor approving the trial; checked against `allowedActors`.
 * @returns the operation id the facade generated plus the core's result.
 * @throws SelfDevelopmentRemoteError with `self-development/disabled`, `self-development/config-invalid`,
 *   or `self-development/actor-forbidden`.
 * @throws whatever the task-control service rejects with, converted at the facade boundary into
 *   `self-development/core` (`details.code` keeps the original code).
 */
@Remote('recordTrialApproval') async recordTrialApproval( taskId: string, expectedRevision: number, approvedBy: string, ): Promise<RemoteOperationResult>

/**
 * Launch one supervised attempt. The facade assembles the
 * `PresenceConfirmation` from the request and the frozen plan, and refuses
 * unless the caller explicitly passed `presenceAcknowledged: true` — a UI
 * must never default that acknowledgement. Requires the runner plugin.
 *
 * The five launch fields (`worktree`, `artifactPaths`, `acceptancePath`,
 * `loopbackAllowlist`, `confirmedBy`) are optional: an absent field is
 * derived from the task's stored launch profile, and an explicit value
 * overrides the profile. A field that is neither explicit nor derivable
 * refuses with `self-development/config-invalid`, naming the field.
 * @param request - the supervised attempt request in wire form.
 * @returns the runner's outcome plus the operation id the facade generated.
 * @throws SelfDevelopmentRemoteError with `self-development/disabled`, `self-development/config-invalid`
 *   (a malformed field, an unreadable stored profile, or an underivable launch field),
 *   `self-development/presence-unconfirmed` when
 *   `presenceAcknowledged` is not exactly `true`, `self-development/host-only-field` from a
 *   non-host caller (the launch assigns the worktree, acceptance, and artifact isolation
 *   settings, and a non-host request may not set the host-only `dataHome`), or
 *   `self-development/runner-unavailable` when the runner plugin is not loaded.
 * @throws whatever the core or the runner rejects with, converted at the facade boundary into
 *   `self-development/core` (`details.code` keeps the original code).
 */
@Remote('runAttempt') async runAttempt(request: RemoteRunAttemptRequest): Promise<RemoteRunAttemptOutcome>

/**
 * The task ids of the attempts the runner currently owns, plus every task
 * with a campaign loop this process currently owns.
 * @returns a read-only snapshot, deduplicated; excludes the runner's own
 *   set only when the runner plugin is absent.
 * @throws SelfDevelopmentRemoteError with `self-development/disabled` while the facade is disabled.
 */
@Remote('activeTasks') async activeTasks(): Promise<readonly string[]>

/**
 * Start one unattended campaign: create its record and launch the first
 * round immediately, in the background. The returned state is the freshly
 * created record (`status: 'running'`, `rounds: 0`) — it never waits for
 * the first round, which can run for as long as the approved budget
 * allows; poll `campaign(taskId)` for progress.
 *
 * `options.unattended` decides both the acknowledgement every round this
 * campaign derives carries and whether the loop continues past the first
 * round. `true`: every round — including the first — carries
 * `acknowledgement: 'unattended-accepted'`, the recorded fact of this
 * call's one-time acceptance covering the whole budget window, never an
 * isolation guarantee; the loop keeps launching rounds, each with a
 * freshly derived `PresenceConfirmation` and a fresh operation id, until a
 * terminal status. `false`: this call's acceptance covers only the first
 * round, which therefore carries `acknowledgement:
 * 'supervised-not-unattended'` — the same literal a direct `runAttempt`
 * asserts. A pass still reaches `status: 'passed'`, sharing the loop's one
 * success path with an `unattended: true` campaign — passing is already
 * terminal regardless of `unattended`. Only a failure that is not itself
 * campaign-terminal stops the loop early because `unattended` is `false`:
 * `status: 'stopped'`, leaving further rounds to a direct manual
 * `runAttempt`.
 * @param taskId - task identity.
 * @param expectedRevision - revision the caller observed; binds the first round only, later rounds re-read the current revision.
 * @param options - campaign options; host-only in full.
 * @returns the task id and the freshly created campaign state.
 * @throws SelfDevelopmentRemoteError with `self-development/disabled`, `self-development/config-invalid`
 *   (malformed fields, a task that already has a running campaign, or a call that would exceed
 *   `maxConcurrentCampaigns`), `self-development/actor-forbidden`, `self-development/host-only-field`
 *   from a non-host caller, or `self-development/runner-unavailable` when the runner plugin is not loaded.
 */
@Remote('startCampaign') async startCampaign(taskId: string, expectedRevision: number, options: CampaignOptions): Promise<{ readonly taskId: string readonly campaign: CampaignState }>

/**
 * Read one task's current campaign state.
 * @param taskId - task identity.
 * @returns the stored campaign state, or `undefined` when the task has never had a campaign.
 * @throws SelfDevelopmentRemoteError with `self-development/disabled`, `self-development/config-invalid`
 *   (malformed task id, or a corrupt stored record), or `self-development/host-only-field` from a
 *   non-host caller.
 */
@Remote('campaign') async campaign(taskId: string): Promise<CampaignState | undefined>

/**
 * Stop one task's campaign: cancel whatever attempt is currently in flight
 * through the runner and end the loop. Already terminal (not `running`) is
 * a no-op that returns the stored state unchanged — nothing is left in
 * flight to cancel. Requires the runner plugin, exactly like
 * `startCampaign`: a campaign cannot exist without one having launched its
 * rounds.
 * @param taskId - task identity.
 * @param reason - human-readable stop reason recorded on the campaign; never entered into an event title verbatim.
 * @returns the finalized (or already-terminal) campaign state.
 * @throws SelfDevelopmentRemoteError with `self-development/disabled`, `self-development/config-invalid`
 *   (malformed fields, or no campaign record exists for this task), `self-development/host-only-field`
 *   from a non-host caller, or `self-development/runner-unavailable` when the runner plugin is not loaded.
 * @throws whatever the core or the runner rejects with, converted at the facade boundary into
 *   `self-development/core` (`details.code` keeps the original code).
 */
@Remote('stopCampaign') async stopCampaign(taskId: string, reason: string): Promise<CampaignState>
```

Source: [`packages/workflow/workflow-self-development-remote/src/index.ts`](../../packages/workflow/workflow-self-development-remote/src/index.ts)

<a id="ctxselfdevelopmentrunner--selfdevelopmentrunner"></a>

### `ctx.selfDevelopmentRunner` — `SelfDevelopmentRunner`

Cordis service composing the supervised-mode attempt pipeline.

```ts cordis-catalog
/**
 * The runner's trusted clock. The first call creates one `HostClock`; later
 * calls return the same instance, so every task and attempt shares one
 * boot-session observer.
 * @returns the singleton trusted clock.
 */
clock(): HostClock

/**
 * Run one supervised attempt for a task. A second attempt for the same task
 * while one is in flight in this runner is refused before the core is
 * touched; worktree, confirmation, launch-record, and evidence validation
 * are `runSupervisedAttempt`'s responsibility.
 * @param req - the supervised attempt to run, keyed by task id.
 * @returns the core operation result with the attempt id, evidence path, and
 *   outcome write failure of this process's execution.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_ATTEMPT_ACTIVE` when this runner
 *   already owns an in-flight attempt for `req.taskId`.
 * @throws whatever the core's `open` or `runSupervisedAttempt` rejects with,
 *   verbatim: a journal handoff is a human decision and is never wrapped,
 *   retried, or recorded as an attempt outcome here.
 */
runAttempt(req: SupervisedAttemptRequest): Promise<SupervisedAttemptOutcome>

/**
 * Stop a task and finish this runner's own work for it. The core commits
 * `task/stopped` and aborts the attempt's launch signal first; this runner
 * then aborts its own cancellation handle and waits until the attempt's
 * promise has settled — the executor and acceptor process groups have exited
 * and the evidence writes are done — before returning the core's result.
 * Without an in-flight attempt, only the core stop runs.
 * @param req - task, expected revision, and idempotency key of the stop.
 * @returns the core's stop operation result.
 * @throws whatever the core's `open` or `stop` rejects with, verbatim.
 */
async stop(req: { readonly taskId: string readonly expectedRevision: number readonly operationId: string }): Promise<TaskOperationResult>

/**
 * The task ids of the attempts this runner currently owns.
 * @returns a read-only snapshot; later ownership changes are not reflected.
 */
activeTasks(): readonly string[]
```

Source: [`packages/workflow/workflow-self-development-runner/src/index.ts`](../../packages/workflow/workflow-self-development-runner/src/index.ts)

<a id="ctxselfdevelopmenttasks--selfdevelopmenttasks"></a>

### `ctx.selfDevelopmentTasks` — `SelfDevelopmentTasks`

Cordis service holding the per-task controllers. The service caches no evidence source.

```ts cordis-catalog
/**
 * Open (or resume) one task's controller against its private journal.
 * Repeated calls return the same controller.
 * @param taskId - task identity naming the journal directory.
 * @param clock - trusted clock observation source supplied by the host, used
 *   only to mark an attempt left in flight by a previous process as interrupted.
 * @returns the task controller.
 * @throws SelfDevelopmentError with `SELF_DEV_JOURNAL_UNAVAILABLE` when the journal failed verification; the caller must expose handoff.
 */
async open(taskId: string, clock: TrustedClock): Promise<SelfDevelopmentTaskController>

/**
 * Read a task's projection without the caller needing a controller.
 * @param taskId - task identity.
 * @param clock - trusted clock observation source supplied by the host.
 * @returns the current projection.
 */
async state(taskId: string, clock: TrustedClock): Promise<TaskProjection>

/**
 * Classify a journal rejection for callers that surface handoff state.
 * @param error - error thrown by {@link SelfDevelopmentTasks.open}.
 * @returns true when the error means the task journal refused side effects.
 */
isJournalHandoff(error: unknown): boolean
```

Source: [`packages/workflow/workflow-self-development/src/index.ts`](../../packages/workflow/workflow-self-development/src/index.ts)

<a id="ctxselfdevelopmenttrial--selfdevelopmenttrial"></a>

### `ctx.selfDevelopmentTrial` — `SelfDevelopmentTrial`

Host-only trial-instance service. Ordinary chat messages never reach its methods: each is a `@Remote` method invoked explicitly through the Typert gateway, and a non-host caller is refused.

```ts cordis-catalog
/**
 * Open (or reuse) one task's trial instance. The worktree and data home
 * come from the task's stored launch profile through the facade's
 * `getTask`; a profile without `dataHome` falls back to the runner's
 * configured `dshHome`. A worktree whose root `package.json` is not the
 * DSH root returns a reason instead of an instance.
 * @param taskId - task identity.
 * @returns the ready instance's URL, port, and pid, or `url: undefined` with the reason
 *   when the worktree is not a DSH repository.
 * @throws SelfDevelopmentTrialError with `self-development/host-only-field` from a non-host caller,
 *   `self-development/config-invalid` when the task id is malformed or the task has no launch
 *   profile, `self-development/task-unknown` when the facade does not know the task,
 *   `self-development/trial-unavailable` when neither the profile nor the runner supplies a data
 *   home, `self-development/trial-build-failed` when the worktree build fails or times out,
 *   `self-development/trial-port-exhausted` when no port in the range is free, or
 *   `self-development/trial-start-failed` when the web process never becomes ready.
 * @throws whatever the facade rejects with, verbatim: the facade owns its own error codes.
 */
@Remote('openTrial') async openTrial(taskId: string): Promise<OpenTrialResult>

/**
 * Close one task's trial instance: SIGTERM to the registered process
 * group, a five-second grace, then SIGKILL, and a bounded wait for the
 * group leader this service spawned to exit. The registration and the
 * sidecar are removed. Closing a task without a live instance still
 * removes a stale sidecar.
 * @param taskId - task identity.
 * @throws SelfDevelopmentTrialError with `self-development/host-only-field` from a non-host caller,
 *   `self-development/config-invalid` when the task id is malformed, or
 *   `self-development/trial-stop-failed` when the group cannot be signalled or its exit is not
 *   confirmed within the teardown deadlines.
 */
@Remote('closeTrial') async closeTrial(taskId: string): Promise<void>

/**
 * List the live trial instances this process owns.
 * @returns one row per live instance, sorted by task id; a process restart starts from `[]`
 *   because instances are never resurrected from sidecars.
 * @throws SelfDevelopmentTrialError with `self-development/host-only-field` from a non-host caller.
 */
@Remote('trials') async trials(): Promise<readonly TrialSummary[]>
```

Source: [`packages/workflow/workflow-self-development-trial/src/index.ts`](../../packages/workflow/workflow-self-development-trial/src/index.ts)

<a id="ctxselfdevelopmentworkspaces--selfdevelopmentworkspaces"></a>

### `ctx.selfDevelopmentWorkspaces` — `SelfDevelopmentWorkspaces`

Cordis service composing workspace allocation, release, and serialized integration.

```ts cordis-catalog
/**
 * Allocate the workspace for one task, or return the workspace a previous
 * allocation registered for the same task id. Allocation is refused — not
 * queued — once the configured concurrency limit is reached, because a
 * queued task behind live worktrees would not run in parallel. Allocations
 * and releases against one experiments root serialize in memory, so the
 * limit check and the registry write are exact within this process; across
 * processes the deployment keeps one writer per experiments root.
 * @param req - task id, project root, and optional baseline commit.
 * @returns the task's workspace record.
 * @throws SelfDevelopmentWorkspacesError with the codes documented on
 *   {@link allocateWorkspace}.
 */
allocate(req: AllocateRequest): Promise<TaskWorkspace>

/**
 * Release one task's workspace: remove its worktree, delete its data home,
 * and drop the registry entry. Only registered paths are touched.
 * @param taskId - the task whose workspace is released.
 * @throws SelfDevelopmentWorkspacesError with the codes documented on
 *   {@link releaseWorkspace}.
 */
release(taskId: string): Promise<void>

/**
 * List the currently allocated workspaces from the durable registry.
 * @returns the registry's workspace records; later allocation changes are
 *   not reflected in a returned snapshot.
 * @throws SelfDevelopmentWorkspacesError with `SELF_DEV_WORKSPACE_REGISTRY_INVALID` when
 *   the registry file cannot be read or parsed.
 */
async list(): Promise<readonly TaskWorkspace[]>

/**
 * Integrate one allocated task's worktree into a project branch. Calls on
 * one service instance serialize in memory; calls across processes
 * serialize on the experiments root's integration lock. Git failures inside
 * the integration are reported as a `failed` result, never thrown.
 * @param req - task id, target branch, and actor.
 * @returns the integration outcome.
 * @throws SelfDevelopmentWorkspacesError with `SELF_DEV_WORKSPACE_TASK_UNKNOWN` when the
 *   task has no allocated workspace, and with `SELF_DEV_WORKSPACE_INTEGRATION_BUSY`
 *   when a live cross-process lock holder does not release in time. The
 *   in-memory chain itself has no busy bound: a call waits indefinitely
 *   behind a serialized callback that never settles.
 */
integrate(req: IntegrationRequest): Promise<IntegrationResult>
```

Source: [`packages/workflow/workflow-self-development-workspaces/src/index.ts`](../../packages/workflow/workflow-self-development-workspaces/src/index.ts)

<a id="ctxworkflowengine--workflowengine-abstract-seam"></a>

### `ctx.workflowEngine` — `WorkflowEngine` (abstract seam)

Workflow Service Definition contract. Invalid requests throw before publication; a live run is holder-owned, its result never rejects, and disposal waits for script and child cleanup. Lifecycle listener failures are contained, and `workflow/end` fires exactly once as the result settles.

```ts cordis-catalog
/**
 * Parse and execute a workflow script.
 * @param request - the script, its `args`, the parent agent, and an
 *   optional cancel signal.
 * @returns the live run; its `result` resolves when the script settles.
 */
abstract start(request: WorkflowStartRequest): WorkflowRun
```

Source: [`packages/workflow/workflow/src/index.ts`](../../packages/workflow/workflow/src/index.ts)

<a id="self-development-events"></a>

### `self-development/*` events

<a id="self-developmentcampaign-ended--emit"></a>

#### `self-development/campaign-ended` — emit

One unattended campaign's loop ended without a pass: its budget was exhausted, a human called `stopCampaign`, or an unrecognized failure ended it. The closed-vocabulary `status` reaches the title; the free-text `CampaignState.reason` never leaves the Remote facade.

```ts cordis-catalog
/**
 * One unattended campaign's loop ended without a pass: its budget was
 * exhausted, a human called `stopCampaign`, or an unrecognized failure
 * ended it. The closed-vocabulary `status` reaches the title; the
 * free-text `CampaignState.reason` never leaves the Remote facade.
 * @param payload - the task id, the closed-vocabulary end status, and the observed revision.
 * @mode emit
 */
'self-development/campaign-ended'(payload: CampaignEndedPayload): void
```

Source: [`packages/workflow/workflow-self-development-events/src/campaign.ts`](../../packages/workflow/workflow-self-development-events/src/campaign.ts)

<a id="self-developmentcampaign-passed--emit"></a>

#### `self-development/campaign-passed` — emit

One unattended campaign reached a passing round — the same durable `task/passed` outcome a manual `runAttempt` produces, reached through the campaign's own automatic rounds instead. Fixed title; carries no round number or free text.

```ts cordis-catalog
/**
 * One unattended campaign reached a passing round — the same durable
 * `task/passed` outcome a manual `runAttempt` produces, reached through
 * the campaign's own automatic rounds instead. Fixed title; carries no
 * round number or free text.
 * @param payload - the task id and the post-commit projection revision.
 * @mode emit
 */
'self-development/campaign-passed'(payload: CampaignPassedPayload): void
```

Source: [`packages/workflow/workflow-self-development-events/src/campaign.ts`](../../packages/workflow/workflow-self-development-events/src/campaign.ts)

<a id="self-developmentcommitted--emit"></a>

#### `self-development/committed` — emit

One task event reached its durable journal: every successful controller commit, including the `attempt/failed` and `handoff/raised` commits a restart recovery appends. The payload carries the hash-chained record and the frozen post-commit projection. Listener failures are contained and logged; they never affect the commit or the task state.

```ts cordis-catalog
/**
 * One task event reached its durable journal: every successful
 * controller commit, including the `attempt/failed` and `handoff/raised`
 * commits a restart recovery appends. The payload carries the hash-chained
 * record and the frozen post-commit projection. Listener failures are
 * contained and logged; they never affect the commit or the task state.
 * @param payload - the task id, the committed journal record, and the frozen projection after the commit.
 * @mode emit
 */
'self-development/committed'(payload: SelfDevelopmentCommittedPayload): void
```

Source: [`packages/workflow/workflow-self-development/src/index.ts`](../../packages/workflow/workflow-self-development/src/index.ts)

<a id="workflow-events"></a>

### `workflow/*` events

<a id="workflowagent-end--emit"></a>

#### `workflow/agent-end` — emit

One `agent()` call settled (clean result, child failure, or run cancellation). Paired with Events['workflow/agent-start'] by `agent.seq`, exactly once per started call on every stop path — on an engine termination path the end is engine-synthesized with outcome `'cancelled'`.

```ts cordis-catalog
/**
 * One `agent()` call settled (clean result, child failure, or run
 * cancellation). Paired with {@link Events['workflow/agent-start']} by
 * `agent.seq`, exactly once per started call on every stop path — on an
 * engine termination path the end is
 * engine-synthesized with outcome `'cancelled'`.
 * @param info - the run's identity snapshot.
 * @param agent - the call identity plus its outcome.
 * @mode emit
 */
'workflow/agent-end'(info: WorkflowRunInfo, agent: WorkflowAgentEndInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowagent-start--emit"></a>

#### `workflow/agent-start` — emit

One `agent()` call established a published child run. Paired with Events['workflow/agent-end'] by `agent.seq`. A call that never receives a published run from the provider emits neither event in this pair.

```ts cordis-catalog
/**
 * One `agent()` call established a published child run. Paired with
 * {@link Events['workflow/agent-end']} by `agent.seq`. A call that never
 * receives a published run from the provider emits neither
 * event in this pair.
 * @param info - the run's identity snapshot.
 * @param agent - the call's sequence number, label, phase, and child id.
 * @mode emit
 */
'workflow/agent-start'(info: WorkflowRunInfo, agent: WorkflowAgentInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowend--emit"></a>

#### `workflow/end` — emit

A workflow run settled (any stop reason). Fired when WorkflowRun.result resolves. Paired with Events['workflow/start'].

```ts cordis-catalog
/**
 * A workflow run settled (any stop reason). Fired when
 * {@link WorkflowRun.result} resolves. Paired with
 * {@link Events['workflow/start']}.
 * @param info - the run's identity snapshot.
 * @param result - the outcome data (stop reason, error, agent count) —
 *   deliberately WITHOUT the result value (see {@link WorkflowResultInfo}).
 * @mode emit
 */
'workflow/end'(info: WorkflowRunInfo, result: WorkflowResultInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowlog--emit"></a>

#### `workflow/log` — emit

The script emitted a narration line (a `log(message)` call).

```ts cordis-catalog
/**
 * The script emitted a narration line (a `log(message)` call).
 * @param info - the run's identity snapshot.
 * @param message - the logged message, verbatim.
 * @mode emit
 */
'workflow/log'(info: WorkflowRunInfo, message: string): void
```

Source: [`packages/workflow/workflow/src/index.ts`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowphase--emit"></a>

#### `workflow/phase` — emit

The script entered a phase (a `phase(title)` call) — progress grouping for observers; no execution semantics.

```ts cordis-catalog
/**
 * The script entered a phase (a `phase(title)` call) — progress grouping
 * for observers; no execution semantics.
 * @param info - the run's identity snapshot.
 * @param title - the phase title, verbatim.
 * @mode emit
 */
'workflow/phase'(info: WorkflowRunInfo, title: string): void
```

Source: [`packages/workflow/workflow/src/index.ts`](../../packages/workflow/workflow/src/index.ts)

<a id="workflowstart--emit"></a>

#### `workflow/start` — emit

A workflow run started — the script's meta block validated, the body about to execute. Paired with Events['workflow/end'].

```ts cordis-catalog
/**
 * A workflow run started — the script's meta block validated, the body
 * about to execute. Paired with {@link Events['workflow/end']}.
 * @param info - the run's identity snapshot (id + meta).
 * @mode emit
 */
'workflow/start'(info: WorkflowRunInfo): void
```

Source: [`packages/workflow/workflow/src/index.ts`](../../packages/workflow/workflow/src/index.ts)
<!-- END GENERATED cordis-surface -->
