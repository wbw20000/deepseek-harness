---
description: "Task workspace allocation and serialized integration for opt-in self-development: one git worktree, branch, and copied data home per task under an experiments root, a durable registry, and one-at-a-time fast-forward integration back to the project baseline. Coordination, not isolation."
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development-workspaces

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

Allocate one workspace per self-development task and integrate finished task branches back into the project baseline. For each task, the service creates one git worktree on a `selfdev/<taskId>` branch and one `DSH_HOME` copied from the deployment's template, records both in a durable registry, and releases exactly what it registered. Integration is strictly serial: one lock per experiments root, a rebase onto the current target tip when the baseline moved, an optional pre-fast-forward verify gate, and a fast-forward that never merges or forces a ref. Task-level isolation means separate directories, processes, and data homes — it is not an operating-system sandbox.

## Table of Contents

- [Service](#service)
- [Parallel boundary](#parallel-boundary)
- [Serialized integration](#serialized-integration)
- [On-disk layout](#on-disk-layout)
- [Error codes](#error-codes)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="service"></a>
## Service

`SelfDevelopmentWorkspaces` (default export, Cordis service `selfDevelopmentWorkspaces`) validates deployment configuration at construction and exposes four service methods on `ctx.selfDevelopmentWorkspaces`. It declares no injected dependencies and ships in no default bundle.

| Method | Contract |
|---|---|
| `allocate(req)` | Creates the workspace for `req.taskId`: `git worktree add -b selfdev/<taskId> <experimentsRoot>/<taskId>/worktree <baseCommit>` with `baseCommit` defaulting to the project's `HEAD`, plus a data home copied from `dataHomeTemplate` at `<experimentsRoot>/<taskId>/dsh-home`. When `setup` is configured, its command then runs once inside the fresh worktree, before the registry write; a non-zero exit or a timeout tears the worktree and data home back down, registers nothing, and throws `SELF_DEV_WORKSPACE_SETUP_FAILED`, and a clean exit stamps the registered record's `setupCompletedAt`. A repeated allocation for the same task id returns the already-registered record unchanged, whatever the new request's project root says, and never reruns setup. Once the configured maximum is allocated, further allocation is refused with `SELF_DEV_WORKSPACE_LIMIT` — never queued, because a task queued behind live worktrees would not run in parallel. Allocations and releases against one experiments root serialize in memory, so the limit check and the registry write are exact within one process. Every target path is proven to resolve inside the experiments root before anything is created, and the registry entry is written last, so a failed allocation leaves no half-built workspace behind. |
| `release(taskId)` | Removes the registered worktree with `git worktree remove --force`, deletes the data home, and drops the registry entry. Only registered paths are touched, and each is re-resolved through `realpath` immediately before removal: a registered path that now resolves outside the experiments root is refused, a worktree directory that already vanished is pruned from git's registration, and a missing data home is already gone. Unregistered files beside the registered paths survive. |
| `list()` | Returns the currently registered workspaces from the durable registry; later changes are not reflected in a returned snapshot. |
| `integrate(req)` | Integrates `req.taskId`'s worktree into `req.targetBranch` under the serialized-integration contract below. Git failures inside the integration are returned as a `failed` result with the reason, never thrown; an unallocated task id throws `SELF_DEV_WORKSPACE_TASK_UNKNOWN`. Calls on one service instance serialize in memory; calls across processes serialize on the experiments root's integration lock. An optional `req.verify(worktree)` gate runs once, after a rebase (when one was needed) and before the fast-forward, whether or not the baseline had moved; a rejection or a thrown error both report `{ status: 'verification-failed', reason, baseMoved }` and leave the target branch untouched. |

| Config field | Meaning |
|---|---|
| `experimentsRoot` | Absolute parent directory of every task worktree, data home, and the service's registry and lock files. |
| `dataHomeTemplate` | Absolute template directory copied into each task's `DSH_HOME`; `sessions/` and `attachments/` subtrees and every `*.lock` file are excluded from the copy. |
| `maxConcurrentTasks` | Maximum workspaces allocated at once; the schema default is 2. |
| `setup` | Optional `{ command, timeoutMs }` run once inside every newly created worktree, before it is registered; absent — the default — skips setup entirely. For a task worktree of this harness's own repository, whose `git worktree add` carries no `node_modules`, a typical value is `{ command: ["pnpm", "install", "--offline", "--frozen-lockfile"], timeoutMs: 300000 }`. |

A relative path, a `maxConcurrentTasks` that is not a positive finite integer, an empty `setup.command`, or a `setup.timeoutMs` that is not a positive finite integer, throw `SelfDevelopmentWorkspacesError` with `SELF_DEV_WORKSPACE_CONFIG_INVALID` at construction. Task ids must match a plain dot-and-dash word without `..` or a `.lock` suffix; anything else throws `SELF_DEV_WORKSPACE_TASK_INVALID` before a branch or directory is named. This configuration check does not establish filesystem isolation or protect directories from other processes running as the same user.

No runtime invariant companion is published: the package exposes no runtime observation stream of its own, the registry-versus-filesystem and lock-versus-pid relationships it owns are covered by focused behavior tests against real git repositories, and a registry that drifted from the filesystem is refused to a human during release rather than reconciled by an in-process check.

<a id="parallel-boundary"></a>
## Parallel boundary

Two allocated tasks get two independent worktrees, two independent `DSH_HOME` directories, and — through the [runner](../workflow-self-development-runner/README.md), which launches one headless process per attempt inside the worktree — two independent processes. A file a task writes in its worktree or data home is invisible to the other task. That is the whole isolation claim: directory, process, and data-directory separation for concurrent tasks on one host, not a sandbox. Children keep the operating user's permissions and can reach anything that user can reach.

When the deployment routes every task through one single-channel local inference endpoint (for example one LM Studio server), concurrent tasks share that endpoint and their model requests queue inside it; these workspaces do not create inference parallelism, per the development plan's cross-design rule 7. Consistent with that, over-limit allocation is refused outright instead of queued: a task waiting behind live worktrees would not execute in parallel, and pretending otherwise would misreport the parallelism the deployment actually has.

<a id="serialized-integration"></a>
## Serialized integration

One integration runs at a time per experiments root, guarded by `<experimentsRoot>/integration.lock`, which records the holding pid; a lock whose pid no longer names a live process is stale and is removed by the next acquirer — but only while the file still holds the content that was judged stale, so a lock a racing acquirer rewrote is waited for, not deleted — and a live holder is waited for up to one minute before the attempt is refused with `SELF_DEV_WORKSPACE_INTEGRATION_BUSY`. While holding the lock, the integration:

1. Resolves the target tip: the branch's configured upstream is fetched and its remote-tracking ref is used when present; otherwise the local branch is the baseline authority.
2. When the target tip differs from the allocation's `baseCommit` (`baseMoved`), rebases the task branch onto the target tip in the worktree. A conflict aborts the rebase and returns `{ status: 'conflict', files, baseMoved: true }` — the task needs re-development and re-verification against the moved baseline. Any other rebase failure is aborted too and reported as `failed`.
3. When the request carries a `verify(worktree)` gate, runs it once against the worktree — the rebased worktree when step 2 ran, unchanged otherwise — whether or not `baseMoved`. A rejection (`{ ok: false, reason }`) or a thrown error (its string form becomes `reason`) both return `{ status: 'verification-failed', reason, baseMoved }` without fast-forwarding: the target branch stays untouched, and a completed rebase's result stays in the worktree for a follow-up fix.
4. Fast-forwards the target branch to the worktree HEAD, which now contains the target tip: `merge --ff-only` when the project root holds the branch checked out, a compare-and-swap `update-ref` when the branch is checked out nowhere, and a refusal when another worktree holds it. No merge commit is ever created and no ref is ever forced; a non-ancestor move fails the integration. A successful `integrated` result always carries `baseMoved`, so a caller can tell an unchanged-baseline fast-forward from one that first rebased.

Every step leaves no half state: a started rebase is aborted before the result is returned, and the lock is released when the integration settles, whatever the outcome — including a `verification-failed` outcome. Rebase rewrites the task's commits, so a rebased task branch carries its changes under new commit ids.

<a id="on-disk-layout"></a>
## On-disk layout

```
<experimentsRoot>/
  workspaces.json
  integration.lock
  <taskId>/worktree
  <taskId>/dsh-home
```

The registry is the single authority for what this service may delete. Every write publishes through an exclusive temporary file and an atomic rename, so an interrupted write never leaves a readable half-published registry; a registry that does not match the expected structure fails loudly with `SELF_DEV_WORKSPACE_REGISTRY_INVALID` instead of being silently repaired.

<a id="error-codes"></a>
## Error codes

| Code | Thrown when |
|---|---|
| `SELF_DEV_WORKSPACE_CONFIG_INVALID` | A path config field is missing, empty, or relative, `maxConcurrentTasks` is not a positive finite integer, `setup.command` is empty, or `setup.timeoutMs` is not a positive finite integer. |
| `SELF_DEV_WORKSPACE_TASK_INVALID` | A task id cannot safely name a branch and directory. |
| `SELF_DEV_WORKSPACE_LIMIT` | The configured workspace maximum is already allocated. |
| `SELF_DEV_WORKSPACE_TASK_UNKNOWN` | `release` or `integrate` names a task with no registered workspace. |
| `SELF_DEV_WORKSPACE_ALLOC_FAILED` | The project root, baseline, template, worktree creation, or data-home copy fails. |
| `SELF_DEV_WORKSPACE_SETUP_FAILED` | The configured `setup` command is empty, cannot spawn, exits non-zero, or does not finish within `timeoutMs`; the worktree and data home are torn down first. |
| `SELF_DEV_WORKSPACE_RELEASE_FAILED` | A registered path resolves outside the experiments root, or git cannot remove the worktree. |
| `SELF_DEV_WORKSPACE_REGISTRY_INVALID` | The registry file cannot be read, parsed, or written. |
| `SELF_DEV_WORKSPACE_GIT_FAILED` | A git invocation cannot spawn, exits non-zero, or times out. |
| `SELF_DEV_WORKSPACE_INTEGRATION_BUSY` | A live integration-lock holder does not release within the wait bound. |

<a id="further-exploration"></a>
## Further Exploration

Read the plan section that owns the task-workspace split, the runner package these workspaces are allocated for, and the subsystem page that places this package among its workflow siblings.

- [Workflow subsystem](../../../docs/subsystems/workflow.md) — the workflow seam and the other packages in the group.
- [Supervised runner](../workflow-self-development-runner/README.md) — the attempt executor that runs inside an allocated worktree with the task's data home.
- [Task control](../workflow-self-development/README.md) — the per-task lifecycle whose attempts these workspaces host.

<a id="model-experience"></a>
## Model Experience

None, as this service allocates directories, git worktrees, and registry files and registers no model-facing tool, prompt, or event.

#### KV Cache effect

The service adds no prompt prefix. Model requests for a task are launched by the runner against that task's worktree and data home; cache reuse follows the Agent's profile and provider, not this service.

## Known Limitations and Deferred Work

- **Directory isolation is not a sandbox** — separate worktrees, data homes, and processes are not confinement. Children retain the operating user's permissions; a task can read and write anything that user can, including other tasks' worktrees and the registry. Path checks resolve through `realpath` when they run and do not close symlink races against a concurrent same-user writer.
- **One writer per experiments root across processes** — `allocate` and `release` calls against one experiments root serialize on an in-process chain, so the concurrency limit and the registry read-modify-write are exact within one process. Across processes nothing serializes the registry: it stays last-writer-wins, and two processes allocating against one experiments root can race it — the loser's worktree exists on disk but is registered nowhere, so `release` will not find it. Deployments should mount one service instance per experiments root.
- **In-process serialization has no busy bound** — a call queued on a serial chain waits as long as the work ahead of it takes, with no timeout and no `SELF_DEV_WORKSPACE_INTEGRATION_BUSY` refusal: a hung `allocate`, `release`, or `integrate` callback keeps every later call on that experiments root waiting indefinitely. Only the cross-process integration lock has a wait bound (one minute by default).
- **The integration lock trusts recorded pids on one host** — a stale lock is judged by pid liveness, so pid reuse can delay a takeover, and the wait bound (one minute by default) is wall-clock based; a hung live holder is refused, never preempted. The lock protects integrations only; it does not protect the registry file, whose writers stay single across processes by deployment convention.
- **Fast-forwarding a checked-out branch updates its working tree** — when the project root holds the target branch checked out, `merge --ff-only` rewrites the project's working tree to the integrated content. Callers integrate against a project baseline they own.
- **Rebase rewrites history and conflicts are terminal here** — a conflicting task returns a `conflict` result and keeps its own branch; the service performs no automatic retry, no re-development, and no re-verification. A human or the owning orchestrator decides what happens next.
- **Idempotent allocation returns the first record** — a repeated `allocate` for a live task returns the already-registered workspace unchanged, even if the new request names a different project root; correcting a mis-allocated project root means releasing first.
- **The verify gate is caller-supplied and unsandboxed** — `req.verify` runs in this process with this process's permissions against a real worktree; this package neither times it out nor isolates it. A gate that hangs holds the integration lock for as long as the caller's own wait bound allows (unbounded for the in-process chain; one minute by default for the cross-process lock). A rejection or a thrown error both stop the integration in the same way, so a gate that wants a distinct diagnostic must fold it into `reason` itself.
- **The setup command runs with the operating user's own permissions, unsandboxed** — `setup.command` spawns detached inside the fresh worktree with that same-user's identity and only `PATH`/`HOME` in its environment; it can still read and write anything that user can reach, including other tasks' worktrees and data homes. A non-zero exit or an unmet `timeoutMs` kills the command's whole POSIX process group (not just its direct child) and tears the allocation down; a clean exit leaves any group members the command itself left running untouched. Windows has no POSIX process groups, so a configured `setup` throws `SELF_DEV_WORKSPACE_SETUP_FAILED` there before spawning anything.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
