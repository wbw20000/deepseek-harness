---
description: "Opt-in host-only trial-instance manager for self-development campaigns: builds a passing task's worktree, boots its `dsh web` on an allocated loopback port with the experiment data home, and owns the process group until the trial closes."
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development-trial

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

See a self-development task's experiment running, not just read about it. Call `openTrial` once a task's worktree is ready — later a passed campaign triggers it on its own — and the package builds that worktree with its own `pnpm`, boots its `dsh web` on a loopback port, and keeps that process alive until you close it or the service unloads. Every open re-runs the build, so budget build time for it. Only the stable host can open, close, or list an instance; a phone caller can watch progress but never opens or kills a process itself.

## Table of Contents

- [Service](#service)
- [What `openTrial` does](#what-opentrial-does)
- [Storage and redaction](#storage-and-redaction)
- [Automatic open on a passed campaign](#automatic-open-on-a-passed-campaign)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="service"></a>
## Service

`SelfDevelopmentTrial` (default export, Cordis service `selfDevelopmentTrial`) declares `selfDevelopmentRemote` as an injection, so the Remote facade loads first; it reads the facade only through `getTask`, and only to read one task's stored launch profile. The service registers no tool, prompt, or durable store of its own — its only state is the sidecar files under its control directory and the child processes it currently owns.

| Method | Contract |
|---|---|
| `openTrial(taskId)` | Opens (or reuses) one task's trial instance; see [What `openTrial` does](#what-opentrial-does). Host-only. |
| `closeTrial(taskId)` | Stops one task's instance (SIGTERM, a five-second grace, then SIGKILL) and removes its registration. A task with no live instance still clears a stale sidecar. Host-only. |
| `trials()` | Lists the live instances this process owns, sorted by task id. A process restart starts from `[]`: instances are never resurrected from sidecars. Host-only. |

| Config field | Meaning |
|---|---|
| `nodeBinary` | Absolute path of the Node binary used to spawn the worktree's `apps/cli/lib/bin.js web`. |
| `controlDirectory` | Absolute directory the service owns; it writes only its own `trials/<taskId>.json` sidecars and `trials/<taskId>.log` files under it. |
| `portRange` | Inclusive `[from, to]` loopback port range trial instances are allocated from. |
| `buildTimeoutMs` | Maximum wall time of one worktree build before the open fails; default 20 minutes. |
| `readyTimeoutMs` | Maximum wait for the web process's `dsh web: http://…` readiness line; default 60 seconds. |
| `autoOpen` | Whether a `campaign-passed` event automatically opens the task's trial instance; default `true`. |

Configuration is validated at construction: a `nodeBinary` or `controlDirectory` that is not an absolute path, a `portRange` bound outside 1–65535 or not ascending, or a non-positive-integer deadline fails the mount instead of degrading a later open.

Every method calls `assertCallerIsHost` first: without a connection service, or outside any `@Remote` request, the call counts as the stable host — the same reading the Remote facade uses for its own isolation-setting operations. A non-host caller is refused with `self-development/host-only-field`; it may still watch a task's progress through the facade.

-----

<a id="what-opentrial-does"></a>
## What `openTrial` does

`openTrial(taskId)` reads the task's stored launch profile through the facade's `getTask`. A profile without a `dataHome` falls back to the supervised runner's configured `dshHome`, read structurally through `ctx.get('selfDevelopmentRunner')` so this deployment never has to depend on the runner package directly; a profile with neither source refuses with `self-development/trial-unavailable`. Once a worktree and data home are known:

1. **DSH-repository check.** The worktree's root `package.json` must name `@deepseek-ai/dsh-root`. A worktree that fails this check — a plain demo repository, for instance — returns `{ url: undefined, reason: 'worktree is not a DSH repository; artifacts at <path>' }` instead of an instance; nothing is built or spawned.
2. **Build.** `pnpm run --silent build` runs inside the worktree, using the worktree's own `node_modules/.bin/pnpm` when installed, otherwise the corepack shim next to `nodeBinary`. A missing pnpm, a nonzero exit, or a run past `buildTimeoutMs` fails the open with `self-development/trial-build-failed`; the build's stdout and stderr stream into the task's log either way.
3. **Port allocation.** The first free loopback port in `portRange`, skipping ports already handed to this process's own live instances. An exhausted range fails with `self-development/trial-port-exhausted`.
4. **Spawn.** `node apps/cli/lib/bin.js web --host 127.0.0.1 --port <port> --no-open` runs inside the worktree, `DSH_HOME` set to the resolved data home, detached into its own process group. The instance's URL is read off the first `dsh web: http://…` line in its output; a process that exits or never prints that line before `readyTimeoutMs` fails the open with `self-development/trial-start-failed`, and the group is torn down before the failure is raised.

A repeated `openTrial` for a task that already has a live instance returns that instance unchanged — no second build, no second spawn, no second port. A task id that fails the core's own validation (for example, a path-escaping id) refuses with `self-development/config-invalid` before any of this runs.

-----

<a id="storage-and-redaction"></a>
## Storage and redaction

Each live instance's facts — its URL (including the real launch token), port, pid, start time, worktree, and data home — are written atomically as `<controlDirectory>/trials/<taskId>.json`, mode 0600, inside a `trials` directory the service creates at mode 0700. The URL keeps its real token here because the sidecar is what a human or another host-side caller reads to actually open the instance in a browser.

The build's and web process's combined output streams into `<controlDirectory>/trials/<taskId>.log` as it arrives, with every `?token=…`/`&token=…` query value replaced by `<redacted>` first — the log is a shared diagnostic artifact and never carries a usable launch token, even though the sidecar next to it does. `closeTrial` and `trials` do not touch the log; only `openTrial`'s build and spawn steps append to it.

-----

<a id="automatic-open-on-a-passed-campaign"></a>
## Automatic open on a passed campaign

When `autoOpen` is `true` (the default) and an events consumer is reachable — read structurally through `ctx.get('selfDevelopmentEvents')`, so this package never has to depend on the events package directly — the service subscribes to its notifications and calls `openTrial` on its own once a `campaign-passed` event names a task. This worktree's events consumer does not emit that kind yet; the subscription stays inert until the mapping lands upstream, at which point no further wiring is needed here.

An automatic open that fails — a build failure, an exhausted port range, anything `openTrial` can reject with — is logged as a warning and never propagates: a notification must not reject. Closing or reopening that task is still available through an explicit `openTrial` call.

-----

<a id="model-experience"></a>
No runtime invariant companion is published: the service exposes no runtime observation stream of its own, and the relationships it owns — one instance per task, one registered process group per instance, and no log line carrying a launch token — are covered by focused behavior tests against real child processes.

## Model Experience

None, as the service registers no model-facing tool, prompt, or event, and every method refuses a non-host caller. A phone-side model or UI never calls `openTrial`/`closeTrial`/`trials` directly; it watches a task's progress through the Remote facade and, once a chat-facing surface exists, would learn a trial's URL from that surface rather than from this package.

#### KV Cache effect

None. The service touches no prompt, session, or request path, so KV-cache reuse is unaffected.

## Known Limitations and Deferred Work

- **No OS-level isolation.** A trial instance is a plain child process on the host, spawned with the experiment's own data home and reading whatever the worktree's build produces; it is not sandboxed or network-restricted beyond binding to `127.0.0.1`.
- **One build per open, no cache reuse across tasks.** Each `openTrial` runs a fresh `pnpm run --silent build` in its own worktree; nothing here shares build output across tasks or across repeated opens of the same task once its instance already exited.
- **Instances do not survive a process restart.** `trials()` starts from `[]` after a restart even though a sidecar may still name a pid: the service only tracks instances it spawned itself in this process, matching the same spawn-record-only ownership discipline the supervised runner's process-group module uses, and never signals a process by name or by trusting a stored pid alone.
- **`campaign-passed` wiring is a stand-in.** The events kind this service listens for does not exist in this worktree yet; until the upstream mapping lands, automatic open only ever fires in a deployment that supplies its own compatible event source through `internals.events` or `ctx.selfDevelopmentEvents`.
- **The build step's `nodeBinary` parameter is currently unused.** `runBuild` accepts it for signature symmetry with `resolveBuildCommand`, which is what actually resolves a corepack fallback from it; the build command itself is always resolved before `runBuild` runs.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
