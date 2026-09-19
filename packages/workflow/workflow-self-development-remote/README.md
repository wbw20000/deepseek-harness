---
description: "Stable-side Remote facade over self-development: read-only progress views, the human confirmation card, and explicit UI/phone operations for planning, budget, stopping, and trial approval. Disabled until enabled; no upgrade approval exists here."
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development-remote

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

Expose the self-development task-control service and the supervised runner as one stable typed Remote surface for the M4 UI and the phone whitelist. The facade owns no state and makes no decision: reads return the task projection and a read-only confirmation card, writes forward to the core controller with a facade-generated operation id, and attempts launch only through the runner with an explicit human-presence acknowledgement. Every method refuses until the deployment sets `enabled: true`, and the service ships in no default bundle: a profile must list the plugin explicitly, after which the Typert gateway mounts it as the `selfDevelopmentRemote` namespace.

## Table of Contents

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
## Service

`SelfDevelopmentRemote` (default export, Cordis service `selfDevelopmentRemote`, wire namespace `selfDevelopmentRemote`) injects the task-control service and resolves the supervised runner optionally: every attempt-related method refuses with `SELF_DEV_REMOTE_RUNNER_UNAVAILABLE` when the runner plugin is not loaded, while the read paths and the stop fallback work against the task-control service alone.

| Config field | Meaning |
|---|---|
| `enabled` | Master switch. Defaults to `false`; every method returns `SELF_DEV_REMOTE_DISABLED` while it is `false`. |
| `allowedActors` | Actor allowlist. Empty (the default) means no restriction; non-empty requires the operation's actor field to appear in the list. |
| `controlDirectory` | The task-control service's control directory. The facade reads it only to list task journals and never writes under it. |

`controlDirectory` repeats the task-control service's value because that service keeps its resolved configuration private and this package may not modify it. The facade validates the path at construction and fails loudly on a relative value.


No runtime invariant companion is published: the facade exposes no runtime observation stream of its own, the relationships it forwards between the card view, the projection, and the core journal are covered by focused behavior tests, and the one deployment coupling it cannot verify itself — that its `controlDirectory` matches the task-control service's — is documented as a limitation instead of asserted.

<a id="methods"></a>
## Methods

Every method below is a `@Remote` method. Ordinary chat messages never reach them: a caller must invoke the endpoint explicitly through the Typert gateway, and the connection layer's own authorization applies before the facade runs.

| Method | Forwarding | Contract |
|---|---|---|
| `listTasks()` | read-only | Scans `<controlDirectory>/tasks/*` and returns one row per task: `taskId`, `status`, `revision`, and `title` (the first 80 characters of the requirement). Returns `[]` before the first task exists; journal directories are never created by this read. |
| `getTask(taskId)` | read-only | Returns the task's `TaskProjection` plus `card`, the read-only confirmation-card view described below. Refuses with `SELF_DEV_REMOTE_TASK_UNKNOWN` when the task has no journal yet. |
| `createTask(spec, expectedRevision)` | `createTask` | Creates the task from the TaskSpec wire form. The actor is `spec.createdBy`. Returns the facade-generated `operationId`. |
| `authorizePlanning(taskId, expectedRevision, authorizedBy)` | `authorizePlanning` | Grants the separate planning authorization; it never approves development and consumes no round. |
| `submitPlanDraft(taskId, expectedRevision, draft)` | `submitPlanDraft` | Submits a drafted plan for human confirmation. |
| `confirmPlan(taskId, expectedRevision, plan, actor)` | `confirmPlan` | Freezes the human-confirmed plan. The actor is the explicit `actor` argument. |
| `approveBudget(taskId, expectedRevision, approval)` | `approveBudget` | Records or replaces the human budget approval. The actor is `approval.approvedBy`; consumed rounds and time never reset. |
| `stop(taskId, expectedRevision, reason?)` | runner `stop`, else core `stop` | Stops the task. With the runner loaded, owned process groups and evidence writes finish before the result returns; without it, only the core stop runs. |
| `recordTrialApproval(taskId, expectedRevision, approvedBy)` | `recordTrialApproval` | Records the human trial approval bound to the current verified result. The actor is `approvedBy`. |
| `runAttempt(request)` | runner `runAttempt` | Launches one supervised attempt. The facade assembles the `PresenceConfirmation`: `confirmedAt` is one trusted-clock observation taken now, `taskId`, `testPlanDigest` from the frozen plan, `acceptanceDefinitionDigest` from the definition's bytes, `artifactPaths` deduplicated and sorted ascending, and the fixed acknowledgement `supervised-not-unattended`. Requires `presenceAcknowledged: true` explicitly. Returns the runner's outcome plus the `operationId`. |
| `activeTasks()` | runner `activeTasks` | Returns the task ids of the attempts the runner currently owns; `[]` without the runner. |

