# Agent Note: Self-development task-control foundation

Status: proposed

English | [中文](2026-09-18-self-development-task-control-foundation.zh.md)

## Problem

The approved self-development design needs a control layer that never confuses a model's word with a human approval, never lets a late or misidentified test report flip a task into passing, and never loses the consumed budget across restarts. Nothing in the repository owns that state machine today. Without it, any later worker, verifier, or release integration would have to invent its own lifecycle, and every one of them would be tempted to trust the experiment's self-reported success.

## Proposal

Add `packages/workflow/workflow-self-development` as an opt-in package in the existing workflow group. One serialized controller per task owns the lifecycle `draft → planning-authorized → awaiting-plan-confirmation → awaiting-development-approval → ready → attempting → awaiting-trial`, with `stopped` and `handoff` terminal states. The controller persists a hash-chained JSONL journal with a protected checkpoint in a private configured control directory, fsyncs each record before the caller may act, and commits `attempt/started` durably before running any requested side effect, so the first failed build consumes the round exactly once.

Control hardening decisions this increment commits to:

- **Validate the fold before any durable append.** A rejected operation leaves the journal byte-for-byte unchanged; an operation can no longer poison the durable log after its request was rejected. A failed journal append or fsync latches refusal for the controller instance and requires human handoff — the controller never continues after an ambiguous durable outcome.
- **The serialized section ends at the durable start commit.** The attempt's side effect runs outside the operation queue, so `stop` is accepted while an attempt is pending; settlement re-enters the queue, keeps the attempt identity, and a cancelled or stopped attempt can only settle as a failed attempt (`SELF_DEV_ATTEMPT_CANCELLED`). A plain `AbortSignal` is cooperative trusted-runner cancellation, never child-process supervision; late success never records a pass and consumed rounds and time are never refunded.
- **Idempotency is method-scoped and execution-explicit.** The digest covers the controller method plus an explicit execution payload; the side-effect callback is never replay content, and a reopen marks replayed outcomes as replays instead of fresh successes. The fold validates that a plan confirmation repeats the human-visible draft content, not just its version.
- **Reads fail closed with evidence.** The journal enforces bounded reads of regular files only (no symlinks, FIFOs, or directories), full durable event schemas, terminal newlines, segment-name/sequence agreement, a missing checkpoint over a nonempty log, and errno-distinguishing absence; writes retry short writes and fsync new directory entries. The chain does not protect against an attacker that rewrites the journal and the checkpoint together, so the control directory must stay outside the experiment's writable scope.
- **Budget overrun verdicts exist; enforcement is a supervisor obligation.** The controller rejects reports whose observed phase durations or step counts overrun the approved bounds, and documents the host-supervisor obligations in `SupervisorObligations`. No supervisor process exists, so real execution stays refused.
- **Capability evidence sources are recorded explicitly.** Every evidence item declares how it was produced (`machine` or `human-presence`), an item without a valid source kind rejects the launch, and the durable `attempt/started` record carries the aggregate source. `human-presence` attests that a person was present, never unattended isolation.
- **Verified results bind tested content, not just launch identity.** An attempt's `sourceDigest` and `artifactDigest` stay launch-input identity: they say what the attempt started from, never what the runner tested. Every verified report must instead carry required `testedSourceDigest`, `testedArtifactDigest`, and `acceptanceDefinitionDigest`, and the result digest that `task/passed` commits and a trial approval binds covers them. The trusted runner computes these digests and independently rechecks the bytes; the core never reads a worktree, does not validate a hash's truth, and does not approve an acceptance definition merely because a digest is present. This is content binding, not proof of test quality or same-user tamper resistance. Because it changes what a passing result means, the journal schema version moves to 3, and version-1 and version-2 journals are refused into handoff rather than re-read as if their old passes were content-bound.

Design decisions and what they give up:

- **Trusted clock and capability evidence are injected per call, never configured.** A Node clock cannot prove macOS sleep or reboot accounting, and no boolean may claim isolation passed. Absent evidence sources reject launching; real runner integration stays disabled until the Swift supervisor, storage quota, sandbox coverage, and external verifier exist.
- **Idempotency keys survive crashes.** Committed operations store their payload digest in the journal, so a retried operation replays its recorded outcome instead of repeating side effects, and the same key with a different payload is rejected.
- **Corruption refuses instead of repairing.** A malformed tail, chain break, or checkpoint mismatch surfaces handoff and keeps the original bytes; there is no auto-resume path. The chain does not protect against a host administrator, and the README says so.
- **No upgrade API exists.** Trial approvals bind identities and are invalidated by later changes; consumers read them, nothing activates.

