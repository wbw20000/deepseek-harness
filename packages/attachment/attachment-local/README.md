---
description: "Local storage for your attached images below DSH_HOME, for users and maintainers choosing or debugging where image attachments are kept."
kind: "package-reference"
---

# @deepseek-ai/dsh-attachment-local

English | [中文](README.zh.md)

## Summary

Store images and generic file attachments durably below `DSH_HOME` on the machine running DSH. Images are validated, normalized for model requests, and cached per route; generic files are preserved byte-for-byte under a write-ahead byte limit and media-type allowlist, and an optional disk budget bounds stored and reserved bytes. Identical bytes are stored once even when uploads use different display names, reads verify file length and content, and admitted images remain readable if limits later tighten. The shipped `dsh` composition uses this package without configuration. Objects remain local to one machine and are collected only when a caller runs garbage collection.

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

In the default composition, images and generic files attached to prompts or commands are stored on this machine automatically. If you compose your own setup, mounting this plugin provides durable attachments.

### Minimal configuration

Mount the plugin with no required configuration. The defaults below define what you can attach; the generated configuration catalog is the exhaustive source for every field.

```yaml
- name: '@deepseek-ai/dsh-attachment-local'
```

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | resolved | Explicit harness home; omitted follows `$DSH_HOME`, then `~/.dsh` |
| `maxImageBytes` | `20 MiB` | Maximum encoded source bytes accepted for one image |
| `maxImagesPerMessage` | `20` | Maximum image count accepted in one submitted message |
| `maxMessageImageBytes` | `200 MiB` | Maximum aggregate encoded source bytes in one submitted message |
| `maxImagePixels` | `64,000,000` | Maximum source width multiplied by height |
| `maxImageDimension` | `8192` | Maximum source width or height |
| `normalizedImageMaxPixels` | `2048 × 2048` | Total-pixel budget of the stored normalized image |
| `normalizedImageMaxDimension` | `8192` | Maximum long edge after applying the total-pixel budget |
| `normalizedImageMaxBytes` | `4 MiB` | Encoded-byte target; the smallest quality-ladder output is kept when none fits |
| `imageCompressionConcurrency` | `2` | FIFO limit for concurrent normalization and request transforms |
| `maxUploadBytes` | `300 MiB` | Maximum bytes accepted for one verbatim file upload |
| `allowedMimeTypes` | images, text, common documents | Accepted file media types; exact types, `type/*` wildcards, and the match-all wildcard are honored |
| `diskBudgetBytes` | `0` (unlimited) | Durable attachment disk budget; stored plus reserved bytes may not exceed it |
| `budgetWarnRatio` | `0.8` | Budget fraction at or above which one debounced warning is logged |
| `gcIntervalMs` | `0` (off) | Garbage-collection timer interval; when set, each pass needs a registered reference source |
| `gcGracePeriodMs` | `24 hours` | Grace period the garbage-collection timer applies to unreferenced objects |
| `gcReferenceTimeoutMs` | `30 seconds` | Deadline for one asynchronous reference-source read; a still-pending source skips that pass |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-attachment-local) is the exhaustive source for every accepted field and its JSDoc.

### How file uploads are admitted

A generic file is checked before any byte is written: a declared upload over `maxUploadBytes` is refused with `FILE_TOO_LARGE`, and a declared media type outside `allowedMimeTypes` is refused with `UNSUPPORTED_FILE_TYPE`. An upload that declares no media type counts as `application/octet-stream`, which the default allowlist contains, so existing clients keep working. Streaming uploads are counted while they write, so a missing or under-declared length cannot sneak past the byte limit — the partial staging file is deleted and the upload fails. Zero-byte files are valid uploads.

### How the disk budget works

With `diskBudgetBytes` above zero, every upload reserves its declared byte count before writing, and undeclared streams reserve while they grow. Stored object bytes plus all active reservations may never exceed the budget; an upload that would push past it is refused with `DISK_BUDGET_EXCEEDED` and its reservation is released. Reservation records live beside the store in `v1/reservations`, and the store deletes a crashed process's records and `v1/tmp` staging files unconditionally when the plugin starts, whether or not the budget is enabled. Exactly one process may write attachments to a home: the cleanup cannot tell another live process's records from crash orphans. When stored usage reaches `budgetWarnRatio` of the budget, one warning is logged; the warning fires again only after usage falls back below the threshold. `usage()` reports the current bytes, budget, and warning and over-budget flags at any time.

### How objects are garbage-collected

