---
description: "Opt-in self-development task-control foundation: versioned task specs, frozen test plans, human budget approvals, verified attempt results, and a durable JSONL task journal."
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development

English | [中文](README.zh.md)

## Summary

Record a development requirement, confirm its test plan, and approve a finite budget before an attempt starts. Keep consumed rounds and time across restarts, reject incomplete or mismatched results, and record human trial approval separately from test success. Integrators must supply trusted execution and verification services; this package has no human interface, production worker, or upgrade action.

## Table of Contents

- [Service](#service)
- [Controller operations](#controller-operations)
- [Verification and budget rules](#verification-and-budget-rules)
- [Journal](#journal)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="service"></a>
## Service

`SelfDevelopmentTasks` (default export, Cordis service `selfDevelopmentTasks`) owns one configured private control directory and caches one `SelfDevelopmentTaskController` per task. It is opt-in: it ships in no default bundle and registers no tool, prompt, event, or daemon.

| Config field | Meaning |
|---|---|
| `controlDirectory` | Private directory the service owns; task journals live in `<controlDirectory>/tasks/<taskId>/`. |
| `maxRecordsPerSegment` | Journal records per segment file before rotation. |
| `checkpointInterval` | Committed records between protected checkpoint rewrites. |

Every field is required: a deployment that has not measured its bounds configures nothing and the plugin fails at load instead of guessing. The service validates the configuration at construction — `controlDirectory` must be an absolute path and both bounds must be positive finite integers (`SELF_DEV_CONFIG_INVALID`) — and validates every `taskId` against a plain path-component grammar before it joins the control path or creates a directory.

`open(taskId, clock, capabilitySource?)` takes the trusted clock and the capability-evidence source explicitly per call. There is no default clock: a Node clock cannot prove macOS sleep or reboot accounting, so the caller supplies the observation source (the future Swift supervisor). Without a `capabilitySource`, every attempt launch is rejected with `SELF_DEV_CAPABILITY_MISSING`; there is no configuration that flips isolation on.

<a id="controller-operations"></a>
## Controller operations

<details>
<summary>Trusted-host operations and cancellation — click to expand</summary>

Every mutating call carries `{ taskId, expectedRevision, operationId }`. The controller serializes overlapping calls, so two callers with the same expected revision cannot both commit (compare-and-set). The idempotency digest covers the controller method plus an explicit execution payload; the same operation id with the same payload replays its recorded outcome (`replayed: true`, including after a reopen — a replay never masquerades as a fresh success), and the same id with a different payload, a different method, or a different execution payload is rejected (`SELF_DEV_OPERATION_PAYLOAD_MISMATCH`). A stale `expectedRevision` is rejected (`SELF_DEV_REVISION_CONFLICT`). The side-effect callback and cancellation signal are never part of the digest: they are process-local execution instructions, not durable replay content.

Every state transition is folded and validated before anything is appended, so a rejected operation leaves the journal byte-for-byte unchanged. If a journal append or fsync fails, the durable outcome is ambiguous: the controller instance latches the refusal, rejects every further operation with `SELF_DEV_JOURNAL_UNAVAILABLE`, and the task requires human handoff. The controller never continues after an ambiguous durable outcome.

- `createTask` stores a parsed, versioned `TaskSpec`.
- `authorizePlanning` grants the separate planning authorization. It never approves development and consumes no rounds; ordinary chat produces no approval.
- `submitPlanDraft` / `confirmPlan` freeze a `FrozenTestPlan` whose digest binds budget approvals, attempts, results, and trial approvals. The fold validates that the confirmed plan repeats the human-visible draft's required cases and manual cases exactly — matching only the version is rejected.
- `approveBudget` records a human `BudgetApproval`. A rounds-and-time pair is required by mode, a rounds-only budget must carry finite phase and per-attempt step bounds, a time-only budget must carry a no-progress bound. Consumed rounds and time are never reset; a limit already below consumption stops the task immediately.
- `startAttempt` requires status `ready`, complete capability evidence, and a startable budget. The serialized section ends at the durable `attempt/started` commit (fsynced); the side effect then runs outside it, so `stop` and every other operation stay accepted while the attempt is pending, and settlement re-enters the serialized section. A crash after the commit consumes the round exactly once and a restart never repeats the side effect. The first failed build consumes the round; cancelled and late results never refund consumed rounds or time.
- `stop` records a human cancellation while a pending attempt is still running and aborts that attempt's cancellation handle so its side effect can quiesce. A result arriving afterwards stays diagnostic: nothing is committed, and the task keeps its stopped state until the pending attempt's settlement acknowledges quiescence.
- `recordTrialApproval` binds a human trial approval to the current verified result. Any later attempt or plan version invalidates it. No upgrade path exists in this package.

### Trusted-runner cancellation

`startAttempt` accepts an optional `signal?: AbortSignal` and hands the side effect its own `AbortSignal`, which aborts when the supplied signal aborts, a stop is requested, or journal persistence becomes uncertain. The external listener is removed when the attempt settles or its start commit fails. Cancelled and late results never record a pass, and consumed rounds and time stay consumed. A plain `AbortSignal` is cooperative cancellation for a trusted runner, not child-process supervision; real runner integration requires external supervision.

</details>

<a id="verification-and-budget-rules"></a>
## Verification and budget rules

Approved phase and step limits require corresponding observations in the report; omitted observations cannot pass. Duplicate case or assertion identities are rejected rather than letting a later passing entry hide a failed entry. The verifier must obtain these observations independently of the experiment.

`verifyAttemptResult` accepts only a complete run for the exact current task, attempt, source, artifact, and plan digest: exit code zero, no signal, no timeout, no cancellation, and every required assertion of every required case present and passing. Zero-case reports, skipped or missing assertions, timeouts, signals, cancellations, and non-zero exits never pass. A result completing at or after the time budget deadline is late and cannot move the task to `awaiting-trial`, and so is a report whose observed phase durations or step count overrun the approved `phaseTimeoutMs` or `maxStepsPerAttempt`. Rounds and time are first-bound-wins: whichever limit the budget exhausts first stops the task, and the other limit's remainder never grants continuation.

<a id="journal"></a>
## Journal

`TaskJournal` appends hash-chained JSONL records to bounded segments under the task directory, writes every record in full (short writes are retried) and fsyncs it before the caller may act on it, and atomically replaces a protected checkpoint and a projection file — both fsynced afterwards, together with the directory entry whenever a new file appears (`writeFileAtomic` alone does not fsync). Reads are bounded and proven: segment names must match their sequence position, files must be regular (symlinks, FIFOs, and directories are rejected), records carry the full durable event schema (a null, missing, or unknown discriminant is corruption), a missing terminal newline is an incomplete tail, and a nonempty journal without a checkpoint fails closed. Absence and denial are distinguished — an unreadable checkpoint reports its errno instead of pretending the file is absent. A malformed or incomplete tail, a chain break, a checkpoint mismatch, or any other verification failure refuses every side effect and surfaces handoff instead of repairing or resuming. An in-flight attempt found at restart is interrupted, its round stays consumed, and an interval that crossed a boot session freezes the remaining time budget until a human reviews it.

The first record creates a checkpoint; later checkpoints follow the configured interval or segment rotation. The chain detects changed records and the checkpoint detects truncation of records it covers. Complete-record truncation after the latest checkpoint is not detected. Neither mechanism protects against an administrator or an attacker that can rewrite both files; the control directory must stay outside the experiment's writable scope.

No runtime invariant companion is published; task state derives from a single validated journal fold, while file durability and projection recovery require filesystem round-trip tests. The package exposes no independent runtime event stream to cross-check.

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough: the decision record that owns the lifecycle and control-hardening choices, and the subsystem page that places this opt-in package among its workflow siblings.

- [Self-development task-control foundation (proposed Agent Note)](../../../.agents/notes/proposed/feature/2026-09-18-self-development-task-control-foundation.md) — the lifecycle, budget, and journal decisions this package implements.
- [Workflow subsystem](../../../docs/subsystems/workflow.md) — the workflow seam and the other packages in the group.

## Known Limitations and Deferred Work

- **No real runner integration** — attempts run only the side-effect closure the trusted host supplies. The worker process, storage quota enforcement, sandbox coverage, external verifier, and Swift supervisor clock do not exist yet; none of them can be enabled by configuration, and no capability evidence is faked.
- **Per-phase and step limits are verified, not enforced** — the controller rejects reports that overrun `phaseTimeoutMs` or `maxStepsPerAttempt`, but enforcing those limits while an attempt runs is a host-supervisor obligation (kill at the deadline, cap steps, confirm child quiescence on cancellation, supply trusted clock observations). No such supervisor process exists yet; an `AbortSignal` is cooperative cancellation, not supervision.
- **Snapshot coverage is absent** — a dsh/Loader composition smoke exists (the service boots from a test-only `cordis.yml`, drives one lifecycle, and disposes), but no recorded-session snapshot covers this package because it registers no model-visible surface.
- **Handoff resolution is manual** — a refused journal stays refused; the human resolves the files and reopens the task. There is no repair or auto-resume path.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
