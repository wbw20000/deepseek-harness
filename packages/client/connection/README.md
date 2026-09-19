---
description: "Browser-host wire layer for the web GUI: Remote RPC, event-stream delivery with reconnect, exact Fetch routes, the /api HTTP bridge, and the browser-trust fence."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-connection

English | [中文](README.zh.md)

## Summary

The package carries browser-to-Host Remote calls, exact Fetch responses, and connection generations. The Client plugin mounts `ctx.connection` with current-page loopback state, generic RPC, the active generation and its Host facts, observable recovery state, an immediate reconnect command, and the registration point for one generation source. A generation becomes visible when its source reports ready; source completion, failure, withdrawal, or an explicit stop clears it before `ConnectionController` applies its retry policy.

## Table of Contents

- [Use this package](#use-this-package)
- [Browser authentication and request trust](#browser-authentication-and-request-trust)
- [Connection generation](#connection-generation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

A static desktop page can provide `__DSH_TRANSPORT__.streamBaseUrl` for the HTTP origin of its owned Host. The Gateway uses that origin for its WebSocket while HTTP transport remains independently selected. The desktop carrier owns authentication; setting the origin alone grants no access.

The browser uses HTTP POST for Remote unary calls. API Gateway owns the `/api/remote.mux` WebSocket and its logical streams; shell-owned compositions provide equivalent Remote streams through `connection.rpc.open` without opening a WebSocket. The browser plugin reads the page transport, recovery settings, and location, then delegates to `installConnection(ctx, options)`. A composition that owns its carrier may call the same installer directly; the whole-client test tier does so. Each invocation creates one Context-owned service, so several Client trees can use different carriers in one realm. The Host half always provides the carrier-neutral RPC and exact `GET`/`HEAD`/`POST` route registries. When a Web carrier is present it also owns the sole `/api` route, Fetch bridge, browser authentication, and Host/Origin checks; a shell-owned carrier dispatches the shared Fetch handler directly. Each exact route declares buffered or streaming request-body handling before the bridge reads any bytes. Typert Gateway claims generated Remote endpoints, feature packages register non-JSON responses such as Session-log downloads and raw file uploads, and unclaimed requests return 404. Loopback hostname classification remains package-internal to the browser-facing Client state. Browser raw-body transfer is provided by [`dsh-client-file-upload`](../file-upload/README.md).

-----

<a id="browser-authentication-and-request-trust"></a>
## Browser authentication and request trust

Every Host RPC method and WebSocket stream requires one browser session; there is no method-specific loopback tier. Each process mints a random launch token. `dsh-web-app` prints and opens the ordinary root URL with `?token=...`; `frontend-static` delegates root and index requests to `ctx.connection.authorizeIndex`, which accepts that token only on `GET /`, registers a server-side session, writes an authority-bound signed cookie naming it, and redirects to clean `/`. A missing, expired, malformed, or wrong-authority cookie returns 401 before RPC dispatch. Static assets remain public. The HTTP carrier accepts no query token outside the root exchange and no Authorization-header token.

The cookie signing secret is the owner-scoped `client-connection/browser-session` grant record in `ctx.credentials`, and the session registry persists its JSON snapshot beside it as the `client-connection/browser-sessions` record; the local provider stores both in `$DSH_HOME/.credentials.yaml`, and Connection activation loads both into memory, so request authentication is synchronous. Every token exchange registers a session first and mints a cookie naming it, and verification additionally requires that session to exist and be unrevoked, so revoking a registration invalidates its cookies without touching the signing secret. Deleting or replacing a record takes effect on the next Connection activation. Cookies carry an absolute issue/expiry interval, defaulting to 30 days through `cookieMaxAgeDays`, and bind the normalized hostname plus port in both their deterministic name and signed payload. They are host-only, `Path=/`, `HttpOnly`, and `SameSite=Strict`. `Secure` is off by default because the shipped server uses loopback HTTP; set the Host Connection row's `cookieSecure` to true only when the origin is served behind an HTTPS-terminating reverse proxy, which also switches minted pairing URLs to `https`.

Connection owns five authenticated exact Fetch routes for the session lifecycle: `GET /api/connection.sessions` lists registrations (device label, bound certificate serial if any, issue, expiry, and revocation times, never cookie values or certificate material), `POST /api/connection.sessions.revoke` with `{ sessionId }` revokes one registration, `POST /api/connection.certificates.revoke` with `{ serial }` revokes every registration bound to one certificate serial, `POST /api/connection.logout` revokes the caller's own session and expires its cookie, and `POST /api/connection.pairing.mint` with `{ ttlMs?, deviceLabel }` mints one single-use pairing token and returns an ordinary root URL with `?token=...`. A pairing token is a 32-byte random base64url secret, at most five may be pending at once, and its time to live is at most ten minutes (default five); `authorizeIndex` consumes it exactly once, registers a session under the minted device label, and issues that session's cookie. Tokens are held in memory only, never logged, and never appear in error messages. The same authentication check guards `/api/remote.mux` WebSocket upgrades, so a revoked session is refused on its next handshake; API Gateway additionally closes the session's already-accepted mux connections with WebSocket close code 4401 (`session revoked`) — see [the Gateway README](../../api/gateway/README.md#revocation-disconnects-accepted-mux-connections).

When the deployment terminates per-device mTLS in Caddy in front of DSH, a session can bind the client certificate of the device that opened it. Caddy verifies the certificate against the offline device CA and forwards its serial number; DSH never sees the TLS handshake and trusts the serial only as a header from a trusted proxy. Set the Host Connection row's `mtlsClientSerialHeader` to that header — `header_up X-DSH-Client-Serial {http.request.tls.client.serial}` — and `mtlsTrustedProxies` to the proxy's remote socket address, `127.0.0.1` when Caddy proxies over the loopback. The default (no header configured) never reads a serial header and keeps the cookie-only behavior; a configured header without a proxy entry fails plugin load. DSH accepts the serial in Caddy's decimal rendering or hexadecimal, and stores it normalized as lowercase hex. Every token exchange (process launch and pairing) binds the trusted serial to the new registration, and a bound session authenticates only from requests whose trusted proxy forwards the same serial, so a cookie pair copied to another device is inert. A bound session whose request carries no trusted-proxy serial — proxy without the header, unlisted peer, or the field later removed from config — is refused, never silently downgraded to cookie-only. Revocation is by registration or by device: `sessions.revoke` and `logout` retire one session each, while `certificates.revoke` retires the serial and every session bound to it at once.

Before authentication, every request still passes `src/api-request-trust.ts`. Its `Host` must be loopback or match a `trustedHosts` entry: exact on `host:port`, any port on port-less entries, both sides WHATWG-normalized. An attached `Origin` must equal that Host and `sec-fetch-site: cross-site` is refused. Malformed configured authorities fail plugin load. These checks defend DNS rebinding and cross-site browser requests; they never establish identity. A failed Host/Origin check returns 403, while a trusted but unauthenticated request returns 401. `dsh web --host 0.0.0.0` remains unsupported. Decision records: [browser request trust](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md) and [browser token authentication](../../../.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.md).

Authenticated shared HTTP requests pass through the `connection/request` waterfall before body transfer. A listener may refuse new requests or await `next()` through response completion; removing its owning fiber removes admission behavior. Desktop uses this hook to lock new API work during an approved installation without canceling already-admitted work. WebSocket stream ownership remains with API Gateway.

Every request Connection dispatches — exact Fetch routes and the shared-channel RPC interceptor — runs inside `ctx.connection.caller.run(callerOf(request), ...)`, an AsyncLocalStorage scope holding that request's caller identity: the lowercased `Host` header including its port, whether that header names a loopback host, and the verified cookie's `sessionId` and bound `certificateSerial` (both undefined when unauthenticated). `loopback` follows the `Host` header, not the socket: phone traffic forwarded by frp/Caddy arrives on a loopback socket while naming an FQDN, so the Host decides. Handlers read the identity with `ctx.connection.caller.current()` instead of re-parsing headers. `ctx.connection.callerOf(request)` derives the same identity for carriers Connection does not dispatch, such as WebSocket upgrades, and `ctx.connection.onSessionsRevoked(listener)` reports the session ids that each of `sessions.revoke`, `certificates.revoke`, and `logout` actually revoked; a listener that throws never fails the revocation or the remaining listeners, and the returned disposer unsubscribes.

<a id="connection-generation"></a>
## Connection generation

API Gateway Client registers the internal `$events` logical stream as the sole generation source, independently of whether any `$on` listener exists. The Host attaches all incremental listeners in the API Remotes source factory, then sends one `{ type: 'ready', clientId, host: { home } }` item before events. `ConnectionController` publishes that generation and calls `onConnected` only after the ready item arrives, so baseline acquisition cannot race ahead of incremental observation.

An ended `$events` stream, a Remote stream error, a non-ready opening item, or a malformed event item invalidates the current generation. A pending handshake logs a slow-Host warning after 3 seconds and logs the readiness timeout and aborts after 15 seconds by default, including time spent waiting for the physical socket. The source must stop delivery, release resources, and settle after cancellation before a replacement starts; late readiness from a cancelled source cannot publish a generation. While the browser reports network availability, the controller publishes `connecting` and retries with 50%–100% jitter under caps of 500ms, 1s, 2s, 4s, 8s, and 10s, continuing at the final cap until recovery. Every retry asks Gateway to replace the physical WebSocket once and reopens `$events`. The [continuous recovery decision](../../../.agents/notes/implemented/bug-fix/2026-09-05-continuous-client-recovery.md) owns the deadlines and retry policy.

`ctx.connection.reconnect()` interrupts active work, resets the sequence, and starts retry 1 immediately. Browser `offline` aborts active work, publishes `disconnected`, and suspends automatic attempts; the next `online` transition resets the sequence and starts at the 500ms tier. Only a ready item publishes `connected`. Gateway mux owns no independent retry schedule.

Set the Host Connection row's `config.recovery` to override retry caps, the growth factor, or handshake warning and cancellation times; the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-client-connection) lists accepted fields. The Host validates these values and injects them into each served page. The Client validates the bootstrap data before providing Connection and uses those defaults when Gateway starts its loop; explicit `start()` timing overrides take precedence. The growth factor must be finite and at least one. Readiness, failure, cancellation, or a hard deadline that occurs before the warning cancels that warning. Reload the page after changing Host recovery configuration.


<a id="model-experience"></a>
## Model Experience

None, as the wire consumer layer moves already-composed messages between browser and host; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Buffered `/api` routes retain each request body in memory** — `maxRequestBodyBytes` (default 300 MiB, sized for the default 200 MiB aggregate image limit after base64 expansion plus envelope headroom) bounds ordinary image and RPC envelopes. Opt-in streaming routes receive backpressured chunks and bypass the aggregate cap; route implementations own persistence, cancellation, and any storage quota.
- **The session registry is local to one process and one data directory** — registrations are not shared across processes or devices beyond the serial the trusted proxy reports; concurrent processes sharing one credentials file keep last-write-wins registry snapshots without merging. Revocation, including per-certificate revocation, is enforced at DSH's own checks: a revoked session's already-accepted mux connections are closed with close code 4401 by API Gateway, while other same-user processes on the host, which the credentials file already trusts, remain unconstrained.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Browser-session verification reads the in-memory session registry synchronously; the registry snapshot loads once per activation and persists through the credentials provider, whose companion owns record commit-event lifetime. Stream/reconnect sequencing and rpcId round-trip discipline are exercised directly by behavior specs, and route register/dispose symmetry is audited by the webserver companion.
