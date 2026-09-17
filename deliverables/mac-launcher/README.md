# DeepSeek Harness macOS launcher

English | [中文](README.zh.md)

## Summary

This directory builds a macOS App candidate that owns the DeepSeek Harness Web backend lifecycle: it starts `dsh web --no-open`, waits for the readiness line, and opens the browser once the authenticated readiness probe passes. The default mode uses a source checkout; opt-in frozen mode carries its own Node and runtime. `build.sh` builds, signs, and verifies the candidate through SwiftPM. It never installs: the destination must not exist, and no installed App is ever replaced.

## Contents

- [Prerequisites](#prerequisites)
- [Build a candidate](#build-a-candidate)
- [Frozen candidate](#frozen-candidate)
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

<a id="tests"></a>

## Tests

```sh
swift run --package-path deliverables/mac-launcher LauncherTests
zsh deliverables/mac-launcher/tests/run-build-tests.sh
node --test deliverables/mac-launcher/tests/freeze-runtime.test.mjs
```

`LauncherTests` covers readiness parsing, redaction, authenticated probes, configuration, owned-child lifecycle, and frozen integrity rejection. It binds temporary loopback listeners and spawns fixture children in private directories; use this executable, not `swift test`. The build suites do not launch a backend. The Node suite tests materialization with isolated build-tool fixtures; a passing fixture test is not a real-runtime trial.

For a separately built frozen candidate, run `swift run --package-path deliverables/mac-launcher LauncherTests --frozen-smoke-resources <absolute candidate Contents/Resources path>`. This opt-in smoke starts the real bundled backend, confirms authenticated readiness, stops it, and repeats using its recorded trial data home. It does not open a browser, send a model request, validate AppKit interaction, or test OS permission prompts. Separately trial the native window, browser, Cmd-Q, and reopening on an unlocked Mac.

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
