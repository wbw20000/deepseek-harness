# Agent Note: Supervised attempt orchestration

Status: implemented

English | [中文](2026-09-18-supervised-attempt-orchestration.zh.md)

## Problem

The supervised runner owned the pieces — trusted clock, human-presence confirmation, headless executor, independent acceptor, durable evidence — but nothing composed them into one attempt. Without a fixed composition, a caller could start development under a confirmation captured for a different launch, retry by recomputing launch inputs from a worktree that development had already changed, or accept a result whose content was mutated after acceptance ran. The [task-control foundation](../../proposed/feature/2026-09-18-self-development-task-control-foundation.md) owns the controller and its per-attempt evidence contract; the [helper-limit note](../../implemented/bug-fix/2026-09-18-supervised-runner-fail-closed.md) owns how each piece fails closed. This note owns how the pieces are composed.

## Decision

`runSupervisedAttempt` composes one supervised attempt in a fixed order — judge state and revision, bind the confirmation to the resolved worktree, plan digest, acceptance definition, and artifact set, write or verify the launch record, let the core commit `attempt/started`, run development, take digest A, run acceptance, take digest B, compare A and B, write durable evidence, return the result for the core to verify and commit. Three decisions carry the composition:

- **Every attempt explicitly passes its own evidence and clock; nothing caches a human confirmation.** Each call carries the confirmation captured for that launch, and the runner wraps it in a fresh `HumanPresenceCapabilitySource` for that call's `startAttempt`; the request's clock observes the launch record and the evidence, and the core caches no evidence source and never re-reads the instance on a replay.
- **The launch record binds an operation to its launch inputs; a retry replays or refuses.** The first launch computes the digests and writes `<evidenceRoot>/tasks/<taskId>/launches/<operationId>.json` once. A retry with the same operation id reads the record back and compares the worktree, the acceptance path and definition digest, the plan digest, the artifact path set, and the source and artifact digests exactly; any divergence throws `SELF_DEV_RUNNER_LAUNCH_MISMATCH` and the launch is refused to a human instead of re-derived. The record's `expectedRevision` records the launch's expected revision and is deliberately not compared, because a retry after a failed attempt necessarily arrives at a higher revision and the core's own replay check binds the retried operation.
- **Digest A/B comparison decides content stability.** Digest A names the content after development; digest B names it after acceptance. An unequal comparison fails the run even when every acceptance assertion passed, and the evidence records both pairs with `contentStable` so a later reader sees the mutation.

The service composes this pipeline as `runAttempt`. It refuses a second attempt for a task it already owns with `SELF_DEV_RUNNER_ATTEMPT_ACTIVE` before touching the core, and it owns each in-flight attempt: `stop` runs the core stop first, then aborts the runner's cancellation handle and waits for the attempt to settle, and service disposal aborts every owned attempt and waits for all wrap-up before returning.

Evidence written without an outcome file stays a diagnostic record; the outcome beside it is what marks the attempt decided.

## Alternatives considered

**Cache the first evidence source and clock on the runner or controller.** A cached confirmation would let a later attempt launch under a supervision acknowledgement no human gave for that launch, and would hide which observation authorized it. Per-attempt injection keeps the confirmation with the request that carries it, at the cost of the caller assembling both again for every attempt; a replaying operation returns the recorded outcome without touching the supplied instance.

**Recompute the launch digests on every retry.** Development mutates the worktree, so recomputation would silently bind the retry to content different from what the person confirmed — exactly the drift the record exists to catch. Writing the record once costs one durable file per operation and turns divergence into a loud human decision instead of a quiet rebinding.

**Compare acceptance results by case names only.** Case and assertion names do not prove that the executed tests are the ones the person confirmed; a swapped acceptance definition or artifact set with unchanged names would pass. Binding the plan digest, the acceptance-definition bytes digest, and the artifact path set makes the substitution detectable.

## Consequences

A replaying retry pays a record read and field comparison but never starts a second executor, so a retried launch cannot double-run development. The A/B comparison costs two extra worktree digests per attempt and fails runs whose acceptance phase mutates content, which is the intended refusal. Evidence and outcome writes are durable but same-user rewritable; the composition adds no isolation beyond what the helpers already refuse, and the supervised-not-unattended limits of the helper-limit note still bound the whole pipeline.

## Verification

The focused suite (`tests/attempt.spec.ts`) covers a failed-then-passing attempt with decided evidence for both, replay of the same operation without a second executor launch, a stopped attempt settling as cancelled with its fixture process group torn down, a worktree mutation during acceptance refusing to pass, step-cap and phase-deadline failures, the acceptance deadline firing first, a confirmation binding a different artifact set refused, an evidence write failure failing the round without passing the task, revision conflicts refusing before any side effect, and outcome-write failures recorded without changing a committed result. `tests/service.spec.ts` and `tests/composition.spec.ts` cover the service surface: the clock singleton, the active-attempt refusal with the first attempt finished through `stop`, disposal quiescence for the owned attempt's process group, and a real cordis.yml boot of both services.
