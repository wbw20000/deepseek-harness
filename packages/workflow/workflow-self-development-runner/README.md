---
description: "Supervised self-development execution and acceptance helpers: process limits, worktree digests, human-presence records, and deployment requirements."
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development-runner

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

Run a headless development command and independently check explicit acceptance cases with the exported helpers. Record a human supervision confirmation and compute source and artifact digests. These helpers do not provide operating-system isolation or an automatic development loop. They do not upgrade an installation.

## Table of Contents

- [Service](#service)
- [Trusted clock](#trusted-clock)
- [Execution and acceptance](#execution-and-acceptance)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="service"></a>
## Service

`SelfDevelopmentRunner` (default export, Cordis service `selfDevelopmentRunner`) validates deployment configuration at construction. It ships in no default bundle and exposes no service method that launches a task. The exported helpers are separate from the task controller; callers must supply supervision and connect cancellation themselves.

| Config field | Meaning |
|---|---|
| `nodeBinary` | Absolute path of the `node` binary the executor and acceptance commands run under. |
| `dshBin` | Absolute path of the harness CLI entry (`apps/cli/lib/bin.js`) the executor spawns. |
| `dshHome` | Absolute path of the experiment Agent's `DSH_HOME`; never the operating user's `~/.dsh`. |
| `experimentsRoot` | Absolute parent directory of every experiment worktree. |
| `evidenceRoot` | Absolute stable-side evidence directory; must live outside `experimentsRoot`. |
| `killGraceMs` | Milliseconds before `SIGKILL` escalation, and the separate maximum wait to confirm final group exit. |

Every field is required. A relative path, an `evidenceRoot` lexically inside `experimentsRoot`, or a `killGraceMs` that is not a positive finite integer throws `SelfDevelopmentRunnerError` with `SELF_DEV_RUNNER_CONFIG_INVALID` at construction. This configuration check does not establish filesystem isolation or protect directories from other processes running as the same user.

No runtime invariant companion is published: the package owns no independent observable relationship yet — the clock, digests, and config validation all round-trip through focused behavior tests, and the attempt pipeline that would justify cross-observation invariants does not exist yet.

<a id="trusted-clock"></a>
## Trusted clock

`HostClock` derives `bootId` from `sysctl kern.boottime` and computes `monotonicMs` as the wall-clock difference from boot time. Despite the field name, this is not a guaranteed monotonic clock. A changed boot identifier is judged `uncertain` by the core task-control package. This helper is not a substitute for a verified supervisor clock.

<a id="execution-and-acceptance"></a>
## Execution and acceptance

The [executor](src/executor.ts) starts the configured CLI through the headless profile with the experiment directory as its working directory. The [acceptor](src/acceptor.ts) loads a separate definition and checks command outcomes and file assertions. Both use POSIX process groups for cancellation. The [presence source](src/presence.ts) records an acknowledgement; it does not detect continued human presence or enforce the recorded loopback allowlist.

Acceptance definitions must reside outside the experiments root. This placement reduces accidental modification but does not make them immutable to a same-user process. The caller must protect its control files and approved inputs independently. Only a completed integration with the task controller can associate these helper results with a task's budget, frozen plan, and manual trial.

The executor stops on stdout overflow rather than accepting a truncated success. Acceptance output overflow fails every assertion. Both helpers drain the direct child's pipes, kill remaining members of its process group, and wait for the group to disappear before returning. An unconfirmed exit rejects the run, including when an unreaped process remains visible. Acceptance paths and artifact ancestors are checked through the filesystem; artifact symlinks contribute their link text without reading their targets. These checks do not prevent a concurrent same-user writer from replacing files between observations.

<a id="further-exploration"></a>
## Further Exploration

Read the subsystem page that places this package among its workflow siblings.

- [Workflow subsystem](../../../docs/subsystems/workflow.md) — the workflow seam and the other packages in the group.
- [Supervised helper limits](../../../.agents/notes/implemented/bug-fix/2026-09-18-supervised-runner-fail-closed.md) — failure handling and the limits of local checks.

<a id="model-experience"></a>
## Model Experience

None, as this service registers no model-facing tool, prompt, or event. Calling the executor explicitly passes the caller's task to a separate headless Agent.

#### KV Cache effect

The service adds no prompt prefix. Cache reuse inside the separately launched Agent follows its configured profile and provider.

## Known Limitations and Deferred Work

- **Wall-clock sensitivity** — `HostClock.monotonicMs` derives from `Date.now()`, so a wall-clock adjustment can invalidate duration measurements. A JavaScript timer is not an independent supervisor across process failure or host sleep.
- **No task orchestration** — the service does not yet connect the helpers to `startAttempt`, persist attempt evidence, or repeat failed attempts. No unattended execution or upgrade path is provided.
- **Same-user execution** — working-directory selection and a restricted environment are not a sandbox. Children retain the operating-system user's permissions; the supplied experiment home may contain credentials. Acceptance commands also run without an outer sandbox.
- **Process-group identity and escape** — a descendant that leaves the group, for example with `setsid`, can escape group cancellation. A numeric group id can also be reused after exit; signalling does not pin an OS-owned process identity. Execution helpers reject Windows before spawning; they do not implement a Windows process supervisor.
- **macOS-only clock source** — `readBootTimeSysctl` shells out to `sysctl kern.boottime`, which does not exist on Linux or Windows; there is no fallback clock.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