Every mutating method generates its `operationId` with `randomUUID()` and returns it to the caller; a retry that wants the core's replay semantics must send that id back. All arguments are validated at the facade before the core or runner sees them, and every core or runner rejection propagates verbatim with the owning package's machine-routable code.

<a id="permission-model"></a>
## Permission model

The facade adds exactly two deployment-owned gates on top of the connection layer's authorization:

- **`enabled`** — `false` refuses every method with `SELF_DEV_REMOTE_DISABLED`, so mounting the plugin alone enables nothing.
- **`allowedActors`** — empty means unrestricted; non-empty gates the actor-carrying operations: `createTask` (`spec.createdBy`), `confirmPlan` (the `actor` argument), `approveBudget` (`approval.approvedBy`), `recordTrialApproval` (`approvedBy`), and `runAttempt` (`confirmedBy`). Progress reads, planning authorization, drafting, and stopping stay open to any caller, because watching progress, interjecting, and stopping are the lower-risk operations the phone whitelist exists for.

The human-presence acknowledgement is never inferred: `runAttempt` refuses with `SELF_DEV_REMOTE_PRESENCE_UNCONFIRMED` unless the request carries `presenceAcknowledged: true` literally, and a UI must never default, pre-select, or imply it.

<a id="phone-whitelist-mapping"></a>
## Phone whitelist mapping

The human-review confirmation card allows phone operations to watch progress, interject, confirm a plan and a budget, stop, and approve or reject a continuation. It does not allow upgrade approval, access to trial artifacts, or changes to isolation and credential settings.

| Phone capability | Facade method |
|---|---|
| 看进度 (watch progress) | `listTasks`, `getTask`, `activeTasks` |
| 插话 (interject) | `submitPlanDraft`, `authorizePlanning` |
| 确认计划与预算 (confirm plan and budget) | `confirmPlan`, `approveBudget` |
| 停止 (stop) | `stop` |
| 审批继续/驳回 (approve continuation or reject) | `runAttempt`, `recordTrialApproval` |
| 升级批准 (upgrade approval) | **Does not exist on this facade.** No method records an upgrade, release, or installation approval; the release table lives outside this package. |
| 访问试验版 (access the trial build) | Not exposed. The facade returns evidence paths from `runAttempt` outcomes only; no method reads experiment artifacts. |
| 修改隔离与凭据设置 (change isolation or credentials) | Not exposed. The facade's config carries no isolation or credential field, and no method mutates runner configuration. |

<a id="error-codes"></a>
## Error codes

`SelfDevelopmentRemoteError` carries one of these machine-routable codes; core and runner errors are never wrapped:

| Code | Meaning |
|---|---|
| `SELF_DEV_REMOTE_CONFIG_INVALID` | The service config or a Remote argument fails its shape validation at the facade boundary. |
| `SELF_DEV_REMOTE_DISABLED` | The facade is not enabled; every method refuses. |
| `SELF_DEV_REMOTE_ACTOR_FORBIDDEN` | The operation's actor is not in the configured allowlist. |
| `SELF_DEV_REMOTE_PRESENCE_UNCONFIRMED` | `runAttempt` did not receive `presenceAcknowledged: true`. |
| `SELF_DEV_REMOTE_RUNNER_UNAVAILABLE` | The attempt-related method needs the supervised runner plugin, which is not loaded. |
| `SELF_DEV_REMOTE_TASK_UNKNOWN` | A read path addressed a task that has no journal directory. |

Core codes (`SELF_DEV_*` from the task-control package) and runner codes (`SELF_DEV_RUNNER_*`) pass through verbatim, including `SELF_DEV_JOURNAL_UNAVAILABLE`, which the caller must surface as handoff.

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

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
