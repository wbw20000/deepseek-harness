# DeepSeek Harness macOS launcher

English | [中文](README.zh.md)

## Summary

This directory builds a macOS App candidate that owns the DeepSeek Harness Web backend lifecycle: it starts `dsh web --no-open`, waits for the readiness line, and opens the browser once the authenticated readiness probe passes. The default mode uses a source checkout; opt-in frozen mode carries its own Node and runtime. `build.sh` builds, signs, and verifies the candidate through SwiftPM. It never installs: the destination must not exist, and no installed App is ever replaced.

## Contents

- [Prerequisites](#prerequisites)
- [Build a candidate](#build-a-candidate)
- [Frozen candidate](#frozen-candidate)
- [Recovery Apps](#recovery-apps)
- [Upgrade and restore transaction (`dsh-upgrade`)](#upgrade-transaction)
- [Tests](#tests)
- [Source-linked limitation](#source-linked-limitation)
- [Identity and diagnostics](#identity-and-diagnostics)
- [Isolated trial](#isolated-trial)
- [Failure behavior](#failure-behavior)

<a id="prerequisites"></a>

## Prerequisites

- macOS with Xcode Command Line Tools (`swift`, `xcrun`, `codesign`, and `/usr/libexec/PlistBuddy`).
- A Node executable, passed to `build.sh` as an absolute path.
- The DeepSeek Harness checkout the candidate will run, with `pnpm install && pnpm run build` completed so `apps/cli/lib/bin.js` exists.

<a id="build-a-candidate"></a>

## Build a candidate

```sh
zsh deliverables/mac-launcher/build.sh \
  --project-dir <absolute path to the dsh checkout> \
  --node <absolute path to node> \
  --output <absolute path to the new .app>
```

`--output` defaults to `deliverables/mac-launcher/.build/DeepSeek Harness (Candidate).app`; when the default is selected, `build.sh` creates that `.build` parent after validating the inputs, so a fresh checkout works and a rejected build leaves nothing behind. The script works from any working directory — SwiftPM always receives `--package-path` pointing at this directory — refuses a relative path, a nonexistent input, and an existing destination (including a symlink), and exits nonzero without touching the destination. It builds the `LauncherApp` product through SwiftPM, compiles against the macOS 13 deployment target that Package.swift declares, resolves the CLI entry only from `apps/cli/package.json`'s `bin.dsh`, and signs the bundle ad hoc with a designated requirement that pins the candidate identifier. Publication is an atomic no-replace rename: `build.sh` compiles `publish-rename.c` with the Command Line Tools into the private staging directory, and that helper moves the staged bundle with `renamex_np(RENAME_EXCL)`, which either publishes the bundle or changes nothing — a concurrent writer that creates the destination first fails the build and keeps the existing destination, and the helper is never shipped inside the bundle. If the host blocks SwiftPM's manifest sandbox, `build.sh` reports the restriction and exits nonzero; rerun it in a host context that permits `sandbox-exec` — the script never disables the sandbox or falls back to a weakened one.

<a id="frozen-candidate"></a>

## Frozen candidate

Frozen mode takes an already deployed dependency directory with a root `package.json` declaring `bin.dsh`, a standalone Mach-O Node binary for the build machine, and a fresh empty data directory outside the input runtime and output bundle. Supply absolute paths, an existing output parent, the input source revision, and the deployed lockfile's SHA-256. These identifiers describe build inputs; they do not approve a release. Verify the Node archive against its distributor's checksum before using it.

```sh
zsh deliverables/mac-launcher/build.sh --frozen \
  --runtime-dir <absolute deployed-runtime directory> \
  --node <absolute standalone Node binary> \
  --dsh-home <absolute fresh empty data directory> \
  --source-rev <input source revision> \
  --lockfile-digest <deployed lockfile SHA-256> \
  --output <absolute path to a new .app>
```

The builder does not install dependencies, fetch Node, seed credentials, or build Harness packages. Prepare and test the dependency directory separately. The exercised deployment uses the repository-pinned pnpm with `--filter dsh-python-runtime-closure deploy --prod --offline --ignore-scripts --config.inject-workspace-packages=true --config.node-linker=hoisted --config.allow-unused-patches=true --config.package-import-method=copy`; that closure includes the Web runtime. Its root manifest needs a `bin.dsh` pointing to the installed CLI's own declared entry. A CLI-only deployment is not interchangeable: it may omit required peer packages. Keep the source lockfile, derived deployment lockfile, and dependency preparation evidence with the candidate.

The bundle contains independent byte copies of Node and the runtime. Internal links are materialized; escaping or cyclic links and special files are refused. Node may depend only on system libraries; native runtime files may also use their own `@loader_path` or `@rpath` entries when these resolve to copied, inventoried Mach-O files. External, inherited, and unresolved search paths are refused. Each native file is signed before the SHA-256 inventory is written. Swift checks file names, digests, sizes, permissions, and link counts before starting Node; hashing is off the main actor and quitting cancels startup. The inventory detects accidental changes, not an attacker who can rewrite the bundle and inventory together. It is not a release approval signature.

The frozen identity is `com.local.deepseek-harness-launcher.candidate.frozen`. Its recorded data home and bundled `127.0.0.1`/port `0` overlay override ambient `DSH_HOME` and the normal Web listener. The child starts in that trial home, retains UNIX `HOME`, and drops `NODE_OPTIONS`, `NODE_PATH`, `DYLD_*`, and secret-like environment names. Existing settings, credentials, and sessions are never copied automatically. Keep only one frozen candidate running at a time because frozen candidates share their identity and log. Use a separate browser profile for trials.

This is runtime and data separation, not filesystem, process, network, or storage-quota confinement. There is no automatic upgrade, recovery-copy manager, release pointer, or unattended development loop. A human must trial the exact candidate before approving any separate installation action. See the [frozen-runtime decision](../../.agents/notes/implemented/architecture/2026-09-17-frozen-mac-launcher.md).

<a id="recovery-apps"></a>

## Recovery Apps

`tools/build-recovery.sh` builds two independent ordinary Apps for the opt-in recovery path: `DeepSeek Harness Recovery.app` (`com.local.deepseek-harness-launcher.recovery`) and `DeepSeek Harness Emergency Recovery.app` (`com.local.deepseek-harness-launcher.recovery.emergency`). Each bundle carries its own copy of the `RecoveryApp` executable and its resources, so neither depends on the main LauncherApp executable, a source checkout, or a global Node at runtime. Neither App installs anything or replaces an existing App.

```sh
zsh deliverables/mac-launcher/tools/build-recovery.sh \
  --installation <absolute managed installation root> \
  [--output-root <absolute existing parent directory>]
```

The script seals exactly one managed installation root into each bundle (`Contents/Resources/recovery-installation.json`), refuses a relative, missing, or symlinked root, and publishes both bundles with the same atomic no-replace rename as `build.sh`. Rebuilding means running the script again; an existing destination is never overwritten.

At startup each App reads exactly one explicit versioned last-good record, `<installation root>/recovery-last-good.json`, and accepts only schema `deepseek-harness.recovery.last-good/1`. The record names a frozen `.app` bundle directly inside the installation plus the SHA-256 digests of its `frozen-launcher-config.json` and `runtime-inventory.json`. The loader reuses the frozen validator and rejects everything else: unsupported schema, malformed, over-size, hardlinked, or FIFO records, traversal and symlinked bundle paths, bundles outside the chosen installation, digest mismatch, and missing bundle or data-home parts. The recorded data home must be a real directory strictly inside the chosen managed installation, reached through checked components (no `..`, no symlinked intermediate), and must not overlap the selected App in either direction; a nested release path is accepted only as an explicit recorded path with every component checked. The inventory digest read bound matches the validator's 32 MiB inventory limit, since a real inventory seals tens of thousands of files. There is no directory scan, no newest-mtime guess, no automatic fallback, and no declaration that an existing HEAD build is approved stable.

Diagnosis is read-only and runs first, off the main thread: the record load and digest checks are followed by a full `RuntimeIntegrityValidator` payload pass, and only a diagnosis that passed both shows the verified state and enables the start button; hashing never blocks the main actor. Only a deliberate click on the start button launches the verified last-good backend through an owned `BackendController`; the launch binds to the verified data home and configuration and re-validates the frozen payload. A recovery launch never rewrites active/last-good records, never migrates data, and never upgrades a release: it is not an upgrade and not a data rollback. A new diagnosis or a quit discards stale results and never reenables start, and a live backend is stopped through its owned teardown before a new diagnosis runs. Errors name the violated rule and the path.

Before a frozen backend starts, `BackendController` takes an OS `flock` lease on its data-home directory. The ordinary frozen launcher and both recovery Apps share this rule; contention refuses a launch before spawn. An unconfirmed child exit retains the lease and delays App termination until exit is observed. The lock is advisory and disappears if the launcher is forcibly killed, even if its backend survives; after a forced exit, check for residual backends before reopening. It is not an orphan supervisor. Metadata hashes detect accidental mismatch, not malicious same-user edits. Recovery does not perform release transactions or restore backups.

<a id="upgrade-transaction"></a>

## Upgrade and restore transaction (`dsh-upgrade`)

Installing an approved candidate to the production location and returning to a previous version are explicit user actions in the desktop flow, run through the `dsh-upgrade` CLI (`Sources/UpgradeTransaction` holds the state machine; `Sources/dsh-upgrade` is the plain CLI). Nothing triggers it automatically: no launcher hook, no launchd job, no timer, and it never needs root or changes launchd. `dsh-upgrade` is built and run from this package like the test executables; it is not packaged into any App bundle.

```sh
swift build --package-path deliverables/mac-launcher
.build/debug/dsh-upgrade upgrade \
  --candidate-root <absolute managed-trial root> \
  --identity <absolute candidate-identity.json> \
  --trial-record <absolute trial-record.json> \
  --production-app <absolute production .app> \
  --production-data-home <absolute production data directory> \
  [--backups-root <dir>] [--transaction-dir <dir>] [--verify-command <cmd> [args...]]
.build/debug/dsh-upgrade restore (--from-backup <backup dir> | --from-last-good <recovery-last-good.json>) \
  --production-app <absolute production .app> --production-data-home <absolute production data directory>
.build/debug/dsh-upgrade resume --transaction-dir <dir>
.build/debug/dsh-upgrade make-trial-record --candidate-identity <absolute candidate-identity.json> \
  --approved-by <name> --result-digest <64 lowercase hex> --out <absolute output json>
```

Before the first byte is touched, `upgrade` binds the exact inputs: the candidate installation's `recovery-last-good.json` must name the candidate App and carry exactly the identity's two digests, the candidate bundle's `frozen-launcher-config.json` and `runtime-inventory.json` must re-hash to them, and the trial record (`schema` `self-development-review.trial-record/1`, with a non-empty `approvedBy` and a well-formed `resultDigest`) must name the same candidate. `approvedBy` and `resultDigest` are required: an upgrade is bound to a recorded trial approval. The normal source is the core `recordTrialApproval` flow (`trial/approved`), whose `resultDigest` a stable-side facade will export. An M1-era manual trial record without a `resultDigest` cannot upgrade directly: digest the candidate summary by hand (the values are human-checkable: `frozen-launcher-config.json`, `runtime-inventory.json`, the executable), format the record with `dsh-upgrade make-trial-record` — which copies the identity's fields verbatim, re-reads the artifact, and refuses unless the record binds exactly the identity's candidate — and run the upgrade with the bridged record. A bridged record carries `"trialRecordSource": "manual-bridge"`, which the transaction record copies, so a manual approval is always distinguishable from a core-recorded one; any other source value is a refusal. The production App and data home must exist, and the production App must not be the candidate itself. Any failed check refuses the run and leaves the filesystem untouched.

Every entry point — `upgrade`, `restore`, and `resume` — takes the transaction directory's exclusive `flock` on `upgrade-transaction.lock` before it reads or writes any transaction file; a busy lock refuses the whole run, including the reconciliation of an interrupted transaction, and the refused run changes nothing. The state machine persists every step to `upgrade-transaction.json` in the transaction directory (default: the production App's parent) with a temp-file-plus-`rename(2)` write (fsync of file and directory): `planned → backed-up → staged → switched → verified → committed`, ending in `rolled-back` or `needs-manual` on failure. Alongside the states, a side-effect ledger records after every step whether the backup, the staging copy, the App switch, the data-version marker, and the Recovery entry installation are done; the ledger is on disk before the next irreversible step, so a rollback — or a crash recovery — undoes exactly the recorded steps, in reverse order. `backed-up` is a paired backup of the production App, the production data home, and the pre-existing Recovery entry Apps under `<backups-root>/<UTC timestamp>-<replaced revision>/` (default `<transaction dir>/upgrade-backups`, suffixed when two transactions land in the same second), with a readable `manifest.json` recording every file's path, size, SHA-256, and the replaced version; the copy is hash-verified before `staged`, and a backup that fails midway is removed entirely. The switch copies the candidate App into a hidden staging directory next to the production App, re-hashes its frozen metadata, and exchanges it with two atomic renames; the switched state is persisted immediately after the exchange, before the paired `data-version.json` marker (program version and data version together) is written into the production data home with its prior bytes recorded first. At `verified` the run has executed the injected `--verify-command` (default: the installed bundle's own executable with `--version`; its output is read while the child runs, so a chatty verify command cannot block on a full pipe); exit 0 commits, and anything else rolls the transaction back: the installed Recovery entries return to their backup bytes (or are removed when they did not exist before), the prior marker is restored, the previous App is renamed back or copied from the backup, and the restored App is hash-asserted against the backup manifest before `rolled-back` is recorded. A rollback whose own undo fails — or whose restored App does not match the backup, or whose record cannot be persisted — ends in `needs-manual` with printed, readable steps; a lost rollback record is reported as such, never as a recorded `rolled-back`. A committed upgrade copies the candidate's Recovery entry Apps next to the production App unchanged, so the existing opt-in Recovery semantics stay available; the entry Apps keep their own sealing and recover the installation they were built for, and they are not data restore tools.

A record left in an intermediate state by a crash is reconciled on the next `upgrade`, `restore`, or explicit `resume` — always under the transaction lock: the side-effect ledger, and for records without one the replaced residue next to the production App, decides whether the switch already happened; a switched transaction rolls back from the recorded backup, an earlier one is cleaned up, and the pending operation is never started in the same run, so no side effect is ever repeated. `restore` runs the same machine in reverse direction: `--from-backup` re-verifies a paired backup's manifest and returns the production App to the backed-up version; `--from-last-good` re-hashes a `recovery-last-good.json` record and installs the App it names. Both create their own paired backup of the current state before switching, and both verify the restored App against the manifest.

Limitations: the digests detect accidental mismatch, not a same-user attacker who rewrites record and payload together. `data-version.json` is a metadata pairing; the transaction migrates no data, and the installed App still runs with the data home its frozen configuration records. Backups are never deleted by the transaction. The verify command is bounded in runtime (120 s default) and its output is informational only.
<a id="tests"></a>

## Tests

```sh
swift run --package-path deliverables/mac-launcher LauncherTests
swift run --package-path deliverables/mac-launcher RecoveryTests
swift run --package-path deliverables/mac-launcher UpgradeTests
zsh deliverables/mac-launcher/tests/run-build-tests.sh
node --test deliverables/mac-launcher/tests/freeze-runtime.test.mjs
```

`RecoveryTests` is a separate no-GUI runner for the recovery core. It covers last-good selection (valid record, corrupt and unsupported schema, over-size, hardlinked, and FIFO record metadata, traversal and symlink escapes, digest mismatch, missing bundle or data-home parts, inventories larger than 64 KiB, the over-32-MiB inventory refusal, sealed installation loading, and data-home containment: outside the installation, overlapping the selected App, `..` and symlinked components, and an accepted explicit nested release path), the recovery lease (in-process exclusion, release, missing and linked data homes), and the owned controller (launch and stop of a sealed launchable fixture, and independent-process lease contention that fails before any spawn). An explicit `swift run --package-path deliverables/mac-launcher RecoveryTests --fixture-install <existing directory>` builds a private fixture installation inside that directory and runs selection, full payload integrity validation, and a real owned `BackendController` launch and stop; fixtures only, no credentials. Fixtures are private temporary directories and clearly test-only; a fixture record is never a real last-good approval. The build-time refusals of `build-recovery.sh` (usage, relative or missing installation root, existing destination) are exercised against the real script; the full packaging flow needs a host that permits SwiftPM's manifest sandbox.

`UpgradeTests` is the no-GUI runner for the upgrade transaction. In private temporary directories it covers the binding rejections (identity digest mismatch, tampered bundle metadata, a trial record for another candidate, a foreign last-good record, installing the candidate onto itself — each refused before any file changes), the committed path (every state readable in the record history, the production App running the candidate bytes, the paired data-version marker, the installed Recovery entries, an independently re-verifiable backup manifest), the automatic rollback on a failing verify command, the interruption drill at `staged` and `switched` followed by a reconciling `resume`, restore from a paired backup and from a last-good record, and transaction-lock refusal in one process and across two real processes. The K3 review regressions cover the same rules from the failure side: a marker write that fails after the switch rolls the App back and records the side-effect ledger truthfully, `resume`/`upgrade` under a held lock (second handle in-process and a real second process) are refused without touching the in-progress transaction, a backup that fails midway leaves no half-built directory, a halfway Recovery entry installation is rolled back from the backup (restoring a pre-existing entry, removing a new one), a rollback whose record cannot be persisted reports needs-manual instead of a false `rolled-back`, and the `make-trial-record` bridge (happy path, malformed digest, existing destination, unknown source marker). The suite is self-sufficient on a clean `.build`: the `make-trial-record` assertions call `MakeTrialRecordCommand` in-process (`swift run UpgradeTests` builds only the test target and its library dependencies, never the `dsh-upgrade` executable), the real-CLI smoke runs when the `dsh-upgrade` binary was built and is recorded as an explicit skip with that reason when it is not, and `run-build-tests.sh` builds the `dsh-upgrade` product explicitly before its own CLI smoke. The `--hold-lock` holder mode and the drill's `stopAfter` option are test-only entry points; nothing in the shipped CLI runs a transaction without explicit arguments.

`LauncherTests` covers readiness parsing, redaction, authenticated probes, configuration and data-home overlap rules, frozen identity selection, owned-child lifecycle, and frozen integrity rejection. It binds temporary loopback listeners and spawns fixture children in private directories; use this executable, not `swift test`. The build suites do not launch a backend. The Node suite tests materialization with isolated build-tool fixtures; a passing fixture test is not a real-runtime trial.

For a separately built frozen candidate, run `swift run --package-path deliverables/mac-launcher LauncherTests --frozen-smoke-resources <absolute candidate Contents/Resources path>`. This opt-in smoke starts the real bundled backend, confirms authenticated readiness, stops it, and repeats using its recorded trial data home. It does not open a browser, send a model request, validate AppKit interaction, or test OS permission prompts. Separately trial the native window, browser, Cmd-Q, and reopening on an unlocked Mac.

For a separately packaged, isolated recovery installation with a test-only last-good record, run `swift run --package-path deliverables/mac-launcher RecoveryTests --last-good-smoke <absolute installation path>`. This uses the recorded real Node/runtime and trial home, checks authenticated readiness and exclusion of a competing frozen launcher, stops the owned backend, and repeats. It does not invoke the main App executable and does not validate native Recovery App interaction. Never point this test at production data.

The suite exercises the rejection paths (existing destination with a sentinel file, symlink destination, relative and nonexistent inputs, a missing or `bin.dsh`-less CLI manifest), verifies a failed SwiftPM build leaves no destination and no staging residue, compiles `publish-rename.c` and exercises the real publication operation — a fresh publish removes the staged bundle; an existing file, directory, and symlink survive with their sentinels and the directory gains no extra children; competing publishers produce exactly one winner — then runs hermetic builds with shimmed `swift` and `codesign` from the repository root and from an unrelated working directory with quoting-heavy paths, checking publication, staging cleanup, and verbatim `launcher-config.json` serialization, and finally builds a real candidate from the repository root and checks its identifier, display name, signature, macOS 13 target, and recorded configuration. Fixtures are private temporary directories; no test binds a port, writes credentials, or launches the installed App.

<a id="source-linked-limitation"></a>

## Source-linked limitation

The default source-linked candidate is not a frozen runtime. `Contents/Resources/launcher-config.json` records the absolute project directory, Node executable, and CLI entry, and the App runs `node <entry> web --no-open` from that checkout. Moving or deleting the checkout, moving Node, or removing the built `apps/cli/lib` breaks the candidate. Keep the recorded paths working wherever the bundle is opened.

<a id="identity-and-diagnostics"></a>

## Identity and diagnostics

The candidate uses bundle identifier `com.local.deepseek-harness-launcher.candidate` and display name `DeepSeek Harness (Candidate)`; the installed App keeps `com.local.deepseek-harness-launcher`. The diagnostic log name is derived from the bundle identifier, so the candidate writes to `~/Library/Logs/com.local.deepseek-harness-launcher.candidate.log` and never truncates the installed App's log.

<a id="isolated-trial"></a>

## Isolated trial

This procedure applies to source-linked mode. Building does not run the candidate. Trial it separately; do not open it normally in Finder during this procedure, because without an explicit `DSH_HOME` it uses the normal Harness data home. A separate data home does not isolate filesystem or network access, and `HOME` remains unchanged. Keep only one candidate running at a time: candidates share their identifier and log.

1. Build a candidate as above.
2. Create a fresh trial directory; do not copy existing settings, credentials, or sessions into it. Save the following as `cordis.patch.yml` inside it so the trial binds an OS-assigned loopback port.

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: 127.0.0.1
    port: 0
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
```

3. From a shell, launch the executable directly: `DSH_HOME=<absolute path to the fresh trial directory> "<output>/Contents/MacOS/DeepSeek Harness" &`. The child inherits the shell environment; remove model credentials from that environment if they are not intended for the trial. The installed App keeps running; the candidate does not replace or quit it.
4. Confirm the window reaches the running state and the browser opens the authenticated URL, then quit with Cmd-Q and confirm the backend child exits. Repeat the same launch to check reopening. This checks local startup and shutdown, not model access or permission prompts on a clean macOS account.

<a id="failure-behavior"></a>

## Failure behavior

A spawn failure, unreadable configuration, readiness timeout, or failed authenticated probe ends in the failure dialog. There is no automatic retry and no hidden recovery: quit and reopen the App to try again. Quitting the App or closing its window terminates the backend child it owns.
