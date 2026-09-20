---
description: "Opt-in self-development notification projection: unified title-level events folded from durable task commits, an in-memory recent buffer, subscriber callbacks, and an optional macOS local-notification command."
kind: "package-reference"
---

# @deepseek-ai/dsh-workflow-self-development-events

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

Follow self-development task progress without watching the controller: every durable task commit — and every campaign-lifecycle event the Remote facade's unattended campaign loop emits directly — folds into one unified event: a human-decision, trial, failure, or stop notice that you can pull from an in-memory buffer, subscribe to in-process, or post as a macOS local notification through a command you configure. Notifications stay off until you configure a command, and events stay title-level: no paths, credentials, or requirement text. The buffer and subscriptions live in this process only.

## Table of Contents

- [Service](#service)
- [Event model and mapping](#event-model-and-mapping)
- [Local notifications](#local-notifications)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="service"></a>
## Service

`SelfDevelopmentEvents` (default export, Cordis service `selfDevelopmentEvents`) declares `selfDevelopmentTasks` as an injection, so the task-control service loads first. It consumes the core package's `self-development/committed` event, which fires once per durable journal commit. The service registers no tool, prompt, or daemon.

| Method | Contract |
|---|---|
| `recent(limit)` | Returns the retained events, oldest first; at most `limit` of them, or every retained event when `limit` is omitted. |
| `subscribe(listener)` | Invokes `listener` once per event from now on, in commit order, and returns the disposer. The buffer is not replayed to a late subscriber. |

| Config field | Meaning |
|---|---|
| `localNotificationCommand` | Notification command argv, spawned once per event with the event JSON on its stdin. `undefined` — the default — never spawns. |
| `recentLimit` | Events retained in the in-memory buffer; default 200. |

Configuration is validated at construction: an empty argv or a non-positive-integer `recentLimit` fails the mount instead of degrading delivery.

-----

<a id="event-model-and-mapping"></a>
## Event model and mapping

One `SelfDevelopmentEvent` carries `taskId`, `kind`, `sessionId`, `title`, `occurredAt`, and the projection `revision` after the commit. `sessionId` is optional and always `undefined` here: a self-development task is not bound to a chat session, and the optional field keeps the shape consumable by session-bound notification consumers. Every title is a fixed English template: it carries only the round number and a reason from the closed vocabulary, and never the free-text failure reason or handoff detail.

| Durable event | Kind | Title |
|---|---|---|
| `plan/drafted` | `awaiting-decision` | `Plan drafted, awaiting confirmation` |
| `plan/confirmed` | `awaiting-decision` | `Plan confirmed, awaiting development approval` |
| `budget/approved` | `awaiting-decision` | `Budget approved, task ready` |
| `attempt/failed` | `failed` | `Round N failed` |
| `handoff/raised` | `failed` | `Task handed off (<reason>)` |
| `task/passed` | `awaiting-trial` | `Round N passed, awaiting trial` |
| `task/stopped` | `stopped` | `Task stopped (<reason>)` |

`plan/confirmed` and `budget/approved` map through the human-decision status they leave behind (`awaiting-development-approval` and `ready`); every other durable event is controller bookkeeping and maps to nothing. The round number `N` is the consumed round the commit folded in. The `<reason>` in the handoff and stop titles is the durable event's enum value (`journal-corrupted`, `cancelled`, ...); the runner's failure reason text and the handoff detail never enter an event — query the task journal for them. `turn-finished` is reserved for the later finite-loop projection of a round that ends and waits for the next one; today a finished round publishes `failed` instead.

### Campaign events

Two further raw Cordis events map into the same unified vocabulary, declared and folded by this package but emitted by the Remote facade's campaign loop — never by the core, which has no notion of a campaign and never emits them through `self-development/committed`:

| Raw event | Kind | Title |
|---|---|---|
| `self-development/campaign-passed` | `awaiting-trial` | `Task passed, trial ready` |
| `self-development/campaign-ended` | `stopped` when `status: 'stopped'`, otherwise `failed` | `Campaign ended: <status>` |

`campaign-ended`'s `<status>` is the campaign's closed-vocabulary end status (`exhausted`, `stopped`, or `failed`) — never the campaign record's free-text `reason`, which stays inside the Remote facade. `campaign-passed` has no `<status>` interpolation: a pass is always the same fixed title, matching `task/passed`'s own template shape. See [`campaign.ts`](src/campaign.ts) for the payload shapes and the `mapCampaignPassedToEvent`/`mapCampaignEndedToEvent` mapping functions, and the Remote facade's own README for the campaign loop that emits them.

### Merge events

Two further raw Cordis events map into the same unified vocabulary, declared and folded by this package the same way the campaign events are, but emitted by the chat tool that drives the merge-to-stable flow — never by the core, which has no notion of a git integration or a stable-side upgrade:

| Raw event | Kind | Title |
|---|---|---|
| `self-development/merge-integrated` | `awaiting-trial` | `Task integrated into stable` |
| `self-development/merge-blocked` | `failed` | `Merge blocked: <status>` |

`merge-blocked`'s `<status>` is a closed-vocabulary reason owned by the merge flow, not by this package — a `workspaces.integrate` result status (`conflict`, `verification-failed`, `failed`) or a chat-level refusal (for example a task that is not `awaiting-trial`) — never the merge flow's free-text detail (a git failure reason, a gate command's output tail). `merge-integrated` has no `<status>` interpolation: a completed merge is always the same fixed title. See [`merge.ts`](src/merge.ts) for the payload shapes and the `mapMergeIntegratedToEvent`/`mapMergeBlockedToEvent` mapping functions.

-----

<a id="local-notifications"></a>
## Local notifications

When `localNotificationCommand` is configured, the service spawns it once per mapped event, writes one JSON event line on stdin, and expects nothing back. The command runs in its own process group (detached spawn), so the fixed 10-second deadline kill reaches descendants without touching the host's group. Failures — spawn errors, non-zero exits, timeouts — are logged and never retried, and they never reach the buffer or the subscribers. Unloading the service waits for in-flight deliveries.

`examples/macos-notify.sh` is a template, not a shipped command: it parses the event JSON with python3, escapes the fields, and posts one `osascript` notification with the task id as title and the event title as body. No shell ever re-interprets a field, so quotes, backticks, and `$()` in event text stay inert. Review it and point `localNotificationCommand` at your copy.

No runtime invariant companion is published: the package exposes no runtime observation stream of its own, and the relationships it owns — one event per mapped durable commit, the bounded buffer, and one spawn per configured delivery — are covered by focused behavior tests against the real task-control service.

-----

<a id="model-experience"></a>
## Model Experience

None, as the service registers no model-facing tool, prompt, or event: it folds already-durable task commits into title-level human notifications that reach notification centers and in-process listeners, never model requests or Session events.

#### KV Cache effect

None. The service touches no prompt, session, or request path, so KV-cache reuse is unaffected.

## Known Limitations and Deferred Work

- **Events are process-local and never persisted** — the recent buffer and subscriptions live in this process only; after a restart `recent()` returns nothing, and no history is rebuilt from the journals.
- **Late subscribers see nothing** — `subscribe` delivers only events observed after subscribing; a UI that needs the past must read `recent()` at mount.
- **`turn-finished` is reserved, not emitted** — no current mapping produces it, so consumers must not rely on receiving it until the finite-loop projection exists.
- **Failure reasons are not in events** — the runner's failure reason text and the handoff detail stay in the task journal; a notification event carries only the round number and the closed-vocabulary reason, so a consumer that needs the text must read the journal.
- **A campaign a restart recovers as `stopped` fires no event** — the Remote facade's one-time restart scan writes that status directly to the campaign record without emitting `campaign-ended`; a consumer must poll `campaign(taskId)` to notice a campaign a crashed process left running.
- **`merge-integrated` reuses the `awaiting-trial` kind** — the five-value vocabulary has no dedicated "positive, no action needed" kind, and a completed merge leaves no trial actually pending. Consumers should read it as informational, not as a cue to look for a trial; adding a dedicated kind would ripple into every other package that declares this vocabulary (see [`types.ts`](src/types.ts)) and is deferred.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
