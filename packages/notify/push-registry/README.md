---
description: "Opt-in APNs push-notification registry: device-token registration over the authenticated Remote layer, sanitized title-level session-event notifications, a dedupe window with failure dominance, bounded retries, and a stdin-connected outbound command."
kind: "package-reference"
---

# @deepseek-ai/dsh-push-registry

English | [中文](README.zh.md)

<a id="summary"></a>
## Summary

Register iOS device tokens over the authenticated Remote layer and deliver title-level session notifications to them through one deployment-configured outbound command. The service subscribes only to session-controller events that already exist — `api-session/status`, `api-session/error`, and the `approval/request` waterfall — and never spawns anything until an outbound command is configured. Device tokens are stored on disk alone and never logged; delivery records carry no token.

## Table of Contents

- [Service](#service)
- [Events and sanitization](#events-and-sanitization)
- [Delivery, dedupe, and retries](#delivery-dedupe-and-retries)
- [Storage layout](#storage-layout)
- [Example APNs script](#example-apns-script)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="service"></a>
## Service

`PushRegistry` (default export, Cordis service `pushRegistry`) is opt-in: no shipped composition mounts it, and a composition that adds it chooses the registry directory and the outbound command. Authentication is the existing connection layer's — the Typert Gateway only serves authenticated connections, and the package adds no credential check of its own. When the service is absent, the `ctx.get('pushRegistry')` read returns `undefined`.

| Method | Contract |
|---|---|
| `register(req)` | Stores or refreshes one `{ deviceId, platform, token }` registration. Only `platform: 'ios'` is accepted; empty ids or tokens fail loud. Re-registering a device id replaces its token. The token is written to `devices.json` only and never appears in logs or delivery records. |
| `unregister(req)` | Removes the registration for `req.deviceId` and returns whether one existed. |
| `list()` | Returns every registration as `{ deviceId, platform, registeredAt }`; tokens are secret, so views omit them. |

| Config field | Meaning |
|---|---|
| `registryDirectory` | Absolute directory holding `devices.json` and `deliveries.jsonl`; created at construction. Required. |
| `outboundCommand` | Outbound command argv. `undefined` — the default — registers devices without ever spawning a delivery. |
| `outboundTimeoutMs` | Per-attempt outbound deadline; default 15000. |
| `dedupeWindowMs` | Window in which one session emits one notification per kind; default 60000. |
| `maxRetries` | Retry attempts after the first failure, with exponential backoff; default 2. |

Configuration is validated at construction: a relative registry directory, an empty argv, or a non-integer budget fails the mount instead of degrading delivery.

<a id="events-and-sanitization"></a>
## Events and sanitization

The subscription is a fixed set; the package does not generalize over event sources.

| Notification kind | Source event | Title |
|---|---|---|
| `turn-finished` | `api-session/status` with `running: false` | `Turn finished` |
| `turn-failed` | `api-session/error` | `Turn failed` |
| `awaiting-confirmation` | `approval/request` (waterfall; the listener never claims it) | `Approval needed: <toolName>` |

`NotificationEvent` carries only `kind`, `sessionId`, `title`, and `occurredAt`. The session-controller error message is dropped because error chains can quote paths or message content, and the approval notification names only the asked-for tool, which is an identifier from the closed tool catalog. No message body, filesystem path, or tool argument ever reaches the outbound payload.

<a id="delivery-dedupe-and-retries"></a>
## Delivery, dedupe, and retries

The dedupe key is `${sessionId}:${kind}`: inside the window, one session emits one notification per kind, and a failed delivery is recorded but not retried outside the configured attempt budget. A recorded `turn-failed` dominates the window: the paired `turn-finished` of the same failed turn is dropped, so a failed turn cannot notify twice. Kinds are independent apart from that dominance.

Each attempt spawns `outboundCommand`, writes one JSON line on stdin — `{ event, device: { deviceId, platform, token } }` — and expects exit 0 within `outboundTimeoutMs`. The command runs in its own process group (detached spawn), so the timeout kill reaches descendants without touching the host's group. Non-zero exits, spawn errors, and timeouts are the retryable failures; retries wait 250 ms after the first failure and double per attempt. Every attempt budget ends in one `deliveries.jsonl` record with the outcome, attempt count, wall time, and a short failure reason (`exited with code N`, `timed out after N ms`).

Delivery is fire-and-forget: the session-event listeners enqueue work and return immediately, and disposal waits for in-flight fan-outs before the fiber unloads.

<a id="storage-layout"></a>
## Storage layout

`registryDirectory/devices.json` holds the registry document. Writes go through `writeFileAtomic` under the cross-process `devices.json.lock` writer lock, so readers observe either the old or the new complete document and the file carries mode 0600. A malformed or unreadable document fails the next operation loud with `RegistryStoreError`; it is never silently reset. `registryDirectory/deliveries.jsonl` is an append-only log and never contains tokens.

<a id="example-apns-script"></a>
## Example APNs script

`examples/apns-send.example.mjs` is a template, not a shipped command: it reads the `.p8` path, key id, team id, and bundle id from the environment, signs one ES256 JWT, and posts over HTTP/2 — the only protocol the APNs provider API accepts — with `node:http2` to `api.push.apple.com` (`api.sandbox.push.apple.com` when `APNS_ENV=sandbox`). The DER-to-raw signature conversion lives in the importable `examples/der-to-raw.mjs`, pinned by fixed-vector unit tests in `examples/der-to-raw.test.mjs`. The template has not been verified end-to-end against the real APNs service; exercise it against the sandbox host with a real device before production. Review it, provision real secrets outside the repository, and point `outboundCommand` at your copy. Tests use throwaway Node fixture scripts instead.

<a id="model-experience"></a>
## Model Experience

None, as the service registers no model-facing tool, prompt, or event: notifications stay title-level and reach device lock screens, never model requests or Session events.

#### KV Cache effect

None. The service touches no prompt, session, or request path, so KV-cache reuse is unaffected.

## Known Limitations and Deferred Work

- **Coupling to the pre-M4 event model** — the subscription rides three fixed session-controller events. The unified event model (M4) does not exist yet, so new notification-worthy occurrences require editing this package, and `api-session/status` cannot distinguish a finished turn from other idle transitions.
- **Approval requests are observed, not filtered** — every `approval/request` waterfall dispatch notifies, including one an answerer resolves immediately; the listener cannot know whether a human will actually answer. Auto-answered requests therefore produce notifications within the dedupe window.
- **Background-connection dependency** — when a phone has no reachable `dsh web` connection, this push path is the only delivery channel for these notifications, and it depends on the host being up at the moment the event fires. There is no queue: an event observed while the host is down is gone.
- **Windows delivery has no group kill** — the timeout path signals the POSIX process group; on Windows the group stop fails the attempt loud rather than stopping descendants. Registration and register-only operation work everywhere.
- **No device-token lifecycle** — APNs feedback (invalid or expired tokens) is not consumed; stale tokens keep receiving attempts until a client unregisters.
- **One-user storage** — `devices.json` is an ordinary 0600 file owned by the host user; no encryption at rest beyond filesystem permissions.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published: the package exposes no runtime observation stream of its own, and the token-stays-out-of-logs relationship it owns is covered by focused behavior tests.

</details>