`collectGarbage({ referenced, olderThanMs })` deletes stored objects whose attachment id is not in the caller's `referenced` set and whose last modification is older than `olderThanMs`, returning the reclaimed bytes and object count. Deleting a file object also removes its read-only name links. Collection never touches referenced objects or anything inside the grace period, and it runs only when a caller triggers it: `gcIntervalMs` enables a timer, and each timed pass consults the source registered with `setGarbageReferenceSource()`, because only the caller knows which sessions still reference an attachment. The shipped `dsh` composition leaves the timer off; the Session Controller registers the reference source, so turning the timer on makes collection live.

The registered source may resolve asynchronously, for example by reading persisted session logs. A pass skips — deleting nothing — when no source is registered, when the source returns or resolves to `undefined`, when it throws, or when it is still pending after `gcReferenceTimeoutMs`; a skipped pass logs a warning. A pass that is still reading also makes the next timer tick skip instead of racing a concurrent deletion. This bias toward skipping is deliberate: an unreadable reference set must never widen what a pass may delete.

### Where your images are stored and how long they last

Attached images are kept below `<DSH_HOME>/attachments/v1` on this machine. Stored images are never deleted automatically, identical images are stored only once, and a later tightening of the limits never makes already-saved images unreadable. If your images must be readable from another machine, this package is not the right fit.

### What happens when you attach an image

Attach an image and its source limits, media, dimensions, and pixels are checked before it is normalized and saved. EXIF orientation is applied, metadata and color profiles are removed, transparency is preserved, and the raster is reduced under a total-pixel budget plus a long-edge cap. Alpha images use WebP and opaque images use JPEG on the shared 85/75/60 quality ladder; the smallest output is retained when every candidate exceeds the byte target. An accepted image reappears in history and later turns, including after restart; the selected model route receives a cached request version and, when its filesystem maps the host object, a read-only execution-world path.

### What can go wrong

