---
description: "Opt-in supervised-mode self-development runner: trusted host clock, human-presence capability evidence, a headless executor confined to an experiment worktree, and an independent acceptor."
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development-runner

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

Run one supervised-mode development attempt for the task-control foundation. Derive a boot-session trusted clock from `sysctl kern.boottime`, turn one explicit human confirmation into capability evidence, drive the headless executor inside an experiment worktree, and let an independent acceptor verify the result. Evidence files land in a stable-side directory outside the worktree the experiment can write. The service is opt-in, registers no tool, prompt, or event, and never enables unattended execution.

## Table of Contents

- [Service](#service)
- [Trusted clock](#trusted-clock)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="service"></a>
## Service

`SelfDevelopmentRunner` (default export, Cordis service `selfDevelopmentRunner`) validates its deployment configuration at construction and composes the attempt pipeline over the injected `selfDevelopmentTasks` controller. It ships in no default bundle.

| Config field | Meaning |
|---|---|
| `nodeBinary` | Absolute path of the `node` binary the executor and acceptance commands run under. |
| `dshBin` | Absolute path of the harness CLI entry (`apps/cli/lib/bin.js`) the executor spawns. |
| `dshHome` | Absolute path of the experiment Agent's `DSH_HOME`; never the operating user's `~/.dsh`. |
| `experimentsRoot` | Absolute parent directory of every experiment worktree. |
| `evidenceRoot` | Absolute stable-side evidence directory; must live outside `experimentsRoot`. |
| `killGraceMs` | Milliseconds between `SIGTERM` and `SIGKILL` when a process group is torn down. |

Every field is required. A relative path, an `evidenceRoot` inside `experimentsRoot`, or a `killGraceMs` that is not a positive finite integer throws `SelfDevelopmentRunnerError` with `SELF_DEV_RUNNER_CONFIG_INVALID` at construction. No configuration relaxes the worktree or evidence placement rules.

No runtime invariant companion is published: the package owns no independent observable relationship yet — the clock, digests, and config validation all round-trip through focused behavior tests, and the attempt pipeline that would justify cross-observation invariants does not exist yet.

<a id="trusted-clock"></a>
## Trusted clock

`HostClock` derives `bootId` and a sleep-inclusive monotonic millisecond count from `sysctl kern.boottime`. A wall-clock adjustment can make `monotonicMs` non-monotonic; a boot-session change is judged `uncertain` by the core task-control package; and this is not the Swift supervisor's trusted clock — it is the Node-side stand-in that proves the same two properties per observation.

<a id="further-exploration"></a>
## Further Exploration

Read the subsystem page that places this package among its workflow siblings.

- [Workflow subsystem](../../../docs/subsystems/workflow.md) — the workflow seam and the other packages in the group.

<a id="model-experience"></a>
## Model Experience

None, as this runner registers no model-facing tool, prompt, or event, and every record it produces lands in stable-side evidence files instead of a model request.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

- **Wall-clock sensitivity** — `HostClock.monotonicMs` derives from `Date.now()`, so a wall-clock adjustment between observations can make it non-monotonic; the core package classifies a changed `bootId` as `uncertain`, which is the only guard.
- **No executor or acceptor yet** — the headless executor, independent acceptor, and attempt composition are later tasks in the same plan; this package currently scaffolds the service, the clock, and the worktree digests only.
- **macOS-only clock source** — `readBootTimeSysctl` shells out to `sysctl kern.boottime`, which does not exist on Linux or Windows; there is no fallback clock.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
