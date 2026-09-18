---
description: "Supervised self-development attempt execution: trusted clock, human-presence evidence, operation-bound launch records, headless execution, independent acceptance, durable evidence, and controller-owned stopping. Supervised mode, not unattended."
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development-runner

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

Run one supervised self-development attempt end to end. The service composes the trusted clock, human-presence evidence, the operation-bound launch record, the headless executor, and the independent acceptor, publishes durable attempt evidence beside its terminal outcome, and stops through the task controller. Every launch requires a recorded human confirmation and a finite budget. This is a supervised mode with recorded limits, not unattended operation: nothing here provides operating-system isolation or upgrades an installation.

## Table of Contents

- [Service](#service)
- [Trusted clock](#trusted-clock)
- [Human-presence evidence](#human-presence-evidence)
- [Attempt budget](#attempt-budget)
- [Launch binding and the launch record](#launch-binding-and-the-launch-record)
- [Execution and acceptance](#execution-and-acceptance)
- [Attempt evidence](#attempt-evidence)
- [Attempt orchestration](#attempt-orchestration)
- [Error codes](#error-codes)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="service"></a>
## Service

`SelfDevelopmentRunner` (default export, Cordis service `selfDevelopmentRunner`) validates deployment configuration at construction. It ships in no default bundle and exposes no service method that launches a task; launching goes through the exported `runSupervisedAttempt`, which the caller points at a `SelfDevelopmentTaskController` from the core task-control package and at the human confirmation captured for that launch.

| Config field | Meaning |
|---|---|
| `nodeBinary` | Absolute path of the `node` binary the executor and acceptance commands run under. |
| `dshBin` | Absolute path of the harness CLI entry (`apps/cli/lib/bin.js`) the executor spawns. |
| `dshHome` | Absolute path of the experiment Agent's `DSH_HOME`; never the operating user's `~/.dsh`. |
| `experimentsRoot` | Absolute parent directory of every experiment worktree. |
| `evidenceRoot` | Absolute stable-side evidence directory; must live outside `experimentsRoot`. |
| `killGraceMs` | Milliseconds before `SIGKILL` escalation, and the separate maximum wait to confirm final group exit. |

Every field is required. A relative path, an `evidenceRoot` lexically inside `experimentsRoot`, or a `killGraceMs` that is not a positive finite integer throws `SelfDevelopmentRunnerError` with `SELF_DEV_RUNNER_CONFIG_INVALID` at construction. This configuration check does not establish filesystem isolation or protect directories from other processes running as the same user.

No runtime invariant companion is published: the package exposes no runtime observation stream of its own, the relationships it owns between the launch record, the attempt evidence, and the core result are covered by focused behavior tests, and drift between the evidence directory and the control directory is refused to a human rather than reconciled by an in-process check.

<a id="trusted-clock"></a>
## Trusted clock

[`clock.ts`](src/clock.ts) exports `HostClock`, which derives `bootId` from `sysctl kern.boottime` and computes `monotonicMs` as the wall-clock difference from boot time. Despite the field name, this is not a guaranteed monotonic clock. A changed boot identifier is judged `uncertain` by the core task-control package. Each attempt request carries its own clock; this helper is not a substitute for a verified supervisor clock.

<a id="human-presence-evidence"></a>
## Human-presence evidence

[`presence.ts`](src/presence.ts) turns one concrete confirmation into capability evidence for the core `startAttempt` contract. The confirmation records who confirmed, when (one trusted-clock observation), which experiment worktree the attempt runs in, which loopback ports the session may bind, and the literal acknowledgement `supervised-not-unattended`. It also binds the launch facts the person reviewed: the task id, the frozen test-plan digest, the acceptance-definition digest, and the artifact path set, so a confirmation given for one launch cannot be replayed against different content.

`HumanPresenceCapabilitySource` produces one evidence item per required capability, each digest bound to that confirmation, and the core records the attempt as human-supervised. The source records an acknowledgement; it does not detect continued human presence or enforce the recorded loopback allowlist.

<a id="attempt-budget"></a>
## Attempt budget

[`budget.ts`](src/budget.ts) derives one attempt's finite bounds from the human-approved budget minus the time the task already consumed. A missing approval, a budget that bounds neither a phase nor the total, or a total that is already spent throws `SELF_DEV_RUNNER_BUDGET_INVALID` before anything launches. Each phase runs under its own in-run deadline: the development phase gets the smaller of the approved phase bound and the remaining total, and the acceptance phase gets what is left after development. Whichever limit reaches zero first cancels the run. A deadline aborts an internal `AbortSignal` at its limit; an external cancellation aborts it without reporting a timeout. A deadline ends the run's observation; it is not child-process supervision for a process that escaped its group.

<a id="launch-binding-and-the-launch-record"></a>
## Launch binding and the launch record

[`binding.ts`](src/binding.ts) refuses a launch whose confirmation does not bind the real launch facts: the task id, the worktree's filesystem realpath (which must resolve inside the experiments root and carry a `.git` entry), the frozen plan digest, the acceptance-definition digest, and the artifact path set.

[`launch-record.ts`](src/launch-record.ts) writes the operation-bound launch record to `<evidenceRoot>/tasks/<taskId>/launches/<operationId>.json`, exactly once per operation, with the digests computed at launch: worktree realpath, artifact paths, acceptance path and digest, test-plan digest, source and artifact digests, the derived budget, and the human confirmation. A retry with the same operation id reads the record back instead of recomputing its launch inputs; the record's content facts are compared exactly, and any divergence throws `SELF_DEV_RUNNER_LAUNCH_MISMATCH`, refusing the launch to a human. The record's `expectedRevision` records which revision the launch expected and is deliberately not compared: a retry after a failed attempt necessarily arrives at a higher revision, and the core's own replay check binds the retried operation.

<a id="execution-and-acceptance"></a>
## Execution and acceptance

The [executor](src/executor.ts) starts the configured CLI through the headless profile with the experiment directory as its working directory. The [acceptor](src/acceptor.ts) loads a separate definition and checks command outcomes and file assertions. Both use POSIX process groups for cancellation. The presence source above records an acknowledgement; it does not detect continued human presence or enforce the recorded loopback allowlist.

Acceptance definitions must reside outside the experiments root. This placement reduces accidental modification but does not make them immutable to a same-user process. The caller must protect its control files and approved inputs independently. Only a completed integration with the task controller can associate these helper results with a task's budget, frozen plan, and manual trial.

The executor stops on stdout overflow rather than accepting a truncated success. Acceptance output overflow fails every assertion. Both helpers drain the direct child's pipes, kill remaining members of its process group, and wait for the group to disappear before returning. An unconfirmed exit rejects the run, including when an unreaped process remains visible. Acceptance paths and artifact ancestors are checked through the filesystem; artifact symlinks contribute their link text without reading their targets. These checks do not prevent a concurrent same-user writer from replacing files between observations.

<a id="attempt-evidence"></a>
## Attempt evidence

[`evidence.ts`](src/evidence.ts) publishes one attempt's durable record under `<evidenceRoot>/tasks/<taskId>/attempts/<attemptId>.json` and the terminal decision beside it as `<attemptId>.outcome.json`. The evidence records the launch digests, digest A taken after the development phase, digest B taken after acceptance (or `undefined` when acceptance never ran), whether the two are equal, the observed executor and acceptance facts, the phase runs, and the structured result. The outcome records the terminal decision — `passed`, `failed`, `cancelled`, `late`, or `unknown` — the committed revision, and the structured failure.

Evidence without an outcome file is a diagnostic record only: it never asserts that the core log passed. Writes go through [`durable-json.ts`](src/durable-json.ts): an exclusive temporary file, fsync, atomic rename, and directory sync, so an interrupted write never leaves a readable half-published file. Rewriting identical bytes is `unchanged`; a path that already holds different bytes throws `SELF_DEV_RUNNER_EVIDENCE_CONFLICT`.

<a id="attempt-orchestration"></a>
## Attempt orchestration

[`attempt.ts`](src/attempt.ts) runs one supervised attempt in a fixed order: judge the task state and revision, bind the confirmation to the resolved worktree, plan digest, acceptance definition, and artifact set, write or verify the launch record, then let the core commit `attempt/started` before any process starts. The side effect then runs develop, takes digest A, runs acceptance under its own deadline, takes digest B, compares A and B (an unequal comparison fails the run), writes the durable evidence, and returns the result for the core to verify and commit. A core replay never starts a second executor: a replaying operation returns the recorded outcome without executing anything. An evidence write failure fails the round; a failed outcome write is recorded best-effort and never masks the core's own decision.

The service registers no `stop` and no dispose of its own. `stop` is a core controller operation: it commits durably while an attempt is pending and aborts that attempt's cancellation handle so the side effect can quiesce, because the side effect runs outside the controller's serialized section; settlement re-enters it, and a cancelled attempt can only settle as a cancelled failure. Unloading waits for the same wrap-up: the executor and acceptor drain pipes, kill remaining group members, and wait for group exit before returning. `SELF_DEV_RUNNER_ATTEMPT_ACTIVE` is declared at this boundary for a concurrent-attempt rejection; no current code path throws it.

<a id="error-codes"></a>
## Error codes

`SelfDevelopmentRunnerError` carries one of these machine-routable codes (see [`runtime.ts`](src/runtime.ts)):

| Code | Meaning |
|---|---|
| `SELF_DEV_RUNNER_CONFIG_INVALID` | The service configuration or a human-presence confirmation fails its shape validation at the config boundary. |
| `SELF_DEV_RUNNER_WORKTREE_INVALID` | The worktree does not resolve inside the experiments root, lacks a `.git` entry, or cannot be digested. |
| `SELF_DEV_RUNNER_CLOCK_UNAVAILABLE` | `sysctl kern.boottime` cannot be started, read, or parsed into a boot record. |
| `SELF_DEV_RUNNER_ACCEPTANCE_INVALID` | The acceptance definition is unusable, misplaced, or does not cover the frozen plan's required cases. |
| `SELF_DEV_RUNNER_EXECUTOR_FAILED` | The headless executor could not spawn its child or could not confirm the process group's exit. |
| `SELF_DEV_RUNNER_EVIDENCE_FAILED` | A durable write of a launch record, evidence file, or outcome file failed. |
| `SELF_DEV_RUNNER_EVIDENCE_CONFLICT` | The target path already holds different bytes than the record, evidence, or outcome being written. |
| `SELF_DEV_RUNNER_EVIDENCE_INVALID` | A launch record, evidence file, or outcome file fails its field or path validation, or an evidence root or id is malformed. |
| `SELF_DEV_RUNNER_PRESENCE_MISMATCH` | The human confirmation does not bind the launch's real facts. |
| `SELF_DEV_RUNNER_BUDGET_INVALID` | The approved budget is missing, malformed, bounds nothing, or its total is already spent. |
| `SELF_DEV_RUNNER_LAUNCH_MISMATCH` | An existing launch record does not match the content or paths of the launch being retried. |
| `SELF_DEV_RUNNER_ATTEMPT_ACTIVE` | Reserved for a concurrent-attempt rejection at this boundary; no current code path throws it. |

<a id="further-exploration"></a>
## Further Exploration

Read the decision record that owns the orchestration choices, the subsystem page that places this package among its workflow siblings, and the note that owns the helpers' fail-closed limits.

- [Supervised attempt orchestration](../../../.agents/notes/implemented/feature/2026-09-18-supervised-attempt-orchestration.md) — per-attempt evidence and clock, the operation-bound launch record, and the A/B digest comparison.
- [Workflow subsystem](../../../docs/subsystems/workflow.md) — the workflow seam and the other packages in the group.
- [Supervised helper limits](../../../.agents/notes/implemented/bug-fix/2026-09-18-supervised-runner-fail-closed.md) — failure handling and the limits of local checks.

<a id="model-experience"></a>
## Model Experience

None, as this service registers no model-facing tool, prompt, or event. Calling the executor explicitly passes the caller's task to a separate headless Agent.

#### KV Cache effect

The service adds no prompt prefix. Cache reuse inside the separately launched Agent follows its configured profile and provider.

## Known Limitations and Deferred Work

- **Wall-clock sensitivity** — `HostClock.monotonicMs` derives from `Date.now()`, so a wall-clock adjustment can invalidate duration measurements. A JavaScript timer is not an independent supervisor across process failure or host sleep.
- **No automatic attempt loop** — the service does not repeat failed attempts and provides no unattended execution or upgrade path. A retry is a caller-issued operation with its own idempotency key; the launch record replays it or refuses it to a human.
- **Same-user execution** — working-directory selection and a restricted environment are not a sandbox. Children retain the operating-system user's permissions; the supplied experiment home may contain credentials. Acceptance commands also run without an outer sandbox.
- **Process-group identity and escape** — a descendant that leaves the group, for example with `setsid`, can escape group cancellation. A numeric group id can also be reused after exit; signalling does not pin an OS-owned process identity. Execution helpers reject Windows before spawning; they do not implement a Windows process supervisor.
- **macOS-only clock source** — `readBootTimeSysctl` shells out to `sysctl kern.boottime`, which does not exist on Linux or Windows; there is no fallback clock.
- **Supervision is not isolation** — working-directory selection, the environment allowlist, workspace-write, and path checks are not an outer operating-system sandbox. A child of the same user may reach the real home, experiment credentials, the control directory, and other processes. A human confirmation does not automatically create quotas, isolation, or real presence detection. Node wall-clock drift and JavaScript timers cannot replace an independent supervisor's clock, sleep accounting, and crash cleanup. The current stage provides supervised testing with recorded limits only and must not be read as clearance for unattended operation.
- **Budget deadlines end observation, not escaped processes** — phase deadlines and cancellation act through POSIX process groups, which cannot constrain a descendant that escapes with `setsid`; a limit firing tears down the group's members and records the timeout, but does not stop a process that left the group.
- **Symlink races between check and use** — worktree containment, acceptance placement, and artifact path checks resolve paths when they run; a concurrent same-user writer can replace a path component with a symlink between the check and the use, and these checks do not close that gap.
- **Evidence and control directories share the operating user** — the evidence root and the task-control directory are ordinary directories owned by the same user as the attempt; nothing here stops a same-user process, including the experiment, from rewriting evidence, launch records, or outcomes.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
