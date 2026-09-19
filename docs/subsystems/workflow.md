# Workflow

English | [中文](workflow.zh.md)

The workflow seam lets an agent run a model-written orchestration SCRIPT that starts subagents. Like [subagent](subagent.md) it is **one optional capability**, not part of the agent loop, so its types and operations live here rather than in [core.md](core.md). Like bash, it permits ONE engine implementation per context to provide `ctx.workflowEngine`; there is no named-provider registry (a second engine replaces the first through plugin configuration rather than running beside it).

Service Definition: [dsh-workflow](../../packages/workflow/workflow) (`ctx.workflowEngine` and the vocabulary below). [dsh-workflow-ptc](../../packages/workflow/workflow-ptc) executes the VM and helpers through the shared Node PTC process runtime under the calling Session's file policy. The consumers are [dsh-tool-workflow](../../packages/workflow/tool-workflow) and the opt-in [dsh-tool-ralph](../../packages/workflow/tool-ralph). [Workflow sandbox reuse](../../.agents/notes/implemented/architecture/2026-09-13-workflow-ptc-sandbox-reuse.md) owns execution choices; the [dynamic-workflows decision](../../.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.md) owns script semantics.

Sources: browser-safe vocabulary in [`packages/workflow/workflow/src/types.ts`](../../packages/workflow/workflow/src/types.ts), Host request and live-run handles in [`runtime-types.ts`](../../packages/workflow/workflow/src/runtime-types.ts).

## The start request

What a caller asks for when starting a run. The ordinary workflow tool builds this from the model's `{ script, meta, args }` call plus the calling agent; specialized consumers may also select one engine-wide `subagentProvider` and lower `maxTotalAgents` for the run, but the script cannot observe or replace either policy. `meta` and `args` are plain JSON DATA (the engine validates `meta` against its schema and rejects loud BEFORE anything runs — no script text is ever evaluated to obtain it). `parent` is REQUIRED — every child the script starts is attributed to it, and cwd, lineage, and depth pass through the [subagent seam](subagent.md).

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

## The workflow's identity: `WorkflowMeta`

The identity block carried as data on the start request (the tool's `meta` parameter; the field vocabulary matches the Claude Code dynamic-workflows meta block). `phases` is progress vocabulary only: `phase()` calls match titles for observers; no execution structure is implied.

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

## The terminal result: `WorkflowResult`

The outcome of one run, resolved by `WorkflowRun.result`. `value` is the script's materialized return value — plain host-realm JSON data (`null` when the script returned nothing) — meaningful only for `completed`. `stopReason` is a CLOSED union (engine-owned; consumers may exhaust it): `completed` | `cancelled` | `error`. A non-`completed` reason carries the failure in `error`, and the consumer maps it to an `isError` tool result rather than reporting partial output as success.

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

## A live run: `WorkflowRun`

The consumer awaits `result`, may `cancel` during execution, and must `dispose` on every path. `result` never rejects: script failure resolves with `stopReason: 'error'`, and cancellation with `'cancelled'`. The PTC engine has no overall elapsed deadline; it immediately aborts the managed process when cancelled. Disposal awaits process and child cleanup under their provider contracts, without an independent workflow cleanup deadline.

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

## Failure discipline: `WorkflowError.fatal`

Hook misuse inside a script — bad arguments, unknown/deferred `agent()` options, a schema outside the [structured-output subset](../../packages/core/tools/README.md), a tripped cap, a seam start failure, cancellation — throws a `WorkflowError` with `fatal: true`. The `parallel()`/`pipeline()` combinators RE-THROW fatal errors instead of mapping the item to `null`: a typo'd option must kill the script loudly, never dissolve into something that reads as an ordinary child failure. The per-item `null` is reserved for child-run failures (a non-`completed` stop reason) and ordinary in-stage script errors.

## Events

The `workflow/*` events (`workflow/start`, `workflow/phase`, `workflow/log`, `workflow/agent-start`, `workflow/agent-end`, `workflow/end` — see the [events catalog](#cordis-surface)) are **observe-only** emits carrying DATA SNAPSHOTS: every payload starts with `WorkflowRunInfo` (id + meta), never the live `WorkflowRun`, so a subscriber cannot gain `cancel`/`dispose`, and `workflow/end` deliberately omits the result value (a listener observing outcomes must not receive a mutable alias of the caller's result). Every emit is per-listener contained — a throwing subscriber is logged, never propagated, and cannot starve the listeners registered after it — and every listener receives its own payload clone, so mutating it corrupts neither the engine nor other listeners; the containment mirrors `subagent/start`/`subagent/end`.

## Durable Chat records

The top-level `dsh-tool-workflow` consumer projects display facts into its calling parent Session without changing execution ownership. It writes `tool-workflow/run-start` after a run is accepted, pairs member start and end by `runId + seq`, and writes `tool-workflow/run-end` only after the result is known and disposal reaches quiescence. Nested transport calls write no record. The first append failure disables later writes for that run, so the log remains empty or a legal continuous prefix and the tool result is unchanged.

`dsh-tool-workflow/invariant` validates the same protocol before live commit and when a Session is loaded: one start per run, positive unique member sequences, paired member endings, no run ending with open members, and no updates after the run ending. A missing member ending or run ending at the log tail is valid interruption evidence rather than corruption.

`dsh-client-ui-workflow-run` folds the four events through the Conversation Node engine into one `workflow-run` Chat node anchored at the run-start sequence, after the original workflow tool node. Phase groups come only from actual member starts and preserve exact strings, including the distinction between an omitted phase and `''`. Closed Locations turn missing terminal facts into interrupted presentation. The [UI package README](../../packages/client/ui-workflow-run/README.md) owns disclosure, status, and same-parent local navigation behavior.

## Self-development task control and the supervised runner

The workflow group also owns the opt-in self-development pair, which lives outside the script seam. [dsh-workflow-self-development](../../packages/workflow/workflow-self-development/README.md) owns one durable lifecycle per task — versioned spec, frozen test plan, human budget approval, verified attempt results, trial approval — in a private control directory, and caches one serialized controller per task. [dsh-workflow-self-development-runner](../../packages/workflow/workflow-self-development-runner/README.md) composes one supervised attempt against that controller: the trusted clock, human-presence evidence, the operation-bound launch record, the headless executor, the independent acceptor, and durable attempt evidence with its terminal outcome. Every launch requires a recorded human confirmation and a finite budget; the pair provides supervised testing with recorded limits, never unattended operation. A third opt-in sibling, [dsh-workflow-self-development-workspaces](../../packages/workflow/workflow-self-development-workspaces/README.md), allocates one git worktree, branch, and copied data home per task under a durable registry and integrates finished task branches back to the project baseline serially. Every launch requires a recorded human confirmation and a finite budget; the three packages provide supervised testing with recorded limits, never unattended operation. All three services appear in the [Cordis API](#cordis-surface) as `ctx.selfDevelopmentTasks`, `ctx.selfDevelopmentRunner`, and `ctx.selfDevelopmentWorkspaces`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
