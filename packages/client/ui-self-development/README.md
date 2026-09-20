---
description: "Stable-side self-development task UI: task list, confirmation card, per-round evidence timeline, and the explicit human authorization buttons in one right-Sidebar tab and one Settings section."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-self-development

English | [中文](README.zh.md)

## Summary

This package renders the stable side of the self-development workflow in the Web client: one right-Sidebar tab titled **Self-development tasks** and one Settings section, both showing the same panel. The panel lists tasks with status badges and revisions, renders the confirmation card's fixed wording verbatim, draws the per-round evidence timeline, and offers exactly the six human authorization actions. Authorization originates only from these buttons; ordinary chat never creates one.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The tab and the Settings section render the same panel and share one state. Without a selected task the panel shows the task list; selecting a task shows the confirmation card (every field, the fixed wording exactly as the facade supplies it), the projection summary (revision, consumed budget, current attempt, verified-result digest, stop and handoff reasons), the authorization buttons the status allows, the per-round evidence timeline, and the experiment-build paths.

### Enabling the surface

The default web bundle ships none of this: the panel row is not in the roster and the host services are not loaded, so no self-development tab or Settings section exists. To enable the whole seam, start the web surface with the bundled overlay, which loads the host task-control service, the supervised runner, the notification consumer, the Remote facade (`enabled: true`, empty `allowedActors`), and the browser panel row together:

```sh
dsh web --patch node_modules/@deepseek-ai/dsh-web-app/overlays/self-development.overlay.yml
```

Replace the overlay's placeholder paths with this deployment's directories before use; each host package's README documents its own fields. Removing the overlay removes the tab and the services in the same step.

### Buttons and remote methods

Every write requires a second confirmation dialog with an acknowledgement checkbox before the call goes out.

| Button | Status that offers it | Remote method |
| --- | --- | --- |
| New task | always (form above the list) | `createTask` |
| Submit plan draft | planning-authorized (form: case rows plus manual cases) | `submitPlanDraft` |
| Authorize planning | draft | `authorizePlanning` |
| Confirm plan | awaiting plan confirmation (shows the automated and manual cases first) | `confirmPlan` |
| Approve budget | awaiting development approval (explicit form: mode, rounds, time, phase timeout, steps, no-progress limit) | `approveBudget` |
| Start one round | ready or attempting | `runAttempt` |
| Stop | any running state | `stop` |
| Record trial approval | awaiting trial, bound to the verified result; disabled with the approver named once one exists | `recordTrialApproval` |
| Save as profile | launch section of a task without a profile | `setLaunchProfile` |

### One-click launch and the launch profile

The **Start one round** area derives its fields from the task's stored launch profile (`card.launchProfile`): the default view is four read-only rows (worktree, artifact paths, acceptance definition path, confirmed-by) plus the budget, the presence checkbox, and one button. Checking the presence box is the only input a launch needs; the confirm dialog lists the four effective values and the budget, and the request then carries only `taskId`, `expectedRevision`, and `presenceAcknowledged: true`. The **Advanced (override profile)** area keeps the five free-form inputs for overriding the profile value by value; a filled override is the only extra field the request carries. When the task has no launch profile the advanced area opens by itself with a hint, and **Save as profile** stores the filled fields through `setLaunchProfile`.

### New task and plan draft forms

**New task** opens a form above the list: requirement, allowed modification scope (comma-separated), stable baseline digest (64-digit hex — take the sha256 of the current HEAD), and the creator, who is remembered in this browser and prefilled next time. The optional launch profile (worktree, acceptance definition path, artifact paths) becomes the third `createTask` argument when filled. **Submit plan draft** appears while the task is planning-authorized: case rows (case id, requirement, comma-separated assertion ids) can be added and removed, manual cases are a comma-separated list, and a half-typed row is dropped instead of submitted.

### Not enabled, and the phone whitelist

When the composition does not load the generated `selfDevelopmentRemote` namespace, the panel renders a not-enabled view instead of failing; ordinary chat compositions never create an authorization. On a phone (a non-loopback Host connection) the whitelist keeps every read and every whitelisted authorization button, hides the experiment and evidence paths behind one notice, replaces the launch section with the host-only notice (`self-development/host-only-field` wording: view, confirm, and stop only), and never renders the profile forms' host-only fields.

### Per-round evidence

The timeline reads the Remote facade's `recentEvents`, the events consumer's title-level recent buffer, on every list refresh and reload; there is no separate live subscription and no second event source on the wire.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser half registers the page-type right-Sidebar tab (type definition plus the keyed `sidebar.right.pane.tab` body) and one `settings.section` seat; both render `SelfDevelopmentPanel` through the same inject face. The generated `selfDevelopmentRemote` namespace is mounted by the `@deepseek-ai/dsh-api-remotes` Client assembly's mount list; the plugin reads it through a readiness fiber that stays pending while the composition does not provide it and flips a registrant-private availability fact through the inject `hooks` compartment. `status.ts` holds the single status-to-button matrix; the panel renders exactly those actions, so there is no upgrade action to hide. `wire.ts` builds each request from form text and renders the facade's error-code vocabulary; the facade re-validates every request at the wire boundary. All copy lives in the typed `locales.ts` dictionary; the stylesheet keeps one column at 480px and narrower.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Self-development remote facade](../../workflow/workflow-self-development-remote/README.md)
- [Self-development events](../../workflow/workflow-self-development-events/README.md)
- [Web Client architecture](../../../docs/subsystems/web-client.md)

<a id="model-experience"></a>
## Model Experience

### User-driven authorization panel

#### What the model sees

Nothing; the panel renders task state the workflow core already logged and collects human authorizations through the `runAttempt`, `stop`, and related `selfDevelopment` Remote methods.

#### Token effect

None; the panel sends no provider request and adds no model-visible content.

#### KV Cache effect

None; the panel talks to the Host over the existing Remote facade and adds no new model-visible surface.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Upgrade approval is not part of this panel; no upgrade button exists here or on the remote facade, and the panel must not grow one.
- `presenceAcknowledged` has no default: the request carries `true` only because the dialog's acknowledgement checkbox was checked, and the facade rejects the request otherwise.
- The panel renders what the facade reports; it does not poll tasks beyond its own reload button.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No runtime invariant companion is published. The panel renders two opt-in host faces it does not own and asserts no independently observable relationship between them.

</details>
