---
description: "Stable-side phone pairing UI: one Settings section that mints one-time pairing links as QR codes, lists the paired browser sessions, and revokes one behind a risk confirmation, all through Connection's own session routes."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-phone-pairing

English | [中文](README.zh.md)

## Summary

This package adds one Settings section titled **Phone pairing** to the Web client. On the stable host (a loopback connection) it mints a one-time pairing link through Connection's `POST /api/connection.pairing.mint` route, renders it as a QR code the phone scans, shows the link with a copy button, and counts the token down to its expiry. Everywhere, including on a phone, it lists the registered browser sessions and revokes one behind a second confirmation dialog. The QR encoder is the package's own (byte mode, level M, versions 1–10), so the pairing token never leaves the browser to be drawn.

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

The section renders under Settings at order 46, right after the attachment section. It has no host-side behavior: the node entry's `apply` registers nothing, and every request the section sends is a same-origin `fetch` with the browser session cookie the desktop already holds. Connection owns the three routes, their authentication, and the host-only rule on minting.

### Enabling the section

The default web bundle lists the plugin in the roster (`packages/bundle/web-app/cordis.patch.yml`), so `dsh web` shows the section without further configuration. Removing the roster row removes the section; the routes stay with Connection.

### Minting a pairing link

| Field | Meaning |
| --- | --- |
| Device name | The label the session is registered under; it appears in the session table and in Connection's `.credentials.yaml`. |
| Validity | 5 or 10 minutes; Connection caps a pairing token at ten minutes, so the select offers nothing longer. |
| Mint pairing link | Sends `{ deviceLabel, ttlMs }` to the mint route and shows the result: a QR code, the link text, a copy button, and a countdown. |

A minted link is single-use: the first browser that opens it is registered as a session and receives the cookie; a second open answers 401. The token lives only in this component's state; the section never logs it, and the countdown replaces the link with an expiry notice once the host clock passes `expiresAt`.

The link the section shows is whatever Connection minted. Behind a relay (a phone reaching the host through a public origin), configure Connection's `publicOrigin` so the minted URL names the origin the phone can reach instead of the loopback address of the request; without it the QR code encodes a link that only the desktop can open.

### On a phone

Connection answers 403 to a mint request from a non-loopback caller. The section reads the Remote service's `$host.isLoopback` fact and, on a phone, hides the mint form behind a one-line explanation, leaving the session table so the phone can see and revoke its own or other sessions.

### The session table

The table shows every registered session, revoked ones included, with device, issue time, expiry, and state, plus a refresh button. **Revoke** opens a `RiskConfirmation` dialog naming the device; the acknowledgement checkbox must be ticked before the confirm button sends the revoke. Revocation is immediate on the host side: the session's cookies stop authenticating and its mux connections close, so a paired phone drops off within one reconnect.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/client/index.ts` registers the `phonePairing` dictionaries and one `settings.section` seat whose inject face carries the fetch port (`fetchPairingApi` over `internals.fetch`, a test hook that defaults to the window's `fetch`), the `phone` flag from `ctx.remote.$host.isLoopback`, and a `now` clock so the countdown is testable. `src/client/api.ts` shapes the three requests and turns a non-2xx reply into an `Error` carrying the server's text (Connection writes plain sentences such as `connection: pairing links are minted from the stable host only`), or `HTTP <status>` when the body is empty. `src/client/qr.ts` is the encoder: it picks the smallest version 1–10 whose level-M capacity holds the UTF-8 payload (213 bytes at most), builds the codewords (mode and count indicators, terminator, pad bytes), computes Reed–Solomon parity over GF(2^8) with the 0x11d polynomial per block and interleaves the blocks, places finder, timing, alignment, and dark-module patterns, writes format information (BCH(15,5) masked with 0x5412) and, from version 7, version information (BCH(18,6)), then scores the eight masks with the four penalty rules and keeps the lowest. `qrToSvg` and the panel's `QrCode` render one `rect` per dark module inside a four-module quiet zone. The encoder was validated against macOS Vision's barcode detector for every version boundary and for multi-byte UTF-8 payloads.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Connection](../connection/README.md) — the session registry, the pairing mint and revoke routes, `publicOrigin`, and the trusted-host fence.
- [Push registry](../../notify/push-registry/README.md) — the phone-side notification registration that pairs with a session.
- [Web Client architecture](../../../docs/subsystems/web-client.md)

No runtime invariant companion is published because the section only drives three Connection routes it does not own and asserts no independently observable relationship between them.

<a id="model-experience"></a>
## Model Experience

None, as the section only mints, lists, and revokes browser sessions through Connection's routes and contributes no model-visible input.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A minted link cannot be voided before it expires: Connection has no route to cancel a pairing token, so the section offers no cancel button and relies on the ten-minute cap.
- The QR encoder covers byte mode at level M up to version 10 (213 bytes). A pairing URL longer than that is not drawn; the section then shows the link text and the copy button only.
- Behind a relay the minted link is correct only when Connection's `publicOrigin` is configured; the section cannot detect a loopback link and shows it as minted.
- Per-device client certificates are not managed here: the session table does not show the certificate serial Connection may have recorded, and signing, distributing, and revoking certificates stay a deployment task.
- The session table refreshes on load, after a revoke, and on the refresh button; it does not subscribe to session changes.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Tests inject a recording `fetch` through `internals.fetch` and drive the panel with `@testing-library/react`; the QR tests decode structure (finder patterns, format bits, version bits) rather than pixels, and the Vision validation lives outside the repository as deployment evidence. Keep `TTL_MINUTES` within Connection's cap and keep the mint form hidden on phones: the 403 is Connection's rule, the hidden form is only the polite face of it.

</details>