An image can be refused when you attach it: unsupported format, over the byte, pixel, or per-side dimension limits, or bytes that do not match their declared type. On a later read, an image that was deleted or corrupted on disk fails with a clear error. Each failure carries a stable code so the client and protocol adapters can explain it in their own words.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the durability and verification design behind the storage, and the write and read paths that realize it; observable behavior is fully covered in [Use this package](#use-this-package).

### Design decisions

- **Durability by fsync chain, not existence.** A synced file alone does not survive a crash when its directory entry never reached storage, so the write path syncs every ancestor entry to a process-proven boundary before a reference can reach a session checkpoint.
- **Normalize once, project per route.** Admission persists one provider-independent normalized attachment; request projection derives deterministic variants without rewriting durable history.
- **Lazy alpha-routed encoding.** Alpha images use WebP and opaque images use JPEG; quality candidates run in 85/75/60 order, and the smallest output is retained when none meets the encoded-byte target.
- **Limits are write-time policy.** Byte, total-pixel, and per-side dimension limits bind admission only, so tightening them later never makes admitted history unreadable.
- **Reservations make the budget concurrency-safe.** Each upload reserves before writing, in memory and in a record beside the store; a failed or aborted upload releases its reservation and deletes its partial staging file, and the startup orphan cleanup runs even when the budget is disabled.

### Write and read paths

Objects land at `<DSH_HOME>/attachments/v1/objects/<sha256-prefix>/<sha256>`; equal bytes deduplicate to one object and one `sha256:` id. Before the first write, the process syncs every ancestor directory of the home down to the filesystem root once, so a directory another process created but has not yet synced is never mistaken for a safe boundary. Writes then stage bytes in `v1/tmp`, sync the temporary file, publish with an atomic exclusive hard link, and sync the publication directories — on Windows, filesystem metadata journaling owns entry durability. Once the save resolves, the reported reference is durable.

Admission accepts up to 20 images and 200 MiB of source bytes per message; one source may use up to 20 MiB, 64 million pixels, and 8192 pixels per side. It applies orientation, removes metadata and color profiles, and normalizes under a 2048×2048 total-pixel budget, an 8192-pixel long edge, and a 4 MiB encoded-byte target. Extreme aspect ratios therefore retain their short-edge resolution. Clean single-frame 8-bit sRGB/sRGBA PNG, JPEG, or WebP input already within those limits passes through byte-identically; GIF, animation, metadata, orientation, 16-bit PNG, and incompatible color spaces force conversion.

Request versions live below `<DSH_HOME>/cache/attachments/request-images/`, resolved by `dshCachePath`; an explicit `dshHome` setting applies to both cache and durable storage. Clearing this cache between requests preserves durable attachments, and later reads regenerate the variants. `readImageRequest` scales without enlargement to the route-chosen target, resizing by the long edge only so the encoder derives the short edge as the route predicts, then applies a separate encoded-byte target through the same alpha routing and quality ladder. Its cache identity includes the attachment id, transform version, target dimensions, byte target, and fixed encoder settings; cached bytes are header-probed for format, 8-bit sRGB/sRGBA, dimensions, and alpha facts, and a mismatch regenerates the entry. Concurrent callers share one transform and cache write, while cancellation stops shared work only when no waiter remains. `imageHostPath` derives the normalized object's host path, and the mounted filesystem may map that path into its execution world without writing it to durable history.

Generic-file bytes have one canonical object at `<DSH_HOME>/attachments/v1/file-objects/<digest-prefix>/<digest>`. Each reference path at `<DSH_HOME>/attachments/v1/files/<digest-prefix>/<digest>/<name>` is a read-only hard link, so different names for equal bytes do not duplicate disk content. `readFileStream` reads the reference path in bounded chunks and verifies the complete digest and recorded byte count before a consumer can finish successfully. A missing, changed, or truncated object fails its consumer instead of producing a complete export with different bytes.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `LocalAttachmentStore`, `Config` schema, defaults |
| [`src/store.ts`](src/store.ts) | Content-addressed write and verified read: staging, hard-link publish, fsync chain, digest verification |
| [`src/file-store.ts`](src/file-store.ts) | Verbatim streamed file writes, verified streamed reads, and safe stored filenames |
| [`src/budget.ts`](src/budget.ts) | Disk-budget reservation ledger, stored-bytes snapshot, and budget warnings |
| [`src/gc.ts`](src/gc.ts) | Stored-byte scanning and unreferenced-object collection |
| [`src/normalization.ts`](src/normalization.ts) + [`src/encoding.ts`](src/encoding.ts) | Provider-independent normalization and bounded format/quality candidates |
| [`src/request-image.ts`](src/request-image.ts) | Route-specific request transforms, cache identity, and singleflight |
| [`src/image.ts`](src/image.ts) | Full raster decode and metadata verification |
| — | No runtime invariant companion is published; immutable writes and verified reads are enforced directly at the backend boundary. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

For the full service contract and payload types, read the subsystem reference; for the capability this storage backs, read the seam package.

- [Attachment subsystem reference](../../../docs/subsystems/attachment.md) — service contract, payload types, and the `ctx.attachments` Cordis surface.
- [Attachment seam package](../attachment/README.md) — the image attachment capability this storage backs.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-attachment-local) — every accepted config field and its source declaration.
- [Home paths resolution](../../util/home-paths/README.md) — how `DSH_HOME` resolves from explicit config, environment, and the user home.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through request descriptors. A mapped execution filesystem lets the model see each image's identity, dimensions, media type, read-only process path, writable-copy extension, and normalization warning alongside the request bytes. Generic files project as text handles naming their identity and read-only process path; when no mapping exists, the handle states that the execution environment cannot read the file.

#### KV Cache effect

Normalization and request projection are deterministic. An unchanged attachment and route policy reuse identical cached request bytes on later turns; execution-world path mapping can change descriptor text without changing those bytes or their `variantId`.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe what this storage can and cannot do; they are current package constraints.

- **Collection covers session references only** — the harness reference source names the attachment ids recorded in session logs and pending queued messages, so attachments consumed by external tools are invisible to collection; a second harness process sharing the same home is invisible to the budget ledger, and one process's startup cleanup treats another live process's reservation records as orphans.
- **Local to this machine** — images live on the machine that runs the harness; other hosts cannot read them.
- **Animated GIF becomes static** — normalization retains only the first frame; animation is outside the version-one image contract.
- **Encoder output is versioned** — the installed Sharp/libvips build pins normalization and request bytes; an encoder or transform-version upgrade re-addresses future variants while existing objects remain valid.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: undecided directions and open questions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and the package code.

#### Future: retention and remote storage

The `collectGarbage()` API owns deletion and the Session Controller wires session references into the timer. Resumed and forked sessions may share immutable objects, so the reference set must stay the union across the whole session corpus; external tool references outside session logs are not counted. A backend serving remote runtimes or shared storage would need its own durability proof and budget ledger. Both directions are undecided.

</details>
