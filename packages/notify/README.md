---
description: "Package map for outbound device notifications: the opt-in push-registry service and its session-event outbound dispatcher."
kind: "package-group"
---

# notify/ — outbound device notifications to registered devices

English | [中文](README.zh.md)

## Summary

The Notify family turns session-controller occurrences into title-level push notifications for registered iOS devices. One opt-in service owns the device-token registry, the authenticated Remote endpoints, the dedupe window with failure dominance, and the stdin-connected outbound command. Delivery is fire-and-forget with recorded outcomes, and tokens never leave the registry document.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`push-registry/`](push-registry/README.md) | Device-token registry, session-event subscription, and outbound delivery | `ctx.get('pushRegistry')` (opt-in; not mounted by any shipped composition) |

<a id="related-documentation"></a>
## Related documentation

The service's event mapping, sanitization rules, dedupe and retry semantics, and storage layout are owned by the [Notify subsystem reference](../../docs/subsystems/notify.md). The package README owns the Remote method contracts and the deployment configuration.

<a id="dev-note"></a>
## Dev Note

None.
