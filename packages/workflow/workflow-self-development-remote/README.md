---
description: "Stable-side Remote facade over self-development: read-only progress views, the human confirmation card, and explicit UI/phone operations for planning, budget, stopping, and trial approval. Disabled until enabled; no upgrade approval exists here."
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development-remote

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

Expose the self-development task-control service and the supervised runner as one stable typed Remote surface for the M4 UI and the phone whitelist. The facade makes no decision: reads return the projection and a read-only confirmation card, writes forward to the core with a generated operation id, and attempts launch only through the runner with an explicit presence acknowledgement. Per-task launch profiles are host-written deployment configuration from which `runAttempt` derives omitted launch fields; host-only campaigns repeat that launch automatically from one recorded acceptance. Every method refuses until `enabled: true`; the service ships in no default bundle.

## Table of Contents

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
## Service

`SelfDevelopmentRemote` (default export, Cordis service `selfDevelopmentRemote`, wire namespace `selfDevelopmentRemote`) injects the task-control service, resolves the supervised runner optionally — every attempt-related method refuses with `self-development/runner-unavailable` when the runner plugin is not loaded, while the read paths and the stop fallback work against the task-control service alone — and reads the connection service's caller context with `ctx.get` when that service is mounted (see the permission model).

| Config field | Meaning |
|---|---|
| `enabled` | Master switch. Defaults to `false`; every method returns `self-development/disabled` while it is `false`. |
| `allowedActors` | Actor allowlist. Empty (the default) means no restriction; non-empty requires the operation's actor field to appear in the list. |
| `controlDirectory` | The task-control service's control directory. The facade reads it to list task journals and writes only its own `launch-profiles/<taskId>.json` and `campaigns/<taskId>.json` files under it; it never touches the `tasks/` subtree. |
| `maxConcurrentCampaigns` | Default cap on simultaneously `running` campaigns across every task, applied when a `startCampaign` call omits its own `maxConcurrentCampaigns`. A direct construction (every test, and any deployment that does not load this plugin through `cordis.yml`) must set it explicitly; the `cordis.yml` schema defaults it to 2. |
| `roundDelayMs` | Minimum time between a campaign round that genuinely reached the core and failed, and the next round's launch. Depth defense against a rapid string of started-but-failing rounds, not what bounds them — the Campaigns section's Round loop below documents the mechanism that does. A direct construction must set it explicitly, exactly like `maxConcurrentCampaigns`; the `cordis.yml` schema defaults it to 1000. |

`controlDirectory` repeats the task-control service's value because that service keeps its resolved configuration private and this package may not modify it. The facade validates the path at construction and fails loudly on a relative value.


No runtime invariant companion is published: the facade exposes no runtime observation stream of its own, the relationships it forwards between the card view, the projection, and the core journal are covered by focused behavior tests, and the one deployment coupling it cannot verify itself — that its `controlDirectory` matches the task-control service's — is documented as a limitation instead of asserted.

<a id="methods"></a>
## Methods

Every method below is a `@Remote` method. Ordinary chat messages never reach them: a caller must invoke the endpoint explicitly through the Typert gateway, and the connection layer's own authorization applies before the facade runs.

