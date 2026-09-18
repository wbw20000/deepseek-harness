# Notify subsystem

English | [中文](notify.zh.md)

The Notify subsystem delivers title-level push notifications to registered iOS devices when session-controller state changes. One opt-in Cordis service owns the registry document, the authenticated Remote endpoints, the event-to-notification mapping, and the outbound-command dispatcher. The subsystem holds no delivery queue: an event observed while the host is up is dispatched immediately or recorded as failed, and the registry document is the only durable state.

## Notification values

`NotificationKind` is the closed set `turn-finished`, `turn-failed`, and `awaiting-confirmation`. `NotificationEvent` carries exactly `kind`, `sessionId`, `title`, and `occurredAt`. The payload is sanitized by construction: the title is a fixed per-kind string plus the asked-for tool name for `awaiting-confirmation`; the session-controller error message, message bodies, filesystem paths, and tool arguments never enter the event.

`PushRegistrationRequest` pairs a caller-chosen `deviceId`, the closed `platform: 'ios'`, and the opaque APNs `token`. `DeviceRegistration` adds the registration time; `DeviceView` is the token-free projection the `list` endpoint returns.

## Event mapping

| Kind | Source event | Rule |
|---|---|---|
| `turn-finished` | `api-session/status` with `running: false` | Delivered through the dedupe gate. |
| `turn-failed` | `api-session/error` | Delivered through the dedupe gate; marks its session as failed inside the window. |
| `awaiting-confirmation` | `approval/request` waterfall | The listener observes, then delegates with `next()`; it never claims the request. |

The mapping is a fixed subscription, not a generic event-source seam: until the unified event model (M4) exists, a new notification-worthy occurrence means editing the owning package.

## Dedupe and failure dominance

The dedupe key is `${sessionId}:${kind}`. Inside the configured window one session emits one notification per kind, regardless of delivery outcome. A recorded `turn-failed` additionally suppresses the `turn-finished` of the same session while the failure is inside the window, so one failed turn cannot notify twice. Window expiry admits again.

## Outbound delivery

Each delivery spawns the configured `outboundCommand`, writes one JSON line on stdin — `{ event, device: { deviceId, platform, token } }` — and expects exit 0 within the per-attempt deadline. The child runs detached, so the timeout stop signals only the spawned process group. Non-zero exit, spawn failure, and timeout are the retryable failures; the budget is `maxRetries` extra attempts with a 250 ms doubling backoff. Every budget ends in one `deliveries.jsonl` record with outcome, attempts, wall time, and a short failure reason. Delivery is fire-and-forget from the event listeners; disposal drains in-flight fan-outs.

Without an outbound command the service registers and lists devices only and never spawns.

## Storage

`devices.json` holds the validated registry document, committed by atomic rename under the cross-process writer lock with mode 0600. A malformed document fails the next operation loud; it is never reset. `deliveries.jsonl` is append-only and token-free. Tokens exist in this document alone — not in logs, delivery records, or the Remote responses.

## Remote endpoints

`register`, `unregister`, and `list` are direct Remote methods under the `pushRegistry` namespace, served by the existing authenticated connection layer. Registration requests are validated at the service: empty ids or tokens and non-iOS platforms fail loud.
