# DeepSeek Harness macOS launcher

English | [中文](README.zh.md)

## Summary

This directory builds a macOS App candidate that owns the DeepSeek Harness Web backend lifecycle: it starts `dsh web --no-open` from a source checkout, waits for the readiness line, and opens the browser once the authenticated readiness probe passes. `build.sh` builds, signs, and verifies the candidate through SwiftPM. It never installs: the destination must not exist, and no installed App is ever replaced.

## Prerequisites

- macOS with Xcode Command Line Tools (`swift`, `xcrun`, `codesign`, and `/usr/libexec/PlistBuddy`).
- A Node executable, passed to `build.sh` as an absolute path.
- The DeepSeek Harness checkout the candidate will run, with `pnpm install && pnpm run build` completed so `apps/cli/lib/bin.js` exists.

## Build a candidate

```sh
zsh deliverables/mac-launcher/build.sh \
  --project-dir <absolute path to the dsh checkout> \
  --node <absolute path to node> \
  --output <absolute path to the new .app>
```

`--output` defaults to `deliverables/mac-launcher/.build/DeepSeek Harness (Candidate).app`; when the default is selected, `build.sh` creates that `.build` parent after validating the inputs, so a fresh checkout works and a rejected build leaves nothing behind. The script works from any working directory — SwiftPM always receives `--package-path` pointing at this directory — refuses a relative path, a nonexistent input, and an existing destination (including a symlink), and exits nonzero without touching the destination. It builds the `LauncherApp` product through SwiftPM, compiles against the macOS 13 deployment target that Package.swift declares, resolves the CLI entry only from `apps/cli/package.json`'s `bin.dsh`, and signs the bundle ad hoc with a designated requirement that pins the candidate identifier. Publication is an atomic no-replace rename: `build.sh` compiles `publish-rename.c` with the Command Line Tools into the private staging directory, and that helper moves the staged bundle with `renamex_np(RENAME_EXCL)`, which either publishes the bundle or changes nothing — a concurrent writer that creates the destination first fails the build and keeps the existing destination, and the helper is never shipped inside the bundle. If the host blocks SwiftPM's manifest sandbox, `build.sh` reports the restriction and exits nonzero; rerun it in a host context that permits `sandbox-exec` — the script never disables the sandbox or falls back to a weakened one.

## Tests

```sh
swift run --package-path deliverables/mac-launcher LauncherTests
zsh deliverables/mac-launcher/tests/run-build-tests.sh
```

`LauncherTests` covers readiness parsing, redaction, authenticated probes, configuration, and owned-child lifecycle. It binds temporary loopback listeners and spawns fixture children in private directories; use this executable, not `swift test`. The build suite below does not launch a backend.

The suite exercises the rejection paths (existing destination with a sentinel file, symlink destination, relative and nonexistent inputs, a missing or `bin.dsh`-less CLI manifest), verifies a failed SwiftPM build leaves no destination and no staging residue, compiles `publish-rename.c` and exercises the real publication operation — a fresh publish removes the staged bundle; an existing file, directory, and symlink survive with their sentinels and the directory gains no extra children; competing publishers produce exactly one winner — then runs hermetic builds with shimmed `swift` and `codesign` from the repository root and from an unrelated working directory with quoting-heavy paths, checking publication, staging cleanup, and verbatim `launcher-config.json` serialization, and finally builds a real candidate from the repository root and checks its identifier, display name, signature, macOS 13 target, and recorded configuration. Fixtures are private temporary directories; no test binds a port, writes credentials, or launches the installed App.

## Source-linked limitation

The candidate is not a frozen runtime. `Contents/Resources/launcher-config.json` records the absolute project directory, Node executable, and CLI entry, and the App runs `node <entry> web --no-open` from that checkout. Moving or deleting the checkout, moving Node, or removing the built `apps/cli/lib` breaks the candidate. Keep the recorded paths working wherever the bundle is opened.

## Identity and diagnostics

The candidate uses bundle identifier `com.local.deepseek-harness-launcher.candidate` and display name `DeepSeek Harness (Candidate)`; the installed App keeps `com.local.deepseek-harness-launcher`. The diagnostic log name is derived from the bundle identifier, so the candidate writes to `~/Library/Logs/com.local.deepseek-harness-launcher.candidate.log` and never truncates the installed App's log.

## Isolated trial

Building does not run the candidate. Trial it separately; do not open it normally in Finder during this procedure, because without an explicit `DSH_HOME` it uses the normal Harness data home. A separate data home does not isolate filesystem or network access, and `HOME` remains unchanged. Keep only one candidate running at a time: candidates share their identifier and log.

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

## Failure behavior

A spawn failure, unreadable configuration, readiness timeout, or failed authenticated probe ends in the failure dialog. There is no automatic retry and no hidden recovery: quit and reopen the App to try again. Quitting the App or closing its window terminates the backend child it owns.
