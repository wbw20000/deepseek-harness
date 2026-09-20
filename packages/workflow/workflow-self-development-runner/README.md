---
description: "Supervised self-development attempt execution: trusted clock, human-presence evidence, operation-bound launch records, headless execution, independent acceptance, durable evidence, and controller-owned stopping. Supervised mode, not unattended."
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development-runner

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

Run one supervised self-development attempt end to end. The service composes the trusted clock, human-presence evidence, the operation-bound launch record, the headless executor, and the independent acceptor, publishes durable attempt evidence beside its terminal outcome, and stops through the task controller. Every launch requires a recorded human confirmation and a finite budget. This is a supervised mode with recorded limits, not unattended operation: on macOS the executor's and every acceptance case's process is by default confined by a file-write sandbox ([Tier 1](#sandbox-tier-1)); that is not full operating-system isolation, and nothing here upgrades an installation.

## Table of Contents

- [Service](#service)
- [Trusted clock](#trusted-clock)
- [Human-presence evidence](#human-presence-evidence)
- [Attempt budget](#attempt-budget)
- [Launch binding and the launch record](#launch-binding-and-the-launch-record)
- [Per-attempt data directory](#per-attempt-data-directory)
- [Execution and acceptance](#execution-and-acceptance)
- [Sandbox (Tier 1)](#sandbox-tier-1)
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

`SelfDevelopmentRunner` (default export, Cordis service `selfDevelopmentRunner`) validates deployment configuration at construction and exposes four service methods on `ctx.selfDevelopmentRunner`. It ships in no default bundle.

| Method | Contract |
|---|---|
| `clock()` | Returns the runner's singleton trusted clock: the first call creates one `HostClock`, every later call returns the same instance, and the task controllers and every attempt share one boot-session observer. |
| `runAttempt(req)` | Runs one supervised attempt for `req.taskId` under the runner's clock, config, and cancellation handle; the caller's signal, when present, is composed with the runner's own. A second attempt for the same task while one is in flight in this runner throws `SELF_DEV_RUNNER_ATTEMPT_ACTIVE` before the core is touched. Worktree, confirmation, launch-record, and evidence validation stay inside `runSupervisedAttempt`. The returned promise rejects verbatim with whatever the core's `open` or `runSupervisedAttempt` rejects with: a journal handoff is never wrapped, retried, or recorded as an attempt outcome here. |
| `stop(req)` | Stops a task and finishes the runner's own work for it in a fixed order: open the controller against the singleton clock and run the core stop, which commits `task/stopped` and aborts the attempt's launch signal; the runner then aborts its own cancellation handle, waits until the attempt's promise has settled — the executor and acceptor process groups have exited and the evidence writes are done — and returns the core's stop result. Without an in-flight attempt, only the core stop runs. The attempt's rejection stays with `runAttempt`'s caller; the stop only requires the wrap-up to have finished. |
| `activeTasks()` | Returns a read-only snapshot of the task ids of the attempts this runner currently owns; later ownership changes are not reflected. |

Unloading the service aborts every attempt it owns, then waits for all of their wrap-up — the executor and acceptor drain pipes, kill remaining group members, and wait for group exit, and the evidence writes finish — before disposal returns. Nothing is ever scanned by process name.

| Config field | Meaning |
|---|---|
| `nodeBinary` | Absolute path of the `node` binary the executor and acceptance commands run under. |
| `dshBin` | Absolute path of the harness CLI entry (`apps/cli/lib/bin.js`) the executor spawns. |
| `dshHome` | Absolute path of the experiment Agent's `DSH_HOME`; never the operating user's `~/.dsh`. |
| `experimentsRoot` | Absolute parent directory of every experiment worktree. |
| `evidenceRoot` | Absolute stable-side evidence directory; must live outside `experimentsRoot`. |
| `killGraceMs` | Milliseconds before `SIGKILL` escalation, and the separate maximum wait to confirm final group exit. |
| `sandbox` | macOS file-level sandbox ([Tier 1](#sandbox-tier-1)) wrapping the executor and every acceptance case; optional, an absent key defaults to enabled with no extra roots. |

Every required field above must be present. A relative path, an `evidenceRoot` lexically inside `experimentsRoot`, or a `killGraceMs` that is not a positive finite integer throws `SelfDevelopmentRunnerError` with `SELF_DEV_RUNNER_CONFIG_INVALID` at construction — as does a configured `sandbox.sandboxExec`, `sandbox.denyReadRoots` entry, or `sandbox.extraWritableRoots` entry that is not an absolute path. This configuration check by itself does not establish filesystem isolation or protect directories from other processes running as the same user; on macOS, the sandbox described below does that for the executor's and each acceptance case's own writes, within its own limits.

No runtime invariant companion is published: the package exposes no runtime observation stream of its own, the relationships it owns between the launch record, the attempt evidence, and the core result are covered by focused behavior tests, and drift between the evidence directory and the control directory is refused to a human rather than reconciled by an in-process check.

<a id="trusted-clock"></a>
## Trusted clock

[`clock.ts`](src/clock.ts) exports `HostClock`, which derives `bootId` from `sysctl kern.boottime` and computes `monotonicMs` as the wall-clock difference from boot time. Despite the field name, this is not a guaranteed monotonic clock. A changed boot identifier is judged `uncertain` by the core task-control package. Each attempt request carries its own clock; this helper is not a substitute for a verified supervisor clock.

<a id="human-presence-evidence"></a>
## Human-presence evidence

[`presence.ts`](src/presence.ts) turns one concrete confirmation into capability evidence for the core `startAttempt` contract. The confirmation records who confirmed, when (one trusted-clock observation), which experiment worktree the attempt runs in, which loopback ports the session may bind, and the literal acknowledgement. `PresenceAcknowledgement` is `'supervised-not-unattended' | 'unattended-accepted'`: `supervised-not-unattended` asserts a person was present at that specific launch; `unattended-accepted` records that a person accepted, once at campaign start, that later campaign rounds launch without a per-round confirmation. **`unattended-accepted` is not an isolation guarantee** — it does not detect continued human presence and provides no operating-system isolation; it only records that the human will not be asked to reconfirm each automatic round within the accepted budget window. It also binds the launch facts the person reviewed: the task id, the frozen test-plan digest, the acceptance-definition digest, and the artifact path set, so a confirmation given for one launch cannot be replayed against different content.

`HumanPresenceCapabilitySource` produces one evidence item per required capability, each digest bound to that confirmation — including the acknowledgement literal — and the core records the attempt as human-supervised regardless of which wording is present. The source records an acknowledgement; it does not detect continued human presence or enforce the recorded loopback allowlist.

<a id="attempt-budget"></a>
## Attempt budget

[`budget.ts`](src/budget.ts) derives one attempt's finite bounds from the human-approved budget minus the time the task already consumed. A missing approval, a budget that bounds neither a phase nor the total, or a total that is already spent throws `SELF_DEV_RUNNER_BUDGET_INVALID` before anything launches. Each phase runs under its own in-run deadline: the development phase gets the smaller of the approved phase bound and the remaining total, and the acceptance phase gets what is left after development. Whichever limit reaches zero first cancels the run. A deadline aborts an internal `AbortSignal` at its limit; an external cancellation aborts it without reporting a timeout. A deadline ends the run's observation; it is not child-process supervision for a process that escaped its group.

<a id="launch-binding-and-the-launch-record"></a>
## Launch binding and the launch record

[`binding.ts`](src/binding.ts) refuses a launch whose confirmation does not bind the real launch facts: the task id, the worktree's filesystem realpath (which must resolve inside the experiments root and carry a `.git` entry), the frozen plan digest, the acceptance-definition digest, and the artifact path set.

[`launch-record.ts`](src/launch-record.ts) writes the operation-bound launch record to `<evidenceRoot>/tasks/<taskId>/launches/<operationId>.json`, exactly once per operation, with the digests computed at launch: worktree realpath, data-directory realpath, artifact paths, acceptance path and digest, test-plan digest, source and artifact digests, the derived budget, and the human confirmation.

<a id="per-attempt-data-directory"></a>
## Per-attempt data directory

`runSupervisedAttempt` accepts an optional `dshHome` on the request: the data directory this one attempt runs with. Absent, the attempt runs exactly as before, with the deployment's configured `dshHome`. When present, the directory must be absolute, must resolve through the filesystem to a location inside `experimentsRoot` — a plain directory is enough, no `.git` entry — must not be the configured `dshHome`, and must not sit inside the experiment worktree, where the launched agent can write freely. Any other value throws `SELF_DEV_RUNNER_WORKTREE_INVALID` before the acceptance definition is loaded and before a launch record exists.

The executor's child and every acceptance case process both receive the attempt's data directory as their `DSH_HOME`, so per-task state the harness writes under its home lands in that task's directory. The launch record stores the resolved directory as `dshHomeReal` and retries compare it: a retry that names a different data directory is refused with `SELF_DEV_RUNNER_LAUNCH_MISMATCH`, and a record written before the field existed is read as the configured `dshHome`, so an old operation cannot gain a data directory on retry.

This is the seam the workspaces service hands its allocations over: `allocate` returns a `TaskWorkspace` whose `dataHome` is `<experimentsRoot>/<taskId>/dsh-home`, copied from the deployment's `dataHomeTemplate`; pass that value straight through as the attempt's `dshHome`:

```ts ignore-check
// The workspaces allocation already carries the task's data home.
const workspace = await workspaces.allocate({ taskId, projectRoot })
await runner.runAttempt({
  taskId: workspace.taskId,
  worktree: workspace.worktree,
  dshHome: workspace.dataHome,
  // remaining supervised-attempt fields as usual: expectedRevision,
  // operationId, artifactPaths, acceptancePath, presence
})
```

The separation is bookkeeping and spawn-environment plumbing, not isolation by itself. A child still runs as the operating user. On macOS, the default [Tier 1 sandbox](#sandbox-tier-1) fences what the executor's and each acceptance case's *own* process may write to this attempt's roots, so that process alone can no longer write another task's data directory once sandboxed — but any *other* same-user process still can, reads stay open outside a configured `denyReadRoots`, and `sandbox.enabled: false` (or a non-macOS host) removes even that: protecting the evidence root and control directory from every same-user process still needs `denyReadRoots` or OS-level access control this package does not otherwise provide.

<a id="execution-and-acceptance"></a>
## Execution and acceptance

The [executor](src/executor.ts) starts the configured CLI through the headless profile with the experiment directory as its working directory and the attempt's data directory as its `DSH_HOME`. The [acceptor](src/acceptor.ts) loads a separate definition and checks command outcomes and file assertions, handing its case processes the same data directory. Both use POSIX process groups for cancellation, and on macOS both are wrapped by default in the [Tier 1 sandbox](#sandbox-tier-1) below. The presence source above records an acknowledgement; it does not detect continued human presence or enforce the recorded loopback allowlist.

Acceptance definitions must reside outside the experiments root. This placement reduces accidental modification but does not make them immutable to a same-user process. The caller must protect its control files and approved inputs independently. Only a completed integration with the task controller can associate these helper results with a task's budget, frozen plan, and manual trial.

The executor stops on stdout overflow rather than accepting a truncated success. Acceptance output overflow fails every assertion. Both helpers drain the direct child's pipes, kill remaining members of its process group, and wait for the group to disappear before returning. Final cleanup judges group ownership by the spawned leader's pid, the helper's own observation of that leader's exit, and the `ps -o lstart=` start time read at spawn: an `EPERM` group signal while the leader is no longer observable as ours is recorded as `pgidReused` in the run result instead of failing the run. An unconfirmed exit still rejects the run, including when an unreaped process remains visible or the fingerprinted leader is still ours. `sandbox-exec` (below) `execve()`s the wrapped program in place, so the spawned pid is unaffected by the wrap and this fingerprint stays valid whether or not the spawn was confined. Acceptance paths and artifact ancestors are checked through the filesystem; artifact symlinks contribute their link text without reading their targets. These checks do not prevent a concurrent same-user writer from replacing files between observations.

<a id="sandbox-tier-1"></a>
## Sandbox (Tier 1)

On macOS, the executor's headless-CLI child and every acceptance case's process are by default spawned under `sandbox-exec -p <profile>` (Seatbelt). [`sandbox.ts`](src/sandbox.ts) builds a small, self-contained SBPL profile for each spawn; it does not depend on `@deepseek-ai/dsh-sandbox-local`, so the host's own sandbox-provider policy objects never leak into this path.

**Rule.** Every profile is `(version 1)`, default-allow, a global `file-write*` deny, `/dev/null` re-allowed for write, every writable root re-allowed for write, and finally one `file-read*` deny per deny-read root. The deny-read forms are written last on purpose: Seatbelt judges an operation by the *last* rule in the profile that matches it, so a deny appended after the leading default-allow overrides it for reads under that root, while the write-only rules above it are untouched.

**Writable roots**, granted to every confined spawn: the experiment worktree, this attempt's data directory (`request.dshHome ?? config.dshHome`), every temp-directory spelling this host carries (`/private/tmp`, `/tmp`, `os.tmpdir()`, and `$TMPDIR` when set), and the deployment's `extraWritableRoots`. The stable runtime worktree that `dshBin` lives under is not added to this list — it stays readable (default-allow covers reads) but not writable. Every root is resolved through the filesystem (`realpath`, walking past a not-yet-created tail) before it reaches the profile text, so a symlinked spelling (`/tmp` before it resolves to `/private/tmp`, or a deployment's `~/.dsh` before it resolves to wherever it actually points) is judged by its real target, not its configured spelling.

**Deny-read roots**: the deployment's `denyReadRoots` — empty by default. A deployment that wants the sandboxed process unable to *read* its stable runtime home, control directory, or evidence root must list them explicitly; see the overlay example in [`self-development.overlay.yml`](../../bundle/web-app/overlays/self-development.overlay.yml).

**Defaults** (`RunnerConfig.sandbox`; every field is optional and an absent key parses to these through the Cordis schema):

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Sandboxing on by default on macOS. |
| `denyReadRoots` | `[]` | Nothing denied for reads beyond the write fence. |
| `extraWritableRoots` | `[]` | No writable root beyond the worktree, the data directory, and temp. |
| `sandboxExec` | `/usr/bin/sandbox-exec` | The system binary the probe and every wrap invoke. |

**Probe and refusal.** Before an attempt's `startAttempt` side effect runs — and again, defensively, at each executor or acceptor spawn — [`probeSandbox`](src/sandbox.ts) applies the most permissive possible profile (`(version 1)(allow default)`) to `/usr/bin/true` through the configured `sandboxExec`. On darwin with sandboxing enabled, a probe exit other than `0`, a spawn failure, or a missing `sandboxExec` refuses the attempt before it starts, with `SELF_DEV_RUNNER_SANDBOX_UNAVAILABLE` — before the core ever commits `attempt/started`, and before a launch record is written. Off darwin, or with `sandbox.enabled: false`, the probe never runs and nothing is refused on that account: this package carries no sandbox tier there, so "no macOS mechanism" is that platform's ordinary state, not a broken environment.

**`sandbox.enabled: false`** is an explicit deployment opt-out into no file-level isolation at all for every attempt this deployment runs: the executor and every acceptance case spawn exactly as they did before this package had a sandbox tier, and the [Known Limitations](#known-limitations-and-deferred-work) items below about same-user reach then describe the *whole* attempt, not just what the sandbox itself still leaves open.

**Evidence.** Each attempt's evidence (below) records `sandbox: { kind: 'disabled' }`, or `sandbox: { kind: 'seatbelt', profileDigest }` — the sha-256 digest of the resolved profile text, not the text itself, so evidence never carries the deployment's real absolute path layout (the worktree, the data home, every deny-read root) off the stable host it was written on.

**Cannot claim**, beyond what [Known Limitations](#known-limitations-and-deferred-work) already says: this is a file-write fence, not full isolation. The sandboxed process keeps the network — the launched experiment Agent must still be able to reach its configured model provider, and the profile never restricts network access — and keeps visibility of other processes and of the filesystem's read surface outside a configured `denyReadRoots`. `sandbox-exec` is also a mechanism Apple has marked deprecated for several major macOS releases but still ships and enforces on every currently supported release; this package has no fallback if a future release removes it, beyond `sandbox.enabled: false` (no isolation at all).

<a id="attempt-evidence"></a>
## Attempt evidence

[`evidence.ts`](src/evidence.ts) publishes one attempt's durable record under `<evidenceRoot>/tasks/<taskId>/attempts/<attemptId>.json` and the terminal decision beside it as `<attemptId>.outcome.json`. The evidence records the launch digests, the sandbox status the executor and acceptor ran under (see [Sandbox (Tier 1)](#sandbox-tier-1)), digest A taken after the development phase, digest B taken after acceptance (or `undefined` when acceptance never ran), whether the two are equal, the observed executor and acceptance facts, the phase runs, and the structured result. The outcome records the terminal decision — `passed`, `failed`, `cancelled`, `late`, or `unknown` — the committed revision, and the structured failure.

Evidence without an outcome file is a diagnostic record only: it never asserts that the core log passed. Writes go through [`durable-json.ts`](src/durable-json.ts): an exclusive temporary file, fsync, atomic rename, and directory sync, so an interrupted write never leaves a readable half-published file. Rewriting identical bytes is `unchanged`; a path that already holds different bytes throws `SELF_DEV_RUNNER_EVIDENCE_CONFLICT`.

<a id="attempt-orchestration"></a>
## Attempt orchestration

[`attempt.ts`](src/attempt.ts) runs one supervised attempt in a fixed order: judge the task state and revision, bind the confirmation to the resolved worktree, plan digest, acceptance definition, and artifact set, write or verify the launch record, then let the core commit `attempt/started` before any process starts. The side effect then runs develop, takes digest A, runs acceptance under its own deadline, takes digest B, compares A and B (an unequal comparison fails the run), writes the durable evidence, and returns the result for the core to verify and commit. A core replay never starts a second executor: a replaying operation returns the recorded outcome without executing anything. An evidence write failure fails the round; a failed outcome write is recorded best-effort and never masks the core's own decision.

The service owns every attempt it starts. [`stop`](#service) commits the core stop first and returns only after the owned attempt has settled; a cancelled attempt can only settle as a cancelled failure, because the side effect runs outside the controller's serialized section and settlement re-enters it. Disposal runs the same wrap-up for every owned attempt: abort, then wait for the executor and acceptor to drain pipes, kill remaining group members, and wait for group exit before returning.

<a id="error-codes"></a>
## Error codes

`SelfDevelopmentRunnerError` carries one of these machine-routable codes (see [`runtime.ts`](src/runtime.ts)):

| Code | Meaning |
|---|---|
| `SELF_DEV_RUNNER_CONFIG_INVALID` | The service configuration or a human-presence confirmation fails its shape validation at the config boundary. |
| `SELF_DEV_RUNNER_WORKTREE_INVALID` | The worktree does not resolve inside the experiments root, lacks a `.git` entry, cannot be digested, or a requested per-attempt data directory is relative, resolves outside the experiments root, equals the configured `dshHome`, or sits inside the worktree. |
| `SELF_DEV_RUNNER_CLOCK_UNAVAILABLE` | `sysctl kern.boottime` cannot be started, read, or parsed into a boot record. |
| `SELF_DEV_RUNNER_ACCEPTANCE_INVALID` | The acceptance definition is unusable, misplaced, or does not cover the frozen plan's required cases. |
| `SELF_DEV_RUNNER_EXECUTOR_FAILED` | The headless executor could not spawn its child or could not confirm the process group's exit. |
| `SELF_DEV_RUNNER_EVIDENCE_FAILED` | A durable write of a launch record, evidence file, or outcome file failed. |
| `SELF_DEV_RUNNER_EVIDENCE_CONFLICT` | The target path already holds different bytes than the record, evidence, or outcome being written. |
| `SELF_DEV_RUNNER_EVIDENCE_INVALID` | A launch record, evidence file, or outcome file fails its field or path validation, or an evidence root or id is malformed. |
| `SELF_DEV_RUNNER_PRESENCE_MISMATCH` | The human confirmation does not bind the launch's real facts. |
| `SELF_DEV_RUNNER_BUDGET_INVALID` | The approved budget is missing, malformed, bounds nothing, or its total is already spent. |
| `SELF_DEV_RUNNER_LAUNCH_MISMATCH` | An existing launch record does not match the content or paths of the launch being retried. |
| `SELF_DEV_RUNNER_ATTEMPT_ACTIVE` | A second `runAttempt` for a task that already has an in-flight attempt in this runner, thrown before the core is touched. |
| `SELF_DEV_RUNNER_SANDBOX_UNAVAILABLE` | Sandboxing is enabled on darwin and the [Tier 1](#sandbox-tier-1) probe did not report the mechanism available; thrown before the core commits `attempt/started`. |

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
- **Same-user execution** — working-directory selection and a restricted environment are not by themselves a sandbox. Children retain the operating-system user's permissions; the supplied experiment home may contain credentials. On macOS, the default [Tier 1 sandbox](#sandbox-tier-1) fences the executor's and each acceptance case's own writes to this attempt's roots — but only that process's writes: reads stay open outside a configured `denyReadRoots`, any *other* same-user process can still read and write every other task's data directory, and `sandbox.enabled: false` (or a non-macOS host) removes the write fence too. A per-attempt data directory changes where a child's `DSH_HOME` points; it does not by itself change what it may reach — the sandbox is what does that, within its own limits above.
- **Sandbox is a write fence, not full isolation** — the Tier 1 macOS sandbox (`sandbox.enabled`, default `true`) denies file writes outside its granted roots and, where configured, denies reads under `denyReadRoots`; it does not isolate the network, process visibility, IPC, or any filesystem read outside a configured deny-read root. A sandboxed process can still see and signal other processes, and can still read most of the filesystem.
- **Sandbox permits outbound network** — no profile this package builds restricts network access: the launched experiment Agent must still be able to reach its configured model provider, so the sandbox does not, and cannot, isolate network egress.
- **`sandbox-exec` is an Apple-deprecated mechanism** — Seatbelt's command-line front end has carried Apple's deprecation warning for several major macOS releases; this package uses it because it is still shipped and still enforces on every currently supported release, not because it is a supported long-term API. A future macOS that removes it has no fallback here beyond `sandbox.enabled: false` (no isolation at all) — see [Sandbox (Tier 1)](#sandbox-tier-1).
- **Process-group identity and escape** — a descendant that leaves the group, for example with `setsid`, can escape group cancellation. A numeric group id can also be reused after exit, and signalling does not pin an OS-owned process identity. Final cleanup therefore judges ownership by the spawned group leader — its pid, the helper's own observation of that leader's exit, and the `ps -o lstart=` start time read at spawn — and records `pgidReused` in the run result when an `EPERM` group signal coincides with a leader that is no longer observable as ours. An `EPERM` with the leader still ours, and a group still visible past the wait, still reject the run. A reused pid can still carry a matching start-time read on some hosts, and a reused same-user group can still receive a signal meant for ours. Execution helpers reject Windows before spawning; they do not implement a Windows process supervisor.
- **macOS-only clock source** — `readBootTimeSysctl` shells out to `sysctl kern.boottime`, which does not exist on Linux or Windows; there is no fallback clock.
- **Supervision is not full isolation** — working-directory selection, the environment allowlist, workspace-write, and path checks are bookkeeping, not an outer operating-system sandbox by themselves; the [Tier 1 sandbox](#sandbox-tier-1) above is the one part of this package that is, and only for file writes, only on macOS, only within its granted and denied roots. A child of the same user may still reach the real home, experiment credentials, the control directory, and other processes wherever the sandbox does not fence that specific path or is disabled. A human confirmation does not automatically create quotas, isolation, or real presence detection. Node wall-clock drift and JavaScript timers cannot replace an independent supervisor's clock, sleep accounting, and crash cleanup. The current stage provides supervised testing with recorded limits only and must not be read as clearance for unattended operation.
- **Budget deadlines end observation, not escaped processes** — phase deadlines and cancellation act through POSIX process groups, which cannot constrain a descendant that escapes with `setsid`; a limit firing tears down the group's members and records the timeout, but does not stop a process that left the group.
- **Symlink races between check and use** — worktree containment, acceptance placement, and artifact path checks resolve paths when they run; a concurrent same-user writer can replace a path component with a symlink between the check and the use, and these checks do not close that gap.
- **Evidence and control directories share the operating user** — the evidence root and the task-control directory are ordinary directories owned by the same user as the attempt; nothing here stops a same-user process, including the experiment, from rewriting evidence, launch records, or outcomes.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