| Method | Forwarding | Contract |
|---|---|---|
| `listTasks()` | read-only | Scans `<controlDirectory>/tasks/*` and returns one row per task: `taskId`, `status`, `revision`, and `title` (the first 80 characters of the requirement). Returns `[]` before the first task exists; journal directories are never created by this read. |
| `getTask(taskId)` | read-only | Returns the task's `TaskProjection` plus `card`, the read-only confirmation-card view described below. The card's `launchProfile` carries the task's stored launch profile with every derived field filled, when the host has set one. Refuses with `self-development/task-unknown` when the task has no journal yet. |
| `recentEvents()` | read-only | Returns the events consumer's title-level notification buffer, oldest first; `[]` when the events consumer plugin is not loaded. |
| `createTask(spec, expectedRevision, launchProfile?)` | `createTask` | Creates the task from the TaskSpec wire form. The actor is `spec.createdBy`. With `launchProfile`, the resolved profile is stored only after the core commits the creation, so a failed create leaves no profile file. Returns the facade-generated `operationId`. Host-only: refused from a non-host caller with `self-development/host-only-field`, because the spec fixes `stableBaselineDigest` and `allowedModificationScope`, and a present profile fixes the launch isolation and confirmation settings. |
| `authorizePlanning(taskId, expectedRevision, authorizedBy)` | `authorizePlanning` | Grants the separate planning authorization; it never approves development and consumes no round. |
| `submitPlanDraft(taskId, expectedRevision, draft)` | `submitPlanDraft` | Submits a drafted plan for human confirmation. |
| `confirmPlan(taskId, expectedRevision, plan, actor)` | `confirmPlan` | Freezes the human-confirmed plan. The actor is the explicit `actor` argument. |
| `approveBudget(taskId, expectedRevision, approval)` | `approveBudget` | Records or replaces the human budget approval. The actor is `approval.approvedBy`; consumed rounds and time never reset. `approval.preset: 'unlimited'` is a convenience that expands to a fixed 24-hour time budget (see [Campaigns](#campaigns)); an explicit field alongside it overrides that field's expanded default, and `mode` is required only when `preset` is absent. |
| `stop(taskId, expectedRevision, reason?)` | runner `stop`, else core `stop` | Stops the task. With the runner loaded, owned process groups and evidence writes finish before the result returns; without it, only the core stop runs. |
| `recordTrialApproval(taskId, expectedRevision, approvedBy)` | `recordTrialApproval` | Records the human trial approval bound to the current verified result. The actor is `approvedBy`. |
| `setLaunchProfile(taskId, profile)` | profile file write | Stores the task's launch profile (see below), replacing any previous one, and returns the resolved profile. Requires the task's journal to exist (`self-development/task-unknown` otherwise). Host-only: refused from a non-host caller with `self-development/host-only-field`. |
| `runAttempt(request)` | runner `runAttempt` | Launches one supervised attempt. The five launch fields (`worktree`, `artifactPaths`, `acceptancePath`, `loopbackAllowlist`, `confirmedBy`) are optional: an absent field is derived from the task's stored launch profile, and an explicit value overrides the profile. The facade assembles the `PresenceConfirmation`: `confirmedAt` is one trusted-clock observation taken now, `taskId`, `testPlanDigest` from the frozen plan, `acceptanceDefinitionDigest` from the definition's bytes, `artifactPaths` deduplicated and sorted ascending, and the fixed acknowledgement `supervised-not-unattended`. Requires `presenceAcknowledged: true` explicitly. Host-only: a non-host caller is refused with `self-development/host-only-field` — the launch assigns the worktree, acceptance, and artifact isolation settings — and a non-host request may not set the host-only `dataHome`, which the stable host forwards as the runner's per-attempt `dshHome`. Returns the runner's outcome plus the `operationId`. |
| `activeTasks()` | runner `activeTasks` | Returns the task ids of the attempts the runner currently owns, plus every task with a campaign loop this process currently owns; `[]` without the runner and without a running campaign. |
| `startCampaign(taskId, expectedRevision, options)` | runner `runAttempt`, repeated | Starts one unattended campaign (see below). Host-only. |
| `campaign(taskId)` | read-only | Returns the task's current `CampaignState`, or `undefined` when it never had one. Host-only. |
| `stopCampaign(taskId, reason)` | runner `stop` | Cancels a campaign's in-flight round and ends its loop. Host-only. |

Every mutating method generates its `operationId` with `randomUUID()` and returns it to the caller; a retry that wants the core's replay semantics must send that id back. All arguments are validated at the facade before the core or runner sees them, and every core or runner rejection is converted at the facade boundary into `self-development/core`, whose `details.code` keeps the owning package's machine-routable code.

### Launch profiles

A launch profile records the host's per-task launch settings so a one-click launch never asks a human for the derivable fields. `setLaunchProfile` and `createTask`'s third argument take the same wire form: required `worktree` and `acceptancePath` (absolute paths), optional `artifactPaths`, `dataHome`, `loopbackAllowlist`, and `confirmedBy`. The facade resolves the optional fields and stores the resolved form at `<controlDirectory>/launch-profiles/<taskId>.json`, written atomically (temporary file + rename) with mode 0600 inside a 0700 directory:

- `artifactPaths` derives from the task's `allowedModificationScope`; without a spec there is no source, and the call refuses with `self-development/config-invalid`.
- `confirmedBy` derives from a sole `allowedActors` entry; with none or several, the call refuses. The derived confirmer is actor-checked like an explicit one.
- `loopbackAllowlist` derives from `[]`; `dataHome` is never derived.

Reads validate the stored shape: a file that is not valid JSON or misses a field refuses with `self-development/config-invalid`, naming the file path but never its content. `getTask` renders the stored profile as `card.launchProfile`; `runAttempt` derives each of its five omitted launch fields from the profile, with an explicit request value overriding the profile; a field that is neither explicit nor derivable refuses with `self-development/config-invalid` and names the field, e.g. `runAttempt.worktree is missing and the task has no launch profile`. `presenceAcknowledged` is never derived.

<a id="campaigns"></a>
### Campaigns

A campaign launches a task's stored launch profile through the runner automatically, from one recorded human acceptance. `options.unattended` decides what that acceptance covers, and — not merely as a side effect — which acknowledgement literal every round it derives carries: `true` covers the whole approved budget window, and every round, including the first, carries `PresenceConfirmation.acknowledgement: 'unattended-accepted'`, which the runner's README defines as recording only that a human accepted, once, that later rounds launch without being asked again. `false` covers only the one round this call launches automatically, so that round carries `'supervised-not-unattended'` — the same literal a direct `runAttempt` asserts, because a human did in fact accept that one specific launch. A pass still reaches `status: 'passed'`, sharing the loop's one success path with an `unattended: true` campaign; only a non-terminal failure stops the loop early because `unattended` is `false`. Neither literal is an operating-system isolation guarantee.

`startCampaign(taskId, expectedRevision, options)` creates the campaign record and returns immediately with `status: 'running'`, `rounds: 0`; it never waits for a round, which can run for as long as the approved budget allows. `options`:

| Field | Meaning |
|---|---|
| `unattended` | `true`: the one acceptance below covers every automatic round inside the approved budget window — every round carries `acknowledgement: 'unattended-accepted'` — and the loop keeps launching rounds until a terminal status. `false`: the campaign still launches its first round automatically — this call is that round's one explicit acceptance, so it carries `acknowledgement: 'supervised-not-unattended'`. A pass still reaches `status: 'passed'`, sharing the loop's one success path with an `unattended: true` campaign; only a non-terminal failure stops the campaign early because `unattended` is `false` (`status: 'stopped'`), leaving further rounds to a direct manual `runAttempt`. |
| `acceptedBy` | The person accepting this campaign's rounds; checked against `allowedActors` like an explicit `runAttempt.confirmedBy`, and recorded as every derived round's `PresenceConfirmation.confirmedBy`. |
| `maxConcurrentCampaigns?` | Cap on simultaneously `running` campaigns, for this call only; defaults to the deployment's configured `maxConcurrentCampaigns` (itself defaulting to 2). Exceeding it, or a task that already has a running campaign, refuses with `self-development/config-invalid`. |

Every launch field (`worktree`, `artifactPaths`, `acceptancePath`, `loopbackAllowlist`) derives from the task's stored launch profile exactly as an omitted `runAttempt` field would — a campaign takes no per-round overrides, so `startCampaign` requires a launch profile to already be set. `dataHome` is never forwarded to a campaign round, matching `runAttempt`'s own behavior: only an explicit wire request carries it.

**Round loop.** Each round calls the same runner path `runAttempt` uses, with a freshly derived `PresenceConfirmation` (a new trusted-clock observation) and a freshly generated `operationId` — never a cached or reused confirmation. Before every round, including the first, the loop reads the core's live status, then launches:

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

The live status read exists because the core can reactively stop a task after a round settles — the no-progress limit or the budget floor tripping inside the core's own post-failure bookkeeping — without that round's own rejection ever naming the stop; only the read ahead of the *next* round reliably catches it instead of retrying blind into it.

A round rejected before the core commits `attempt/started` — an acceptance definition that is unreadable, malformed, or placed inside the experiments root, a confirmation that does not bind the real launch facts, a launch record that does not match a replayed operation, or any other rejection this package does not specifically recognize — ends the campaign as `failed` immediately: not retried, and not counted in `rounds`. The three recognized runner codes above are resolved without help; every other rejection is told apart from an ordinary failure by the core's own revision, read before and after the round, never by its code alone — a round that never reached the core never advances it, regardless of what error surfaces. An ordinary round failure that did reach the core (a failed or late acceptance, or any other recognized runner error committed there) is retried exactly like a human retrying a failed `runAttempt`, after waiting `roundDelayMs` first — depth defense against firing a rapid string of such rounds back to back, not what bounds their count; the live status read ahead of the next round is what actually bounds a persistently broken task, through the core's own `noProgressAttemptLimit`, which is why `preset: 'unlimited'` always sets one. Only an exception this package does not recognize as a core or runner error at all — a crash, not a round outcome — ends the campaign as `failed` the same way, without retrying; its message is never swallowed.

`stopCampaign(taskId, reason)` cancels whatever round is currently in flight through the runner, then finalizes the campaign as `stopped` with the given `reason`. Idempotent: called on an already-terminal campaign, it is a no-op that returns the stored state unchanged. Concurrent finalizers (a `stopCampaign` racing the loop's own termination) never corrupt each other: exactly one write wins, and every other caller — including a `stopCampaign` that started before the winner finished — returns that same actual outcome, never a stale pre-finalization view.

The campaign record lives at `<controlDirectory>/campaigns/<taskId>.json`, written atomically (temporary file + rename) with mode 0600 inside a 0700 directory, and is per-task runtime state the facade owns exclusively — the core journal never records it. At construction, this process marks every campaign it finds `running` as `stopped` with reason `process restarted` (scanned once, lazily, before the first campaign method call) — a campaign never resumes automatically across a restart, so an unattended campaign left running by a crashed process stays stopped until a human calls `startCampaign` again. That restart recovery writes the record directly and emits no `campaign-ended` event; a consumer must poll `campaign(taskId)` to notice it.

**Budget preset.** `approveBudget`'s `preset: 'unlimited'` expands to `{ mode: 'time', durationMs: 86_400_000, noProgressAttemptLimit: 5 }` before the core ever sees it — no per-attempt step/call cap (a `time`-mode budget is not required to carry one, so `unlimited` sets none), no per-phase cap, and no token cap; any field also set explicitly overrides or adds to that default. `durationMs` — explicit or preset-expanded — is hard-capped at 24 hours; a larger value refuses with `self-development/config-invalid` regardless of `preset`.

<a id="permission-model"></a>
## Permission model

The facade adds exactly three gates on top of the connection layer's authorization:

- **`enabled`** — `false` refuses every method with `self-development/disabled`, so mounting the plugin alone enables nothing.
- **`allowedActors`** — empty means unrestricted; non-empty gates the actor-carrying operations: `createTask` (`spec.createdBy`), `confirmPlan` (the `actor` argument), `approveBudget` (`approval.approvedBy`), `recordTrialApproval` (`approvedBy`), and `runAttempt` (`confirmedBy`). Progress reads, planning authorization, drafting, and stopping stay open to any actor, because watching progress, interjecting, and stopping are the lower-risk operations the phone whitelist exists for.
- **Caller origin** — the facade reads the optional connection service's caller context (`ctx.connection.caller.current()`, the frozen `ConnectionCaller` contract) and treats a caller as the stable host exactly when the request carries a loopback Host header or no caller context at all; a non-loopback Host header is a phone caller. `runAttempt`, `createTask`, and `setLaunchProfile` assign isolation settings — worktree, acceptance path, artifact paths, and `dataHome` for the launch; `stableBaselineDigest` and `allowedModificationScope` for the task — so all three are refused from a phone caller with `self-development/host-only-field` before the core or runner is touched, and a phone caller may not set or replace a task's launch profile. `startCampaign`, `campaign`, and `stopCampaign` are host-only in full — unlike the field-level gate above, the whole method is refused from a phone caller, including the read — because a campaign both assigns isolation settings and carries the one-time unattended presence acceptance. The reads, `authorizePlanning`, `submitPlanDraft`, `confirmPlan`, `approveBudget`, `stop`, and `recordTrialApproval` stay available to the phone.

When no connection service is mounted, or the call happens outside any `@Remote` request, there is no caller context and the call is treated as the host: this is the local direct-call and test semantics. It also means the facade alone never hardens a phone channel — the connection service must be mounted for the caller-origin refusal to apply.

The human-presence acknowledgement is never inferred: `runAttempt` refuses with `self-development/presence-unconfirmed` unless the request carries `presenceAcknowledged: true` literally, and a UI must never default, pre-select, or imply it.

`runAttempt`'s `dataHome` is marked `hostOnly` in the wire schema: the per-task data directory is assigned by the workspace service's `allocate` result, so the stable side forwards that `dataHome` as the runner's `dshHome`, and a phone request must omit the field. The wire layer collects every `hostOnly`-marked field from the schema metadata and checks the parsed request (`assertHostOnlyFields`), so a future host-only field is enforced by marking it with `.meta({ hostOnly: true })`, not by new refusal code.

<a id="phone-whitelist-mapping"></a>
## Phone whitelist mapping

The human-review confirmation card allows phone operations to watch progress, interject, confirm a plan and a budget, stop, and approve or reject a continuation. It does not allow launching a task or an attempt, upgrade approval, access to trial artifacts, or changes to isolation and credential settings.

| Phone capability | Facade method |
|---|---|
| 看进度 (watch progress) | `listTasks`, `getTask`, `activeTasks` |
| 插话 (interject) | `submitPlanDraft`, `authorizePlanning` |
| 确认计划与预算 (confirm plan and budget) | `confirmPlan`, `approveBudget` |
| 停止 (stop) | `stop` |
| 审批继续/驳回 (approve continuation or reject) | `recordTrialApproval` |
| 创建任务 (create a task) | Host only. `createTask` fixes `stableBaselineDigest` and `allowedModificationScope`; refused from a phone caller with `self-development/host-only-field`. |
| 设置启动档案 (set a launch profile) | Host only. `setLaunchProfile` and `createTask`'s third argument fix the launch isolation and confirmation settings; refused from a phone caller with `self-development/host-only-field`. |
| 发起试验 (launch an attempt) | Host only. `runAttempt` assigns the worktree, acceptance, and artifact isolation settings; refused from a phone caller with `self-development/host-only-field`. |
| 发起/查看/停止无人值守战役 (start, view, or stop an unattended campaign) | Host only in full, including the read. `startCampaign`, `campaign`, and `stopCampaign` are all refused from a phone caller with `self-development/host-only-field`. |
| 升级批准 (upgrade approval) | **Does not exist on this facade.** No method records an upgrade, release, or installation approval; the release table lives outside this package. |
| 访问试验版 (access the trial build) | Not exposed. The facade returns evidence paths from `runAttempt` outcomes only; no method reads experiment artifacts. |
| 修改隔离与凭据设置 (change isolation or credentials) | Not exposed. The facade's config carries no isolation or credential field, and no method mutates runner configuration. |
| 指定任务数据目录 (assign a per-task data directory) | Not accepted from the phone. `runAttempt`'s `dataHome` is host-only: the stable side passes the workspace `allocate` result's `dataHome`, and a non-host request that sets the field is refused. |

<a id="error-codes"></a>
## Error codes

`SelfDevelopmentRemoteError` is a real `RemoteError`, so every refusal keeps its machine-routable code across the Gateway; the code vocabulary below is merged into the shared `RemoteErrorDetailsMap` in `src/errors.ts`:

| Code | Meaning |
|---|---|
| `self-development/config-invalid` | The service config or a Remote argument fails its shape validation at the facade boundary; the same code refuses a stored launch profile or campaign record that is not valid JSON or misses a field, a `runAttempt` launch field that is neither explicit nor derivable, a `startCampaign` for a task with one already running or that would exceed `maxConcurrentCampaigns`, a `stopCampaign` with no campaign record, and an `approveBudget` with neither `mode` nor `preset` or a `durationMs` over the 24-hour cap. |
| `self-development/disabled` | The facade is not enabled; every method refuses. |
| `self-development/actor-forbidden` | The operation's actor is not in the configured allowlist. |
| `self-development/host-only-field` | A non-host caller invoked `runAttempt`, `createTask`, `setLaunchProfile`, `startCampaign`, `campaign`, or `stopCampaign`, or set a wire field marked `hostOnly` (today `runAttempt.dataHome` and every `launchProfile` field). |
| `self-development/presence-unconfirmed` | `runAttempt` did not receive `presenceAcknowledged: true`. |
| `self-development/runner-unavailable` | The attempt-related method, or `startCampaign`/`stopCampaign`, needs the supervised runner plugin, which is not loaded. |
| `self-development/task-unknown` | A read path addressed a task that has no journal directory. |

Core codes (`SELF_DEV_*` from the task-control package) and runner codes (`SELF_DEV_RUNNER_*`) are converted at the facade boundary into `self-development/core`, whose `details.code` carries the owning package's original code — including `SELF_DEV_JOURNAL_UNAVAILABLE`, which the caller must surface as handoff. Without the conversion the Gateway folds the rejection into `gateway/internal`, and a phone caller could not tell the reason.

<a id="further-exploration"></a>
## Further Exploration

- [Workflow subsystem](../../../docs/subsystems/workflow.md) — the workflow seam, the task-control service, and the supervised runner.
- [Workflow group README](../../README.md) — the opt-in self-development packages and their roles.

<a id="model-experience"></a>
## Model Experience

None, as this service registers no model-facing tool, prompt, or event, and ordinary chat messages cannot reach its methods.

#### KV Cache effect

The service adds no prompt prefix and no model-visible surface.

## Known Limitations and Deferred Work

- **`controlDirectory` is configured twice** — the facade repeats the task-control service's directory because that service keeps its resolved config private. A deployment that points the two fields at different directories gets an empty or failing task list rather than a load-time error; there is no cross-check.
- **The card carries no budget basis** — this increment has no similar-task history source, so `suggestedBudgetBasis` is always the literal `无依据`. A future history service replaces the constant.
- **Cost limits are always refused** — the facade knows no balance, so `costLimits` is always the literal `未知，不放行`. Nothing auto-proceeds on an unknown balance.
- **`listTasks` opens every task journal** — each row reads the task's full journal through the core service, so a control directory with many tasks pays a proportional read cost, and opening a task with an attempt left in flight by a previous process records the core's own interrupted-attempt recovery events.
- **No gateway-side rate limiting or audit trail** — the facade relies on the connection layer's authorization; it writes no audit log of who called which method beyond what the core journal records for forwarded operations.
- **Upgrade approval is out of scope by design** — the release-approval table is not implemented anywhere in this package; no facade method can be extended into an upgrade path without a new reviewed contract.
- **Unattended campaigns are not an isolation guarantee** — `unattended-accepted` records a one-time human acceptance, never continued presence, sandboxing, or quota enforcement; every limitation the runner's own README states (same-user execution, no process-group escape protection, no Windows or Linux clock source) applies identically to every round a campaign launches. A 24-hour, `noProgressAttemptLimit`-bounded budget is a time and round cap, not a safety boundary.
- **A campaign round takes no per-round overrides** — every launch field comes from the task's stored launch profile; a campaign cannot vary the worktree, artifact paths, acceptance path, loopback allowlist, or data directory between rounds. Changing them mid-campaign requires stopping it, calling `setLaunchProfile` again, and starting a new one.
- **Campaign finalization races are resolved, not prevented** — a `stopCampaign` racing the loop's own natural termination (a round passing, budget exhausting, or an unrecognized crash) never corrupts the record or double-reports an event, but which of two concurrent `stopCampaign` reasons is the one persisted is not deterministic from the caller's side.
- **The never-reached-the-core guard is an observation of the core's revision, not a property the runner or the acceptor prove** — the loop infers "this round never committed `attempt/started`" from the projection's revision being unchanged immediately after the round, read before and after; it never inspects the runner or the acceptor's own internal state, and it cannot distinguish "genuinely never started" from a hypothetical core bug that committed something without advancing the revision it reports. `roundDelayMs` waits only after a round the guard did *not* catch — one it independently confirmed reached the core — so it never delays the guard's own immediate termination.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
