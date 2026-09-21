---
description: "Chat-side self-development launcher: Agent tools that draft a task, ask the user exactly one approval, and on approval automatically drive the stable-side facade through workspace allocation, acceptance writing, planning, budget, and an unattended campaign, then project the result back into chat."
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development-chat

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

Lets a user launch a self-development campaign from an ordinary chat message, then merge it to stable once it passes. `self_development_propose` drafts the requirement and acceptance, shows one approval card, and on approval drives the stable-side facade through the campaign start. `self_development_status` reports progress; `self_development_stop` ends a campaign. `self_development_merge` integrates a passed task into the target branch, independently re-verifies it, and rebuilds and restarts the stable version; a conflict or verification failure instead starts an unattended repair campaign under the same approval. It implements no isolation and never approves on the user's behalf — see [Known Limitations](#known-limitations-and-deferred-work).

## Table of Contents

- [Service](#service)
- [Tools](#tools)
- [The eight-step sequence](#the-eight-step-sequence)
- [Task id and baseline digest](#task-id-and-baseline-digest)
- [Campaign result notices](#campaign-result-notices)
- [Self-iterate mode](#self-iterate-mode)
- [Merge to stable](#merge-to-stable)
- [Upgrade](#upgrade)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="service"></a>
## Service

`SelfDevelopmentChat` (default export, Cordis service `selfDevelopmentChat`) declares `tools` and `approval` as hard injections — the plugin does not load without a tool registry and an approval answerer. The stable-side facade, the workspaces service, the events service, the trial service, and the runner verification service are all read structurally with `ctx.get(...)` rather than declared as typed injections, because this package is developed against the DH-a/DH-c/DI-a frozen interfaces before their packages exist in every worktree; at integration the real services satisfy the same structural shapes.

| Config field | Meaning |
|---|---|
| `stableRepo` | Absolute path of the repository whose stable-branch `HEAD` seeds `stableBaselineDigest`. |
| `controlDirectory` | Absolute directory this package writes acceptance definitions into (`<controlDirectory>/acceptance/<taskId>.json`, mode 0600 inside a 0700 directory); also the base of the derived `<controlDirectory>/campaigns/<taskId>.json` path reported by `self_development_status`. Must resolve outside `experimentsRoot` — the runner refuses to judge an acceptance definition placed inside the experiments root, so a nested `controlDirectory` fails every campaign round closed; checked (via `realpath`) at plugin construction and again before every proposal. |
| `experimentsRoot` | Absolute experiments root used to resolve a task's workspace when no workspaces service is mounted: the fallback requires `<experimentsRoot>/<taskId>` to already exist. |
| `actor` | Human actor recorded as the task creator, plan confirmer, budget approver, unattended-campaign acceptor, and trial approver. |
| `targetBranch` | Branch `self_development_merge` merges a passed task's worktree into. Required, non-empty — validated at construction. |
| `integrationGates` | Commands run with `sh -c` inside the merged worktree during `self_development_merge`'s `verify`, in order; a non-zero exit or a 20-minute-per-command timeout fails the merge closed. Defaults to `[]`. |
| `upgrade` | How `self_development_merge` rebuilds and restarts the stable version after an `integrated` result — see [Upgrade](#upgrade). Defaults to `{ kind: 'none' }`. Validated at construction — an invalid explicit value fails the mount. |
| `commitIdentity` | `{ name, email }` git author for the snapshot commit `self_development_merge` asks `workspaces.integrate` to make of a dirty task worktree before rebasing — see [Merge to stable](#merge-to-stable). Defaults to `{ name: 'DSH self-development', email: 'self-development@dsh.local' }`. Validated at construction — an explicit empty `name` or `email` fails the mount. |
| `cardLocale` | `'zh'` (default) or `'en'`: the language of the approval-card copy and the campaign-result chat notice. |
| `defaultBudget` | Budget used when a proposal omits one; defaults to `{ preset: 'unlimited' }`. Validated at construction — an invalid explicit value fails the mount. |
| `defaultUnattended` | Unattended default when a proposal omits it; defaults to `true`. |
| `guidance` | Register the self-development guidance `systemPrompt` section (see [Model Experience](#model-experience)); defaults to `true`. |

Ports read from the context (all but `approval` optional):

| Port | Context key | Behavior when absent |
|---|---|---|
| Remote facade | `selfDevelopmentRemote` | Every tool call fails with `facade` errors; in practice the plugin should not be composed without it. |
| Approval | `approval` | Hard injection: the plugin fails to load. |
| Workspaces | `selfDevelopmentWorkspaces` | `self_development_propose` falls back to an already-existing `<experimentsRoot>/<taskId>` directory and refuses a missing one; `self_development_merge` fails closed (its `integrate` method has no fallback). |
| Events | `selfDevelopmentEvents` | No campaign-result chat notice is ever delivered; `self_development_status`'s `latestEvent` field is never populated. |
| System prompt | `systemPrompt` | The self-development guidance section is not registered (logged at `debug`); the model sees no built-in instruction to prefer `self_development_propose` over editing the trial branch itself. |
| Trial (DH-c) | `selfDevelopmentTrial` | `self_development_status`'s `trialUrl` field is never populated. |
| Runner verification | `selfDevelopmentRunner` | `self_development_merge` fails closed — merging to stable without the runner's independent acceptance verification is not offered. |

-----

<a id="tools"></a>
## Tools

### `self_development_propose`

Parameters (every field the model drafts from the user's words, except `budget`/`unattended`/`parallel`, which default from the deployment config when omitted):

| Field | Meaning |
|---|---|
| `requirement` | The requirement, consolidated from the user's words. |
| `allowedModificationScope` | Repository paths (globs allowed) the development worker may modify. |
| `plan.requiredCases` | `{ caseId, requirement, assertionIds }[]` — the acceptance cases every campaign round must pass. |
| `plan.manualCases` | Acceptance items explicitly reserved for human verification. |
| `acceptance` | The drafted acceptance definition: `{ "cases": [ { "caseId", "command": string[], "cwd"?, "timeoutMs", "assertions": [...] } ] }`, where each assertion is one of `{ assertionId, kind: "exit-code", expected }`, `{ assertionId, kind: "stdout-includes", text }`, `{ assertionId, kind: "file-exists", path }`, or `{ assertionId, kind: "file-includes", path, text }` — the tool parameter schema states this shape explicitly (an object schema, not an opaque JSON blob), and also accepts the same shape as a JSON-encoded string for a tool-calling format that cannot emit nested objects. Every `plan.requiredCases[].caseId` and `assertionIds` must be defined here; validated before the approval card is shown. |
| `budget` | `{ preset: 'unlimited' }` (no step/call/token cap; bounded only by a 24h total and the no-progress stop), `{ mode: 'rounds', maxRounds }`, or `{ mode: 'time', hours }` (`hours` ≤ 24, rejected otherwise). |
| `unattended` | Whether one approval covers every campaign round. |
| `parallel` | `false` refuses the proposal while another campaign this process started is still running. |

Behavior: validates the input (including the acceptance definition against the plan's required cases, and the budget's `hours ≤ 24` ceiling — the tool parameter schema has no numeric-bound keyword, so this is enforced in code, the same pattern `tool-bash` uses for its own value constraints beyond its schema); when `parallel` is `false`, checks every task id this process has started for a running campaign and refuses early if one is found — before the user is ever asked; then shows **one** approval card (`ctx.approval.request`) naming the requirement, the acceptance cases, the budget, the unattended choice, and the workspace. Only `allowed-once` proceeds — every other outcome (`rejected`, `cancelled`, `unavailable`) makes no facade call at all and returns `{ ok: false, reason }`. On approval, the steps in [the eight-step sequence](#the-eight-step-sequence) run in order; a failure at any step stops the sequence and returns the steps completed so far, the failure reason, and (when available) a machine-routable error code. Nothing already written is rolled back: the worktree, the acceptance-definition file, and any task journal entries already committed stay in place for triage.

### `self_development_status`

Parameters: `{ taskId }`. Returns the task's control-state summary (status, revision, requirement, consumed rounds/time, planning-authorized, no-progress count), the campaign state (rounds, last outcome, reason, acknowledgement) when one exists, the derived paths (worktree and acceptance path from the launch profile when set, plus the always-present acceptance-definition and campaign-record paths), the trial URL when the trial service reports a running instance for the task, and the most recent `campaign-passed`/`campaign-ended` event this process observed for the task. A facade failure (e.g. an unknown task id) yields `{ ok: false, reason, error }`.

### `self_development_stop`

Parameters: `{ taskId, reason }`. Forwards to the facade's `stopCampaign(taskId, reason)` and returns the resulting campaign state, or `{ ok: false, reason, error }` on refusal. A campaign that had already settled comes back unchanged and leaves the task where it was — passed and `awaiting-trial` — so when the task is still not `stopped` afterwards the tool stops the task itself (the facade's `stop(taskId, revision)`, core `task/stopped`) and reports `task: { status: 'stopped', revision }`: the user is discarding a task they do not want merged, and a stopped task is what the next proposal's reclamation releases (its worktree stays until then).

### `self_development_merge`

Host-only: this tool rebuilds and restarts the stable version it runs alongside, so it is only meaningful when the acting process is that same deployment (see [Known Limitations](#known-limitations-and-deferred-work) — there is no runtime caller-identity check enforcing this).

Parameters: `{ taskId? }` — the task to merge; omitted takes the most recently proposed task that is `awaiting-trial` (searched newest first among the tasks this process itself proposed). An explicit `taskId` that is not `awaiting-trial`, or omitted with none found, is refused before any approval is requested — as is a task with nothing new to merge (see [Merge to stable](#merge-to-stable)).

Behavior: shows **one** approval card naming the task, the target branch, that the merge rebuilds and restarts the stable version, and that a conflict or verification failure automatically starts a repair campaign — so that case never asks a second card. Only `allowed-once` proceeds. On approval: `recordTrialApproval(taskId, revision, actor)`, then `workspaces.integrate({ taskId, targetBranch, actor, verify, snapshot })` — see [Merge to stable](#merge-to-stable) for `verify`, `snapshot`, and the four outcomes. Nothing already completed (the recorded trial approval, a snapshot or rebase left on the worktree, a started repair campaign) is rolled back on a later failure.

-----

<a id="the-eight-step-sequence"></a>
## The eight-step sequence

After the single approval, `self_development_propose` drives the facade through exactly these steps, in order, stopping at the first failure:

1. **Workspace** — with a workspaces service mounted, first a reclamation sweep, then `allocate({ taskId, projectRoot: stableRepo })`; without one, the pre-existing `<experimentsRoot>/<taskId>` directory (refused if it does not exist). The sweep (`src/cleanup.ts`) lists every registered workspace and releases the finished ones so a slot never stays taken by done work: a task whose status is `stopped`, or one that is `awaiting-trial` with a clean worktree whose HEAD the target branch already contains (`git merge-base --is-ancestor`, i.e. merged by an earlier `self_development_merge` whose own release did not happen). A task whose status cannot be read, or that is `attempting`, `ready`, or awaiting an approval, is never touched — a fresh allocation is clean and at the target tip too, and only the status tells them apart. An open trial on a reclaimed worktree is closed first. The sweep's release details, when any, are the `reclaim` step; an allocation that still fails reports the workspaces service's own message (`workspace allocation failed: <message>`).
2. **Acceptance write** — the validated acceptance definition to `<controlDirectory>/acceptance/<taskId>.json` (atomic write, mode 0600 inside a 0700 directory).
3. **`createTask(spec, 0, launchProfile)`** — `launchProfile` carries `worktree`, `acceptancePath`, and `confirmedBy`, plus `dataHome` when the workspaces service allocated one (workspace allocation always includes a data home; the pre-existing-directory fallback never does).
4. **`authorizePlanning`**
5. **`submitPlanDraft`**
6. **`confirmPlan`**
7. **`approveBudget`** — the `budget` field maps to the facade's wire form; the `unlimited` preset carries both the `preset: 'unlimited'` marker and its expanded fields (`durationMs: 24h, noProgressAttemptLimit: 5` — no step/call cap, no per-phase cap, no token cap), so the call stays valid against the facade both before and after DH-a's wire change lands. A `rounds` budget instead carries the core-required per-attempt bounds (`phaseTimeoutMs: 6h, maxStepsPerAttempt: 1000`) so one round cannot hide unbounded work.
8. **`startCampaign(taskId, rev, { unattended, acceptedBy })`** — starts the unattended (or per-round) campaign loop; its returned `CampaignState` is the proposal's `campaign` field on success.

Two bookkeeping steps precede these eight in the returned `steps[]` trail — `approval` (the granted approval) and `baseline` (the read `stableBaselineDigest`) — giving five additional named checkpoints for diagnosing a partial failure, beyond the eight facade-affecting operations above.

-----

<a id="task-id-and-baseline-digest"></a>
## Task id and baseline digest

`taskId` is derived from the requirement: the first four whitespace-separated words, lowercased, each reduced to `[a-z0-9]` (a token that becomes empty — e.g. all-CJK or all-punctuation — is dropped, and an all-dropped requirement falls back to the literal stem `task`), joined with `-`, plus a random 6-hex-character suffix — e.g. `add-json-flag-a1b2c3`. `stableBaselineDigest` is `sha256` of the trimmed stdout of `git rev-parse HEAD` run in `stableRepo`, read fresh for every proposal so the campaign's declared baseline is exactly the stable branch's tip at proposal time.

-----

<a id="campaign-result-notices"></a>
## Campaign result notices

When the optional events service is mounted — at construction, or whenever it mounts later: the subscription is taken on the `internal/service` notification for `selfDevelopmentEvents` and re-taken if the service is re-provided, since plugin activation order is not overlay row order and a field test lost every notice to a subscription attempted only once at construction — this package subscribes to it and keeps a bounded, in-memory record of the live `NotifiableAgent` (the mechanism mirrors `@deepseek-ai/dsh-tool-jobs`'s background-job completion delivery: `Agent.followup`/`Agent.inject`, sourced `{ kind: 'plugin', form: 'notice' }`) that proposed each still-open task. When a settled-campaign event arrives for a task this process still has an agent recorded for — the events service publishes it under `origin: 'campaign'` with kind `awaiting-trial` (passed) or `failed`/`stopped` (ended); a single round's `commit`-origin event of the same kind, and a `merge`-origin event, are ignored — it delivers a one-line bilingual chat notice — a follow-up turn for an idle agent, an injected context for a busy one — and consumes the registry entry. `self_development_status`'s `latestEvent` field is updated for every such event regardless of whether a chat notice could be delivered.

-----

<a id="self-iterate-mode"></a>
## Self-iterate mode

An opt-in [agent preset](../../preset/agent-presets/README.md) at `presets/self-iterate/` in this package, **not** bundled inside `@deepseek-ai/dsh-agent-presets`'s own shipped set — a deployment must add this directory as a root before the preset picker offers it.

**Enable it**: point an `agent-presets` config's `roots` at this directory (`packages/workflow/workflow-self-development-chat/presets`, `trust: 'system'`); `packages/bundle/web-app/overlays/self-development.overlay.yml` carries a ready-to-adjust patch. The three `self_development_*` tools do not need a row of their own in the preset — they come from wherever the composition already mounts `selfDevelopmentChat` (they register on the shared tools registry every preset reads from).

**Includes**: the `@deepseek-ai/dsh-persona` row frames the mode (`complete: false`, so this package's own [guidance section](#model-experience) and every other registered prompt section still assemble too; `includeRuntimeContext: true`, unlike the shipped `minimal` preset, because drafting a correct acceptance case benefits from seeing current repository state); `@deepseek-ai/dsh-agent-instructions` for project-level instructions; `@deepseek-ai/dsh-tool-fs-search` as read-only repository search, so the agent can read code while drafting acceptance cases.

**Excludes**: no file-editing tool (`tool-fs`, `tool-str-replace-editor`) and no shell or terminal tool (`tool-bash`, `tool-pwsh`, and their persistent/terminal forms) — every workspace change goes through `self_development_propose` and the campaign it starts, never through this session directly.

-----

<a id="merge-to-stable"></a>
## Merge to stable

Before anything else — including the approval card — `self_development_merge` checks whether there is anything to merge at all: if the resolved task's worktree has no uncommitted changes *and* its branch HEAD already equals `targetBranch`'s own tip (task worktrees share the stable repository's refs, so `targetBranch` resolves from inside them too), it returns `{ ok: false, reason: 'nothing to merge' }` without asking. Any failure in that check itself — no launch profile yet, an unreadable worktree, an unresolvable branch — fails open into the normal attempt below rather than blocking it.

`self_development_merge` drives the workspaces service's `integrate({ taskId, targetBranch, actor, verify, snapshot })` (DI-a frozen interface), passing a `verify(worktree)` this package builds from two steps, run in order, either of which stops the sequence:

1. **Runner acceptance verification** — the `selfDevelopmentRunner` service's `verifyAcceptance(worktree, acceptancePath, { phaseTimeoutMs })` method (the runner supplies its own `experimentsRoot` and `killGraceMs`; the 20-minute gate deadline is the only option passed): the same acceptance definition re-checked by an independent process, not the model, on the (possibly rebased) merged worktree. The runner answers `{ ok: true, report }` for any run that completed — assertion failures live inside the report, never as its own failure — so this package judges the report itself: every assertion of every case must be `pass`, and the run must have neither timed out nor been cancelled; anything else becomes a `verification-failed` reason listing the failed assertions (`acceptance failed (exit code 1): case smoke: stdout fail`). A definition the runner could not run at all (`{ ok: false, reason }`) fails with `acceptance could not be run: <reason>`.
2. **Integration gates** — every command in the configured `integrationGates`, in order, each run with `sh -c` inside the worktree, killed after 20 minutes; a non-zero exit or the timeout fails closed with a reason naming the command and an excerpt of its combined stdout/stderr: bundler timing chatter (`[PLUGIN_TIMINGS]`) and blank lines are dropped, the lines that name an error (`error`, `failed`, `TS1234`, `✖`) are kept alone when there are any, and the result is cut to its last 2 KB — a field test's typecheck failure had otherwise arrived as 2 KB of timing warnings with the one `error TS2741` line scrolled off above them.

`snapshot` is `{ message: 'selfdev(<taskId>): <requirement's first line, capped at 72 characters>', author: commitIdentity }` (just `selfdev(<taskId>)` when the task's requirement is not on hand). When the task worktree has uncommitted changes — an experimental agent's work left uncommitted — `integrate` stages and commits them with this message and author *before* rebasing, so a merge can never silently discard them; a clean worktree makes no snapshot commit. Either way, `integrate` calls `verify` after a rebase (if the target branch moved) and before the fast-forward, whether or not the base moved. It settles on one of four outcomes:

| Status | Meaning | This package's reaction |
|---|---|---|
| `integrated` | Fast-forwarded; `commit`, `baseMoved`, and (when a snapshot was made) `snapshotCommit` reported. | Emits `merge-integrated`; releases the task's worktree (below); runs the configured [upgrade](#upgrade) unless `upgrade.kind` is `none`. |
| `conflict` | The rebase could not apply cleanly; `files` names the conflicts. | Emits `merge-blocked`; releases the blocked worktree and auto-starts an unattended repair campaign (below). Nothing is fast-forwarded. |
| `verification-failed` | `verify` failed after a rebase (or on an unmoved base). | Same release-and-repair reaction as `conflict`. |
| `failed` | The facade itself could not complete the operation. | Emits `merge-blocked`; reported, no repair campaign — this is not a code-fixable failure. |

Each "emits" above is two Cordis events, not one: this package's own `self-development-chat/merge-integrated`/`self-development-chat/merge-blocked` (`{ taskId, commit, baseMoved, occurredAt, revision, snapshotCommit? }` / `{ taskId, status, occurredAt, revision, files?, reason? }`, declared in `src/index.ts`), and `self-development/merge-integrated`/`self-development/merge-blocked` (`{ taskId, revision }` / `{ taskId, status, revision }`, `revision` from `recordTrialApproval`'s result) — the name and shape `@deepseek-ai/dsh-workflow-self-development-events` actually subscribes to, folding into its unified notification (`Task integrated into stable` / `Merge blocked: <status>`). `snapshotCommit` is local to this package's own event; the upstream event's payload is exactly what DI-a declared for it, nothing more.

**Workspace release**: a task worktree holds one of the workspaces service's `maxConcurrentTasks` slots until something releases it, and neither the core nor the workspaces service knows when a worktree stopped mattering — so this package decides. On `integrated`, right after the fast-forward and before the upgrade (whose restart would cut it short), the merged task's worktree and data home are released through `workspaces.release(taskId)`, after `closeTrial(taskId)` when the trial service reports an instance on it; the result line ends with `; workspace of <taskId> released` (or `(trial instance closed)`), and a release that fails is a `release` step detail, never a merge failure. On `conflict`/`verification-failed` the blocked worktree is released the same way *before* the repair campaign starts: the repair is a new task in a fresh worktree off the current stable tip (it never reads the blocked worktree), and releasing first keeps the slot free for it. A merged or superseded task keeps its `awaiting-trial` status — the core has no merged state — so a repeat `self_development_merge` on it is refused before any card with `has no workspace any more (already merged and released, or reclaimed)`; that check reads the workspaces registry and fails open into the normal attempt if the registry cannot be listed.

**Repair campaign**: for `conflict`/`verification-failed`, this package calls its own proposal orchestration directly — unattended, `{ preset: 'unlimited' }` budget, `allowedModificationScope: ['**']` (the repair fixes the same change, not a newly bounded one), the *same* acceptance definition already written for the blocked task (read back and forwarded verbatim), and a plan derived straight from that definition's own cases so it trivially satisfies plan coverage. The requirement text names the target branch and the conflicted files, or the verification failure reason. Critically, it **skips a second approval card**: the merge card already disclosed that a conflict or verification failure starts a repair campaign, so asking again would be redundant. The repair is a brand-new task (its own id), not a continuation of the blocked one.

-----

<a id="upgrade"></a>
## Upgrade

After an `integrated` result, `self_development_merge` runs the deployment's configured `upgrade` strategy:

- **`{ kind: 'none' }`** (default) — no command runs at all. The right choice when the tasks merged here are not this deployment's own source (for example, a demo repository whose "stable version" is unrelated to the process running this chat).
- **`{ kind: 'source', projectRoot, restartCommand, installIfLockfileChanged? }`** — for a stable version that runs from source, which is this deployment's own case: `git merge --ff-only <targetBranch>` in `projectRoot` (a no-op, still exit 0, when `integrate` already fast-forwarded that same worktree); `pnpm install --offline --frozen-lockfile` only when the merge changed `projectRoot`'s `pnpm-lock.yaml` (`installIfLockfileChanged: false` never installs, regardless); `pnpm run --silent build`; then `restartCommand` detached (`spawn(..., { detached: true, stdio: 'ignore' })`, `unref()`) so it outlives this process. Two seconds after that — long enough for the tool result to reach the chat — this process exits. A failure at any step (merge, install, or build) is reported and stops before the restart; nothing already done is undone.
- **`{ kind: 'launcher', dshUpgradeBin }`** — spawns `dshUpgradeBin upgrade --task <taskId>` detached, for the packaged (Swift-shell) deployment's own upgrade tool. Interface and documentation only this wave; not field-tested — see [Known Limitations](#known-limitations-and-deferred-work).

-----

No runtime invariant companion is published: the service exposes no runtime observation stream of its own, and the relationships it owns — one approval request per proposal or merge, the eight-step order, and one notice per campaign or merge result — are covered by focused behavior tests against stand-in seams.

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

This package registers a fixed `systemPrompt` section (`tool:self-development`, `src/guidance.ts`) whenever `selfDevelopmentChat` is mounted with a `systemPrompt` service present and `guidance` is not `false` (`guidance` defaults to `true`). Without a mounted `systemPrompt` service the section is skipped and logged at `debug`; setting `guidance: false` skips it without logging, for a deployment that composes its own guidance instead. A chat-side field test showed a model reach for its own file-editing and shell tools instead of proposing when this guidance was only README prose that nothing ever injected — the exact registered text:

##### Self-development guidance

```markdown
When the user asks for a change to be made on the trial branch (not this
stable session), use the self-development tools instead of editing files
yourself:

1. Ask — in one ordinary message, not a tool call — for the three choices the
   approval card will show, unless the user already stated them: unattended
   (default yes), parallel (default yes, multiple campaigns may run), and
   budget (a round count, a time limit in hours capped at 24, or "unlimited"
   for the 24-hour default).
2. Draft the acceptance cases and the acceptance definition (commands and
   assertions a trusted runner can execute mechanically) from the
   requirement before calling any tool.
3. Call self_development_propose with the drafted requirement, scope, plan,
   acceptance definition, and the budget/unattended/parallel choices. This
   shows the user one approval card; you must never claim it was approved,
   guess at the outcome, or retry as though it were — wait for the tool
   result.
4. Use self_development_status to check progress or report evidence paths,
   and self_development_stop only when the user asks to stop.
5. When the user says the change should go live, or asks to merge it to
   stable, call self_development_merge (it defaults to the most recently
   proposed task when none is named). This shows one more approval card,
   which also covers the automatic repair campaign a conflict or
   verification failure would start — do not expect or wait for a second one.

Never call these tools without the user having asked for a change on the
trial branch, and never fill in placeholder or guessed acceptance commands
just to get past validation.

When the user asks for a change on the trial branch, do NOT edit files in
this workspace yourself and do NOT run the tests yourself; propose it with
self_development_propose and stop after the tool result.
```

#### Token effect

Small fixed input cost per request while the section is registered.

#### KV Cache effect

Prefix-stable while the section is registered and its text is unchanged. Mounting, unmounting, or toggling `guidance` invalidates reuse from this prompt section.

### Tool calls

#### What the model sees

The `self_development_propose`, `self_development_status`, `self_development_stop`, and `self_development_merge` tool definitions registered in `src/index.ts` (`ctx.tools.register(defineTool({...}))`) while `selfDevelopmentChat` is mounted, with the parameter and result shapes documented earlier in this page.

#### Token effect

Fixed schema cost on each request where the four tools are visible; `self_development_propose`'s schema is the largest, since it carries the full acceptance-definition shape.

#### KV Cache effect

Prefix-stable while tool definitions and visibility are unchanged. Mounting or unmounting the plugin invalidates reuse from the first changed schema token.

### Results and notices

#### What the model sees

`self_development_propose` returns `{ ok: true, taskId, workspace, baselineDigest, steps, campaign }` on success or `{ ok: false, steps, reason, error? }` on failure. `self_development_status` returns the task and campaign summary; `self_development_stop` returns `{ ok: true, campaign }` or `{ ok: false, reason, error? }`. `self_development_merge` returns `{ ok: true, taskId, steps, result, repair?, upgrade? }` — `result` is the facade's `integrated`/`conflict`/`verification-failed`/`failed` outcome, `repair` is the auto-started campaign's own outcome when present, and `upgrade` is the post-integration upgrade's outcome when one ran — or `{ ok: false, steps, reason, error? }` before any of that was reached. When a campaign settles, the proposing agent receives a one-line bilingual notice pointing back at `self_development_status` — a follow-up turn if it is idle, an injected context if it is busy.

#### Token effect

Results stay in parent history until compaction. A settlement notice for an idle agent also buys an unplanned follow-up turn; one for a busy agent adds a step to the turn already running.

#### KV Cache effect

Append-only; newly visible results and notices follow the reusable request prefix and do not invalidate existing KV Cache entries.

## Known Limitations and Deferred Work

- **No OS isolation** — this package does not implement, request, or claim process or filesystem isolation for the campaign it starts; the approval card's "no OS isolation" line and DH-a's `PresenceAcknowledgement` carry the honest claim. Unattended operation here means one approval instead of one per round, nothing more.
- **Never clicks "allow" itself** — every proposal shows exactly one real `ctx.approval.request`; there is no path in this package that fabricates, infers, or bypasses that decision.
- **Campaign-result chat notices are in-memory and best-effort** — the proposing-agent registry lives in this process only and is lost on restart; this mirrors DH-a's own campaign-state reset on restart (a `running` campaign is marked `stopped` with reason `process restarted`), so nothing is lost that DH-a itself would have kept. An agent whose session has since ended is silently skipped. `self_development_status` polling is the reliable path regardless of whether a notice was delivered.
- **Notice delivery depends on the events service's own listener fault-tolerance** — `deliverCampaignNotice` runs synchronously inside the events service's subscriber callback and does not itself catch delivery failures; it relies on the upstream events service wrapping each listener in try/catch (as `@deepseek-ai/dsh-workflow-self-development-events` does today) so one failing notice cannot break delivery to other subscribers or the events service's own bookkeeping. A future events source that does not offer this fault-tolerance could let a delivery failure (for example, a throwing `Agent.followup`/`Agent.inject`) propagate out of the subscription.
- **A stopped task's worktree lingers until the next proposal** — `self_development_stop` does not release the worktree it stops (an operator may still want to look at it); the next `self_development_propose` reclaims it, so the slot is only ever held between a stop and the next proposal.
- **The pre-existing-directory workspace fallback does not allocate anything** — without a workspaces service, `self_development_propose` only checks that `<experimentsRoot>/<taskId>` already exists; nothing creates, seeds, or isolates it.
- **No trial-URL access without DH-c** — `self_development_status`'s `trialUrl` field stays empty until a `selfDevelopmentTrial` service is mounted and reports a running instance; while that service lists the task's open as in flight (`pending()`), the report carries `trialState: 'building'` and the result line says the instance is still building, since a trial build takes minutes after the campaign passes.
- **`parallel: false` is a courtesy pre-check, not the enforcement boundary** — it reads each known task's `campaign()` state before asking for approval, but a failed status read is treated as "not running" (fails open) rather than blocking the proposal; the authoritative limit is DH-a's own `maxConcurrentCampaigns` rejection on `startCampaign`.
- **Only the campaign's operator surface, not the trial version experience** — DH-c's trial-instance URL is read, not opened; nothing in this package serves or proxies the trial version itself.
- **`self_development_merge` is host-only by convention, not by enforcement** — this repository has no runtime signal that distinguishes "the acting process is the deployment being upgraded" from any other caller; there is no `ctx.get`-able caller-identity port to gate on (the codebase's only host-vs-phone distinction lives in the Remote facade's own field-level `assertCallerIsHost` check, which does not extend to Agent tool calls). The approval card's wording is the only safeguard today.
- **Source-tree upgrade only makes sense for this deployment's own repository** — `upgrade.kind: 'source'` runs `git`/`pnpm`/the restart command against `upgrade.projectRoot`; a deployment whose tasks fork from a different repository than the one it runs from (for example, a demo repository used only to exercise campaigns) should configure `{ kind: 'none' }`, or the "upgrade" would rebuild and restart the wrong tree.
- **A browser session does not auto-reconnect after the restart** — the chat result names an estimated wait, but nothing here pushes a reload; the user (or the client shell) still has to refresh once the stable version is back.
- **The repair campaign's modification scope is intentionally broad** — `allowedModificationScope: ['**']`, since a rebase conflict or a post-rebase verification failure can touch any file the original change touched and this package does not have the original task's own scope on hand to narrow it.
- **`upgrade.kind: 'launcher'` is interface and documentation only this wave** — it spawns `dshUpgradeBin upgrade --task <taskId>` detached and reports success once spawned, but the packaged launcher side of this handoff has not been field-tested.
- **Nothing is rolled back** — a merge, a repair-campaign start, or an upgrade step that fails after earlier steps succeeded (recorded trial approval, a rebase left on the worktree, an install or build already run) leaves all of that in place for triage, the same convention `self_development_propose` already uses.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
