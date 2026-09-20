---
description: "Chat-side self-development launcher: Agent tools that draft a task, ask the user exactly one approval, and on approval automatically drive the stable-side facade through workspace allocation, acceptance writing, planning, budget, and an unattended campaign, then project the result back into chat."
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development-chat

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

Lets a user launch a self-development campaign from an ordinary chat message. `self_development_propose` drafts the requirement, acceptance cases, and budget, shows one approval card naming everything it covers, and on `allowed-once` drives the stable-side facade from workspace allocation through task creation, planning, and budget approval to the campaign start. `self_development_status` reports progress; `self_development_stop` ends a running campaign. On settlement, this package best-effort-delivers the result as a chat message to the proposing agent. It implements no isolation and never approves on the user's behalf — see [Known Limitations](#known-limitations-and-deferred-work).

## Table of Contents

- [Service](#service)
- [Tools](#tools)
- [The eight-step sequence](#the-eight-step-sequence)
- [Task id and baseline digest](#task-id-and-baseline-digest)
- [Campaign result notices](#campaign-result-notices)
- [Self-iterate mode](#self-iterate-mode)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="service"></a>
## Service

`SelfDevelopmentChat` (default export, Cordis service `selfDevelopmentChat`) declares `tools` and `approval` as hard injections — the plugin does not load without a tool registry and an approval answerer. The stable-side facade, the workspaces service, the events service, and the trial service are all read structurally with `ctx.get(...)` rather than declared as typed injections, because this package is developed against the DH-a/DH-c frozen interfaces before their packages exist in every worktree; at integration the real services satisfy the same structural shapes.

| Config field | Meaning |
|---|---|
| `stableRepo` | Absolute path of the repository whose stable-branch `HEAD` seeds `stableBaselineDigest`. |
| `controlDirectory` | Absolute directory this package writes acceptance definitions into (`<controlDirectory>/acceptance/<taskId>.json`, mode 0600 inside a 0700 directory); also the base of the derived `<controlDirectory>/campaigns/<taskId>.json` path reported by `self_development_status`. Must resolve outside `experimentsRoot` — the runner refuses to judge an acceptance definition placed inside the experiments root, so a nested `controlDirectory` fails every campaign round closed; checked (via `realpath`) at plugin construction and again before every proposal. |
| `experimentsRoot` | Absolute experiments root used to resolve a task's workspace when no workspaces service is mounted: the fallback requires `<experimentsRoot>/<taskId>` to already exist. |
| `actor` | Human actor recorded as the task creator, plan confirmer, budget approver, and unattended-campaign acceptor. |
| `cardLocale` | `'zh'` (default) or `'en'`: the language of the approval-card copy and the campaign-result chat notice. |
| `defaultBudget` | Budget used when a proposal omits one; defaults to `{ preset: 'unlimited' }`. Validated at construction — an invalid explicit value fails the mount. |
| `defaultUnattended` | Unattended default when a proposal omits it; defaults to `true`. |
| `guidance` | Register the self-development guidance `systemPrompt` section (see [Model Experience](#model-experience)); defaults to `true`. |

Ports read from the context (all but `approval` optional):

| Port | Context key | Behavior when absent |
|---|---|---|
| Remote facade | `selfDevelopmentRemote` | Every tool call fails with `facade` errors; in practice the plugin should not be composed without it. |
| Approval | `approval` | Hard injection: the plugin fails to load. |
| Workspaces | `selfDevelopmentWorkspaces` | `self_development_propose` falls back to an already-existing `<experimentsRoot>/<taskId>` directory and refuses a missing one. |
| Events | `selfDevelopmentEvents` | No campaign-result chat notice is ever delivered; `self_development_status`'s `latestEvent` field is never populated. |
| System prompt | `systemPrompt` | The self-development guidance section is not registered (logged at `debug`); the model sees no built-in instruction to prefer `self_development_propose` over editing the trial branch itself. |
| Trial (DH-c) | `selfDevelopmentTrial` | `self_development_status`'s `trialUrl` field is never populated. |

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
| `budget` | `{ preset: 'unlimited' }` (24h time cap), `{ mode: 'rounds', maxRounds }`, or `{ mode: 'time', hours }` (`hours` ≤ 24, rejected otherwise). |
| `unattended` | Whether one approval covers every campaign round. |
| `parallel` | `false` refuses the proposal while another campaign this process started is still running. |

Behavior: validates the input (including the acceptance definition against the plan's required cases, and the budget's `hours ≤ 24` ceiling — the tool parameter schema has no numeric-bound keyword, so this is enforced in code, the same pattern `tool-bash` uses for its own value constraints beyond its schema); when `parallel` is `false`, checks every task id this process has started for a running campaign and refuses early if one is found — before the user is ever asked; then shows **one** approval card (`ctx.approval.request`) naming the requirement, the acceptance cases, the budget, the unattended choice, and the workspace. Only `allowed-once` proceeds — every other outcome (`rejected`, `cancelled`, `unavailable`) makes no facade call at all and returns `{ ok: false, reason }`. On approval, the steps in [the eight-step sequence](#the-eight-step-sequence) run in order; a failure at any step stops the sequence and returns the steps completed so far, the failure reason, and (when available) a machine-routable error code. Nothing already written is rolled back: the worktree, the acceptance-definition file, and any task journal entries already committed stay in place for triage.

### `self_development_status`

Parameters: `{ taskId }`. Returns the task's control-state summary (status, revision, requirement, consumed rounds/time, planning-authorized, no-progress count), the campaign state (rounds, last outcome, reason, acknowledgement) when one exists, the derived paths (worktree and acceptance path from the launch profile when set, plus the always-present acceptance-definition and campaign-record paths), the trial URL when the trial service reports a running instance for the task, and the most recent `campaign-passed`/`campaign-ended` event this process observed for the task. A facade failure (e.g. an unknown task id) yields `{ ok: false, reason, error }`.

### `self_development_stop`

Parameters: `{ taskId, reason }`. Forwards to the facade's `stopCampaign(taskId, reason)` and returns the resulting campaign state, or `{ ok: false, reason, error }` on refusal.

-----

<a id="the-eight-step-sequence"></a>
## The eight-step sequence

After the single approval, `self_development_propose` drives the facade through exactly these steps, in order, stopping at the first failure:

1. **Workspace** — with a workspaces service mounted, `allocate({ taskId, projectRoot: stableRepo })`; without one, the pre-existing `<experimentsRoot>/<taskId>` directory (refused if it does not exist).
2. **Acceptance write** — the validated acceptance definition to `<controlDirectory>/acceptance/<taskId>.json` (atomic write, mode 0600 inside a 0700 directory).
3. **`createTask(spec, 0, launchProfile)`** — `launchProfile` carries `worktree`, `acceptancePath`, and `confirmedBy`, plus `dataHome` when the workspaces service allocated one (workspace allocation always includes a data home; the pre-existing-directory fallback never does).
4. **`authorizePlanning`**
5. **`submitPlanDraft`**
6. **`confirmPlan`**
7. **`approveBudget`** — the `budget` field maps to the facade's wire form; the `unlimited` preset carries both the `preset: 'unlimited'` marker and its expanded fields (`durationMs: 24h, phaseTimeoutMs: 600000, maxStepsPerAttempt: 40, noProgressAttemptLimit: 5`), so the call stays valid against the facade both before and after DH-a's wire change lands.
8. **`startCampaign(taskId, rev, { unattended, acceptedBy })`** — starts the unattended (or per-round) campaign loop; its returned `CampaignState` is the proposal's `campaign` field on success.

Two bookkeeping steps precede these eight in the returned `steps[]` trail — `approval` (the granted approval) and `baseline` (the read `stableBaselineDigest`) — giving five additional named checkpoints for diagnosing a partial failure, beyond the eight facade-affecting operations above.

-----

<a id="task-id-and-baseline-digest"></a>
## Task id and baseline digest

`taskId` is derived from the requirement: the first four whitespace-separated words, lowercased, each reduced to `[a-z0-9]` (a token that becomes empty — e.g. all-CJK or all-punctuation — is dropped, and an all-dropped requirement falls back to the literal stem `task`), joined with `-`, plus a random 6-hex-character suffix — e.g. `add-json-flag-a1b2c3`. `stableBaselineDigest` is `sha256` of the trimmed stdout of `git rev-parse HEAD` run in `stableRepo`, read fresh for every proposal so the campaign's declared baseline is exactly the stable branch's tip at proposal time.

-----

<a id="campaign-result-notices"></a>
## Campaign result notices

When the optional events service is mounted, this package subscribes to it and keeps a bounded, in-memory record of the live `NotifiableAgent` (the mechanism mirrors `@deepseek-ai/dsh-tool-jobs`'s background-job completion delivery: `Agent.followup`/`Agent.inject`, sourced `{ kind: 'plugin', form: 'notice' }`) that proposed each still-open task. When a `campaign-passed` or `campaign-ended` event arrives for a task this process still has an agent recorded for, it delivers a one-line bilingual chat notice — a follow-up turn for an idle agent, an injected context for a busy one — and consumes the registry entry. `self_development_status`'s `latestEvent` field is updated for every such event regardless of whether a chat notice could be delivered.

-----

<a id="self-iterate-mode"></a>
## Self-iterate mode

An opt-in [agent preset](../../preset/agent-presets/README.md) at `presets/self-iterate/` in this package, **not** bundled inside `@deepseek-ai/dsh-agent-presets`'s own shipped set — a deployment must add this directory as a root before the preset picker offers it.

**Enable it**: point an `agent-presets` config's `roots` at this directory (`packages/workflow/workflow-self-development-chat/presets`, `trust: 'system'`); `packages/bundle/web-app/overlays/self-development.overlay.yml` carries a ready-to-adjust patch. The three `self_development_*` tools do not need a row of their own in the preset — they come from wherever the composition already mounts `selfDevelopmentChat` (they register on the shared tools registry every preset reads from).

**Includes**: the `@deepseek-ai/dsh-persona` row frames the mode (`complete: false`, so this package's own [guidance section](#model-experience) and every other registered prompt section still assemble too; `includeRuntimeContext: true`, unlike the shipped `minimal` preset, because drafting a correct acceptance case benefits from seeing current repository state); `@deepseek-ai/dsh-agent-instructions` for project-level instructions; `@deepseek-ai/dsh-tool-fs-search` as read-only repository search, so the agent can read code while drafting acceptance cases.

**Excludes**: no file-editing tool (`tool-fs`, `tool-str-replace-editor`) and no shell or terminal tool (`tool-bash`, `tool-pwsh`, and their persistent/terminal forms) — every workspace change goes through `self_development_propose` and the campaign it starts, never through this session directly.

-----

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

The `self_development_propose`, `self_development_status`, and `self_development_stop` tool definitions registered in `src/index.ts` (`ctx.tools.register(defineTool({...}))`) while `selfDevelopmentChat` is mounted, with the parameter and result shapes documented earlier in this page.

#### Token effect

Fixed schema cost on each request where the three tools are visible; `self_development_propose`'s schema is the largest, since it carries the full acceptance-definition shape.

#### KV Cache effect

Prefix-stable while tool definitions and visibility are unchanged. Mounting or unmounting the plugin invalidates reuse from the first changed schema token.

### Results and notices

#### What the model sees

`self_development_propose` returns `{ ok: true, taskId, workspace, baselineDigest, steps, campaign }` on success or `{ ok: false, steps, reason, error? }` on failure. `self_development_status` returns the task and campaign summary; `self_development_stop` returns `{ ok: true, campaign }` or `{ ok: false, reason, error? }`. When a campaign settles, the proposing agent receives a one-line bilingual notice pointing back at `self_development_status` — a follow-up turn if it is idle, an injected context if it is busy.

#### Token effect

Results stay in parent history until compaction. A settlement notice for an idle agent also buys an unplanned follow-up turn; one for a busy agent adds a step to the turn already running.

#### KV Cache effect

Append-only; newly visible results and notices follow the reusable request prefix and do not invalidate existing KV Cache entries.

## Known Limitations and Deferred Work

- **No OS isolation** — this package does not implement, request, or claim process or filesystem isolation for the campaign it starts; the approval card's "no OS isolation" line and DH-a's `PresenceAcknowledgement` carry the honest claim. Unattended operation here means one approval instead of one per round, nothing more.
- **Never clicks "allow" itself** — every proposal shows exactly one real `ctx.approval.request`; there is no path in this package that fabricates, infers, or bypasses that decision.
- **Campaign-result chat notices are in-memory and best-effort** — the proposing-agent registry lives in this process only and is lost on restart; this mirrors DH-a's own campaign-state reset on restart (a `running` campaign is marked `stopped` with reason `process restarted`), so nothing is lost that DH-a itself would have kept. An agent whose session has since ended is silently skipped. `self_development_status` polling is the reliable path regardless of whether a notice was delivered.
- **Notice delivery depends on the events service's own listener fault-tolerance** — `deliverCampaignNotice` runs synchronously inside the events service's subscriber callback and does not itself catch delivery failures; it relies on the upstream events service wrapping each listener in try/catch (as `@deepseek-ai/dsh-workflow-self-development-events` does today) so one failing notice cannot break delivery to other subscribers or the events service's own bookkeeping. A future events source that does not offer this fault-tolerance could let a delivery failure (for example, a throwing `Agent.followup`/`Agent.inject`) propagate out of the subscription.
- **The pre-existing-directory workspace fallback does not allocate anything** — without a workspaces service, `self_development_propose` only checks that `<experimentsRoot>/<taskId>` already exists; nothing creates, seeds, or isolates it.
- **No trial-URL access without DH-c** — `self_development_status`'s `trialUrl` field stays empty until a `selfDevelopmentTrial` service is mounted and reports a running instance.
- **`parallel: false` is a courtesy pre-check, not the enforcement boundary** — it reads each known task's `campaign()` state before asking for approval, but a failed status read is treated as "not running" (fails open) rather than blocking the proposal; the authoritative limit is DH-a's own `maxConcurrentCampaigns` rejection on `startCampaign`.
- **Only the campaign's operator surface, not the trial version experience** — DH-c's trial-instance URL is read, not opened; nothing in this package serves or proxies the trial version itself.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
