# Agent Note: Independent macOS recovery Apps

Status: implemented

English | [中文](2026-09-18-recovery-mac-apps.zh.md)

## Problem

A damaged main App executable must not prevent diagnosis or a deliberate launch of an explicitly selected last-good runtime. Recovery cannot infer human release approval from directory modification time or mistake restarting a backend for restoring data.

## Decision

`deliverables/mac-launcher` builds two independent ordinary Apps — `DeepSeek Harness Recovery` and `DeepSeek Harness Emergency Recovery` — from one `RecoveryApp` executable through `tools/build-recovery.sh`, with distinct bundle identifiers and independently copied executable bytes and resources. Neither depends on the main LauncherApp executable, a source checkout, or a global Node at runtime; both link `LauncherCore` at build time and never load experimental code dynamically.

Each App reads exactly one explicit versioned last-good record, `<installation root>/recovery-last-good.json`, schema `deepseek-harness.recovery.last-good/1`, naming a frozen bundle directly inside the sealed managed installation plus the SHA-256 digests of its `frozen-launcher-config.json` and `runtime-inventory.json`. `RecoverySelection` reuses the frozen validator and rejects unsupported schemas, malformed, over-size, hardlinked, and FIFO records, traversal and symlinked bundle paths, bundles outside the installation, digest mismatch, and missing bundle or data-home parts. The recorded data home must be a real directory strictly inside the chosen managed installation, reached through checked components, and must not overlap the selected App; nested release paths are accepted only as explicit recorded paths. The inventory digest read bound matches the validator's 32 MiB inventory limit, since a real inventory seals tens of thousands of files. Diagnosis is read-only and runs off the main thread: the digest checks are followed by a full `RuntimeIntegrityValidator` payload pass, and only a diagnosis that passed both enables start. Only a deliberate human click starts the verified last-good backend through an owned `BackendController`. A recovery launch never rewrites active/last-good records and never migrates data.

`RecoveryLease` excludes concurrent frozen writers from the same data home with an OS `flock` on a descriptor of the data-home directory itself. `BackendController` acquires it before any frozen backend starts — the ordinary frozen launcher and both recovery Apps alike — and holds it until the owning launch's teardown has fully settled, so lease contention fails before any process is spawned and a stale validation cannot reopen the data home after a quit. There is no lock file and no stale PID state to clean up; the recovery App does not acquire a second lease beside the controller's.

## Alternatives considered

A newest-mtime scan of installed Apps was rejected: it would launch whatever changed last, which is exactly the failure recovery exists to prevent. A PID-file lock was rejected: a crashed holder leaves a stale file that blocks or, worse, a reused PID that misleads; the kernel-held `flock` has neither failure mode. Putting the lease in `BackendController` instead of only the recovery App was chosen once the recovery-only lock left the ordinary frozen launcher and a recovery App able to write the same data home concurrently: a shared acquisition before any frozen spawn closes that path for every frozen launch with one owner.

## Consequences

The advisory lease does not constrain processes that skip acquisition and does not supervise orphan processes: forced launcher termination releases the lock even if its child survives. Check for residual backends before reopening after a forced exit. An unconfirmed child stop retains the lease and delays App termination until exit is observed. Metadata hashes detect accidental inconsistency, not a same-user writer replacing both record and payload. These Apps provide diagnostic/manual backend recovery, not sandboxing, release approval, release transactions, or backup restoration. A last-good record must be supplied explicitly; no product record writer is exposed. Emergency Recovery shares the same implementation but has an independent entry point; damage to a shared selected runtime still prevents both from launching it.

## Existing decisions

The [frozen candidate decision](../architecture/2026-09-17-frozen-mac-launcher.md) remains authoritative for payload integrity, data-home rules, and the no-confinement limits this recovery path reuses. The [single dsh launcher decision](../architecture/2026-08-22-single-dsh-application-launcher.md) owns Node application entry points. No active note is superseded.

## Verification

`swift run --package-path deliverables/mac-launcher RecoveryTests` covers valid selection, corrupt and unsupported schema, over-size/hardlink/FIFO record metadata, inventories larger than 64 KiB and the over-32-MiB inventory refusal, traversal and symlink escapes, digest mismatch, missing bundle and data-home parts, sealed-installation loading, data-home containment (outside the installation, overlapping the selected App, `..` and symlinked components, an accepted explicit nested release path), lease exclusion across independent processes through a holder child, and an owned `BackendController` launch and stop of a sealed launchable fixture with independent-process lease contention that fails before any spawn. `RecoveryTests --fixture-install <existing directory>` runs selection, full payload validation, and a real owned launch and stop against a private fixture installation. `run-build-tests.sh` exercises `build-recovery.sh` refusals. Native window, click-to-start, and two-App concurrency trials on a real Mac remain separate human platform evidence; metadata-hash records in this increment are clearly test-only and never seed a real stable approval.