The package registers no tool, prompt, event, or daemon and ships in no default bundle. It does not weaken or extend the deployment-wide extra-writable-roots sandbox setting, which explicitly disclaims self-development isolation ([note](../../implemented/feature/2026-09-17-deployment-extra-writable-roots.md)). Deferred work is recorded in its README: real worker/verifier integration and the host-supervisor enforcement of per-phase and step bounds.

## Required verification

- Focused unit tests cover budget validation, approval ordering, round consumption before failure, first-bound-wins budget stops, late and misidentified results, zero/skipped/timeout/signalled/cancelled reports, tested digests that differ from the launch inputs and pass, each tested and acceptance-definition digest changing the bound result digest, a trial approval binding that exact digest, reports missing or carrying malformed tested digests rejected before any `task/passed`, journals written under schema versions 1 and 2 refused, idempotency mismatch, restart with an interrupted attempt, cross-boot time freezing, malformed/truncated/rewritten journals against real files, poison-free rejected transitions, stop accepted while an attempt is pending with its late success rejected, signal cancellation, method-scoped idempotency, frozen public snapshots, phase and step overrun verdicts, boot-time config and task-id validation, and a dsh/Loader composition smoke that boots the service from a test-only cordis.yml.
- `tsc -b packages/workflow/workflow-self-development` and oxlint over the package pass; the README gates (`verify-package-readme-model-experience`, `verify-package-readme-limitations`) pass.
- Integration acceptance is explicitly incomplete: no recorded-session snapshot covers this package (it registers no model-visible surface), and no test subset presented here counts as full acceptance of the product design.

## Alternatives considered

- **Folding the lifecycle into the existing workflow engine or the agent loop** — rejected: `ctx.workflowEngine` owns model-written orchestration scripts, and the agent loop owns turn execution; neither owns approvals, budgets, or a durable per-task journal. Coupling task control to either would spread approval semantics across two seams and make the later supervisor, verifier, and release consumers depend on engine internals.
- **Trusting the experiment's self-reported test results without a frozen plan digest** — rejected: the design's core threat is exactly that a self-developed change controls what reports success. Freezing the plan and binding results, attempts, and approvals to its digest is what makes a late or substituted report detectable; skipping it would reduce the controller to bookkeeping.
- **Configuring the trusted clock and capability evidence in `cordis.yml`** — rejected: a configuration flag can be set wrongly or left on from a previous experiment, and a Node clock cannot prove macOS sleep or reboot accounting. Per-call injection keeps the observation source with the component that can actually observe it, and absent evidence fails closed.
- **Repairing or resuming a journal that fails verification** — rejected: any repair path is code the task under development could steer. Refusing into human handoff keeps the control plane outside the experiment's reach, at the cost of manual resolution.

## Acceptance criteria

- The package exists as an opt-in member of the workflow group with its README documenting the lifecycle, config, controller operations, verification rules, journal guarantees, and limitations; it ships in no default bundle and mounts in no shipped profile.
- The focused suite proves each named behavior: budget validation and first-bound-wins stops, approval ordering, round consumption before failure, late/misidentified/overrun report rejection, idempotent replay and payload mismatch, fold-before-append with a byte-identical journal after rejection, stop-while-pending with late success rejected, restart with an interrupted attempt and frozen cross-boot time, and malformed/truncated/rewritten journals refusing against real files.
- The dsh/Loader composition smoke boots the service from a test-only `cordis.yml`, drives one lifecycle, and disposes.
- No production supervisor, worker, verifier, or Swift clock is mounted. Test-only evidence sources verify control flow; they do not establish production isolation.

## Risks

- **Enforcement gap while attempts run** — the controller verifies reports after the fact, but killing at a deadline, capping steps, and confirming child quiescence need a host supervisor that does not exist; until one lands, real execution must stay refused, and any consumer that supplies a side effect today accepts those obligations itself (`SupervisorObligations`).
- **The journal's tamper evidence stops at the host boundary** — an administrator or an attacker that rewrites the journal and checkpoint together defeats it; the control directory must stay outside the experiment's writable scope, which the deployment-wide extra-writable-roots setting explicitly does not provide.
- **Manual handoff is the only recovery** — a refused journal blocks the task until a human resolves it; deployments that cannot staff that path should not enable the package.
- **Later increments may reshape the public types** — `CapabilitySource`, `TrustedClock`, and the controller API are pre-stable and expect change once the real supervisor lands; early consumers accept churn.
